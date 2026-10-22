import { CommandError, type CommandContext, type CommandHandler } from "../shell.ts";
import { FsError, baseOf, encode, normalize, parentOf, type FileStat, type FileSystem } from "../fs.ts";
import { globRegExp } from "../text.ts";
import { eachInput, last, options } from "./util.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function failure(error: unknown): string {
  if (error instanceof FsError) {
    const text = { ENOENT: "No such file or directory", EEXIST: "File exists", ENOTDIR: "Not a directory", EISDIR: "Is a directory", ENOTEMPTY: "Directory not empty", EFBIG: "File too large" }[error.code];
    return text ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function mode(stat: FileStat): string {
  const bits = stat.mode;
  let text = stat.kind === "directory" ? "d" : "-";
  for (const shift of [6, 3, 0]) text += (bits >> shift & 4 ? "r" : "-") + (bits >> shift & 2 ? "w" : "-") + (bits >> shift & 1 ? "x" : "-");
  return text;
}

function human(size: number): string {
  if (size < 1024) return String(size);
  const units = ["K", "M", "G", "T"];
  let value = size;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return (value < 10 ? Math.ceil(value * 10) / 10 : Math.ceil(value)).toString() + units[unit];
}

function when(mtime: number): string {
  const date = new Date(mtime);
  const time = String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0");
  return MONTHS[date.getUTCMonth()] + " " + String(date.getUTCDate()).padStart(2, " ") + " " + time;
}

async function copyTree(fs: FileSystem, from: string, to: string) {
  const stat = await fs.stat(from);
  if (!stat) throw new FsError("ENOENT", from);
  if (stat.kind === "file") {
    await fs.write(to, await fs.read(from));
    return;
  }
  if (!(await fs.stat(to))) await fs.mkdir(to);
  for (const name of await fs.list(from)) await copyTree(fs, from + "/" + name, (to === "/" ? "" : to) + "/" + name);
}

async function removeTree(fs: FileSystem, path: string) {
  const stat = await fs.stat(path);
  if (stat?.kind === "directory") for (const name of await fs.list(path)) await removeTree(fs, (path === "/" ? "" : path) + "/" + name);
  await fs.remove(path);
}

export async function mkdirs(fs: FileSystem, path: string) {
  const parts = normalize(path).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    const stat = await fs.stat(current);
    if (!stat) await fs.mkdir(current);
    else if (stat.kind !== "directory") throw new FsError("ENOTDIR", current);
  }
}

function join(base: string, name: string): string {
  return base === "/" ? "/" + name : base + "/" + name;
}

const cat: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "nbsAEvTeu", long: { number: "n", "number-nonblank": "b", "squeeze-blank": "s", "show-ends": "E" } });
  let line = 0;
  return eachInput(ctx, parsed.operands, text => {
    if (!parsed.flags.has("n") && !parsed.flags.has("b") && !parsed.flags.has("E") && !parsed.flags.has("s")) {
      ctx.stdout.write(text);
      return;
    }
    const parts = text.split("\n");
    const trailing = parts[parts.length - 1] === "";
    if (trailing) parts.pop();
    let blank = false;
    const out: string[] = [];
    for (const part of parts) {
      if (parsed.flags.has("s") && part === "" && blank) continue;
      blank = part === "";
      const numbered = parsed.flags.has("b") ? part !== "" : parsed.flags.has("n");
      out.push((numbered ? String(++line).padStart(6) + "\t" : "") + part + (parsed.flags.has("E") ? "$" : ""));
    }
    ctx.stdout.write(out.join("\n") + (trailing ? "\n" : ""));
  });
};

const ls: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "laA1RdhtSrFp", long: { all: "a", "almost-all": "A", recursive: "R", directory: "d", "human-readable": "h", reverse: "r", classify: "F", color: "", "group-directories-first": "" } });
  const f = parsed.flags;
  const operands = parsed.operands.length ? parsed.operands : ["."];
  let status = 0;
  const files: { name: string; path: string; stat: FileStat }[] = [];
  const dirs: { name: string; path: string }[] = [];
  for (const operand of operands) {
    const path = ctx.resolve(operand);
    const stat = await ctx.fs.stat(path);
    if (!stat) {
      ctx.stderr.write("ls: cannot access '" + operand + "': No such file or directory\n");
      status = 2;
      continue;
    }
    if (stat.kind === "file" || f.has("d")) files.push({ name: operand, path, stat });
    else dirs.push({ name: operand, path });
  }
  const order = (entries: { name: string; stat: FileStat }[]) => {
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (f.has("t")) entries.sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (f.has("S")) entries.sort((a, b) => b.stat.size - a.stat.size);
    if (f.has("r")) entries.reverse();
    return entries;
  };
  const render = (entries: { name: string; stat: FileStat }[], total: boolean) => {
    const suffix = (entry: { stat: FileStat }) => ((f.has("F") || f.has("p")) && entry.stat.kind === "directory" ? "/" : "");
    if (!f.has("l")) {
      for (const entry of entries) ctx.stdout.write(entry.name + suffix(entry) + "\n");
      return;
    }
    const sizes = entries.map(entry => (f.has("h") ? human(entry.stat.size) : String(entry.stat.size)));
    const width = Math.max(0, ...sizes.map(size => size.length));
    if (total) ctx.stdout.write("total " + entries.reduce((sum, entry) => sum + Math.ceil(entry.stat.size / 1024) * (entry.stat.kind === "file" ? 1 : 0), 0) + "\n");
    entries.forEach((entry, index) => {
      ctx.stdout.write(mode(entry.stat) + " 1 user user " + sizes[index].padStart(width) + " " + when(entry.stat.mtime) + " " + entry.name + suffix(entry) + "\n");
    });
  };
  render(order(files), false);
  const visit = async (dir: { name: string; path: string }, header: boolean) => {
    if (header) ctx.stdout.write(dir.name + ":\n");
    const entries: { name: string; stat: FileStat; path: string }[] = [];
    if (f.has("a")) {
      entries.push({ name: ".", stat: (await ctx.fs.stat(dir.path))!, path: dir.path });
      entries.push({ name: "..", stat: (await ctx.fs.stat(parentOf(dir.path)))!, path: parentOf(dir.path) });
    }
    for (const name of await ctx.fs.list(dir.path)) {
      if (name.startsWith(".") && !f.has("a") && !f.has("A")) continue;
      const path = join(dir.path, name);
      const stat = await ctx.fs.stat(path);
      if (stat) entries.push({ name, stat, path });
    }
    render(order(entries), true);
    if (f.has("R")) {
      for (const entry of entries) {
        if (entry.stat.kind !== "directory" || entry.name === "." || entry.name === "..") continue;
        ctx.stdout.write("\n");
        await visit({ name: (dir.name === "/" ? "" : dir.name) + "/" + entry.name, path: entry.path }, true);
      }
    }
  };
  for (let i = 0; i < dirs.length; i++) {
    if (i > 0 || files.length) ctx.stdout.write("\n");
    await visit(dirs[i], operands.length > 1 || f.has("R"));
  }
  return status;
};

const mkdir: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "pv", values: "m", long: { parents: "p", verbose: "v", mode: "m" } });
  if (!parsed.operands.length) throw new CommandError("missing operand");
  let status = 0;
  for (const operand of parsed.operands) {
    const path = ctx.resolve(operand);
    try {
      if (parsed.flags.has("p")) await mkdirs(ctx.fs, path);
      else await ctx.fs.mkdir(path);
      if (parsed.flags.has("v")) ctx.stdout.write("mkdir: created directory '" + operand + "'\n");
    } catch (error) {
      ctx.stderr.write("mkdir: cannot create directory '" + operand + "': " + failure(error) + "\n");
      status = 1;
    }
  }
  return status;
};

const rm: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "rRfidv", long: { recursive: "r", force: "f", dir: "d", verbose: "v", "no-preserve-root": "" } });
  const recursive = parsed.flags.has("r") || parsed.flags.has("R");
  const force = parsed.flags.has("f");
  if (!parsed.operands.length && !force) throw new CommandError("missing operand");
  let status = 0;
  for (const operand of parsed.operands) {
    const path = ctx.resolve(operand);
    const stat = await ctx.fs.stat(path);
    if (!stat) {
      if (!force) {
        ctx.stderr.write("rm: cannot remove '" + operand + "': No such file or directory\n");
        status = 1;
      }
      continue;
    }
    if (path === "/") {
      ctx.stderr.write("rm: it is dangerous to operate recursively on '/'\n");
      status = 1;
      continue;
    }
    if (stat.kind === "directory" && !recursive && !(parsed.flags.has("d") && !(await ctx.fs.list(path)).length)) {
      ctx.stderr.write("rm: cannot remove '" + operand + "': Is a directory\n");
      status = 1;
      continue;
    }
    await removeTree(ctx.fs, path);
    if (parsed.flags.has("v")) ctx.stdout.write("removed '" + operand + "'\n");
  }
  return status;
};

const rmdir: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "p", long: { parents: "p", "ignore-fail-on-non-empty": "" } });
  let status = 0;
  for (const operand of parsed.operands) {
    try {
      const path = ctx.resolve(operand);
      const stat = await ctx.fs.stat(path);
      if (stat?.kind === "file") throw new FsError("ENOTDIR", operand);
      await ctx.fs.remove(path);
    } catch (error) {
      ctx.stderr.write("rmdir: failed to remove '" + operand + "': " + failure(error) + "\n");
      status = 1;
    }
  }
  return status;
};

async function transfer(ctx: CommandContext, move: boolean): Promise<number> {
  const parsed = options(ctx.args, { flags: "rRafinvpuT", values: "t", long: { recursive: "r", archive: "a", force: "f", "no-clobber": "n", verbose: "v", "target-directory": "t", "no-target-directory": "T" } });
  const name = move ? "mv" : "cp";
  const sources = [...parsed.operands];
  let target = last(parsed, "t");
  if (target === undefined) {
    if (sources.length < 2) throw new CommandError(sources.length ? "missing destination file operand after '" + sources[0] + "'" : "missing file operand");
    target = sources.pop()!;
  }
  const targetPath = ctx.resolve(target);
  const targetStat = await ctx.fs.stat(targetPath);
  const intoDirectory = targetStat?.kind === "directory" && !parsed.flags.has("T");
  if (sources.length > 1 && !intoDirectory) throw new CommandError("target '" + target + "' is not a directory");
  const recursive = parsed.flags.has("r") || parsed.flags.has("R") || parsed.flags.has("a");
  let status = 0;
  for (const source of sources) {
    const from = ctx.resolve(source);
    const stat = await ctx.fs.stat(from);
    if (!stat) {
      ctx.stderr.write(name + ": cannot stat '" + source + "': No such file or directory\n");
      status = 1;
      continue;
    }
    const to = intoDirectory ? join(targetPath, baseOf(from)) : targetPath;
    if (from === to) {
      ctx.stderr.write(name + ": '" + source + "' and '" + target + "' are the same file\n");
      status = 1;
      continue;
    }
    if (parsed.flags.has("n") && (await ctx.fs.stat(to))) continue;
    try {
      if (move) {
        const existing = await ctx.fs.stat(to);
        if (existing?.kind === "directory" && stat.kind === "directory") {
          if ((await ctx.fs.list(to)).length) throw new FsError("ENOTEMPTY", to);
          await ctx.fs.remove(to);
        } else if (existing && existing.kind !== stat.kind) throw new FsError(existing.kind === "directory" ? "EISDIR" : "ENOTDIR", target);
        await ctx.fs.rename(from, to);
      } else {
        if (stat.kind === "directory" && !recursive) {
          ctx.stderr.write("cp: -r not specified; omitting directory '" + source + "'\n");
          status = 1;
          continue;
        }
        if (stat.kind === "directory" && (to + "/").startsWith(from + "/")) throw new CommandError("cannot copy a directory, '" + source + "', into itself");
        await copyTree(ctx.fs, from, to);
      }
      if (parsed.flags.has("v")) ctx.stdout.write("'" + source + "' -> '" + to + "'\n");
    } catch (error) {
      if (error instanceof CommandError) throw error;
      ctx.stderr.write(name + ": cannot " + (move ? "move" : "copy") + " '" + source + "': " + failure(error) + "\n");
      status = 1;
    }
  }
  return status;
}

const touch: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "acm", values: "dtr", long: { "no-create": "c", date: "d" } });
  let status = 0;
  for (const operand of parsed.operands) {
    const path = ctx.resolve(operand);
    try {
      const stat = await ctx.fs.stat(path);
      if (stat?.kind === "directory") continue;
      if (!stat && parsed.flags.has("c")) continue;
      await ctx.fs.write(path, new Uint8Array(0), true);
    } catch (error) {
      ctx.stderr.write("touch: cannot touch '" + operand + "': " + failure(error) + "\n");
      status = 1;
    }
  }
  return status;
};

type FindNode = { kind: "and"; left: FindNode; right: FindNode } | { kind: "or"; left: FindNode; right: FindNode } | { kind: "not"; node: FindNode } | { kind: "test"; name: string; arg?: string; command?: string[]; batch?: boolean };

type FindEntry = { path: string; display: string; stat: FileStat; depth: number; name: string };

const find: CommandHandler = async ctx => {
  const args = ctx.args;
  const roots: string[] = [];
  let i = 0;
  while (i < args.length && !args[i].startsWith("-") && args[i] !== "!" && args[i] !== "(") roots.push(args[i++]);
  if (!roots.length) roots.push(".");
  let maxDepth = Infinity;
  let minDepth = 0;
  let printed = false;
  const tokens = args.slice(i);
  let pos = 0;
  const batches: { command: string[]; paths: string[] }[] = [];
  const primary = (): FindNode => {
    const token = tokens[pos++];
    if (token === undefined) throw new CommandError("expected an expression");
    if (token === "(") {
      const node = or();
      if (tokens[pos++] !== ")") throw new CommandError("missing ')'");
      return node;
    }
    if (token === "!" || token === "-not") return { kind: "not", node: primary() };
    if (token === "-maxdepth" || token === "-mindepth") {
      const value = Number(tokens[pos++]);
      if (token === "-maxdepth") maxDepth = value;
      else minDepth = value;
      return { kind: "test", name: "-true" };
    }
    if (token === "-exec" || token === "-execdir" || token === "-ok") {
      const command: string[] = [];
      while (pos < tokens.length && tokens[pos] !== ";" && tokens[pos] !== "+") command.push(tokens[pos++]);
      const batch = tokens[pos++] === "+";
      printed = true;
      return { kind: "test", name: "-exec", command, batch };
    }
    if (["-print", "-print0", "-delete", "-ls"].includes(token)) printed = true;
    if (["-name", "-iname", "-path", "-ipath", "-wholename", "-type", "-size", "-newer", "-regex", "-iregex", "-mtime", "-mmin", "-perm", "-user", "-group"].includes(token)) {
      const arg = tokens[pos++];
      if (arg === undefined) throw new CommandError("missing argument to `" + token + "'");
      return { kind: "test", name: token, arg };
    }
    if (["-print", "-print0", "-delete", "-true", "-false", "-empty", "-prune", "-quit", "-ls", "-depth", "-follow", "-xdev", "-readable", "-writable", "-executable"].includes(token)) return { kind: "test", name: token };
    throw new CommandError("unknown predicate `" + token + "'");
  };
  const and = (): FindNode => {
    let node = primary();
    while (pos < tokens.length && tokens[pos] !== "-o" && tokens[pos] !== "-or" && tokens[pos] !== ")") {
      if (tokens[pos] === "-a" || tokens[pos] === "-and") pos++;
      node = { kind: "and", left: node, right: primary() };
    }
    return node;
  };
  const or = (): FindNode => {
    let node = and();
    while (tokens[pos] === "-o" || tokens[pos] === "-or") {
      pos++;
      node = { kind: "or", left: node, right: and() };
    }
    return node;
  };
  const expression: FindNode = tokens.length ? or() : { kind: "test", name: "-true" };
  const root: FindNode = printed ? expression : { kind: "and", left: expression, right: { kind: "test", name: "-print" } };
  let status = 0;
  const deletions: string[] = [];
  const evaluate = async (node: FindNode, entry: FindEntry): Promise<boolean> => {
    if (node.kind === "and") return (await evaluate(node.left, entry)) && evaluate(node.right, entry);
    if (node.kind === "or") return (await evaluate(node.left, entry)) || evaluate(node.right, entry);
    if (node.kind === "not") return !(await evaluate(node.node, entry));
    const arg = node.arg ?? "";
    switch (node.name) {
      case "-true":
      case "-depth":
      case "-follow":
      case "-xdev":
      case "-readable":
      case "-writable":
        return true;
      case "-false":
        return false;
      case "-name":
        return globRegExp(arg).test(entry.name);
      case "-iname":
        return globRegExp(arg, "i").test(entry.name);
      case "-path":
      case "-wholename":
        return globRegExp(arg).test(entry.display);
      case "-ipath":
        return globRegExp(arg, "i").test(entry.display);
      case "-regex":
        return new RegExp("^(?:" + arg + ")$").test(entry.display);
      case "-iregex":
        return new RegExp("^(?:" + arg + ")$", "i").test(entry.display);
      case "-type":
        return arg.split(",").some(type => (type === "f" && entry.stat.kind === "file") || (type === "d" && entry.stat.kind === "directory"));
      case "-empty":
        return entry.stat.kind === "file" ? entry.stat.size === 0 : (await ctx.fs.list(entry.path)).length === 0;
      case "-executable":
        return (entry.stat.mode & 0o111) !== 0;
      case "-size": {
        const match = arg.match(/^([+-]?)(\d+)([ckMGb]?)$/);
        if (!match) throw new CommandError("invalid argument `" + arg + "' to `-size'");
        const unit = { c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3, b: 512, "": 512 }[match[3]]!;
        const size = Math.ceil(entry.stat.size / unit);
        const n = Number(match[2]);
        return match[1] === "+" ? size > n : match[1] === "-" ? size < n : size === n;
      }
      case "-mtime":
      case "-mmin": {
        const match = arg.match(/^([+-]?)(\d+)$/);
        if (!match) return false;
        const age = (Date.now() - entry.stat.mtime) / (node.name === "-mtime" ? 86400000 : 60000);
        const n = Number(match[2]);
        return match[1] === "+" ? age > n + (node.name === "-mtime" ? 1 : 0) : match[1] === "-" ? age < n : Math.floor(age) === n;
      }
      case "-newer": {
        const other = await ctx.fs.stat(ctx.resolve(arg));
        return other !== null && entry.stat.mtime > other.mtime;
      }
      case "-perm":
      case "-user":
      case "-group":
      case "-prune":
        return true;
      case "-print":
        ctx.stdout.write(entry.display + "\n");
        return true;
      case "-print0":
        ctx.stdout.write(entry.display + "\0");
        return true;
      case "-ls":
        ctx.stdout.write(mode(entry.stat) + " 1 user user " + entry.stat.size + " " + when(entry.stat.mtime) + " " + entry.display + "\n");
        return true;
      case "-delete":
        deletions.push(entry.path);
        return true;
      case "-quit":
        throw new FindQuit();
      case "-exec": {
        const command = node.command ?? [];
        if (node.batch) {
          let batch = batches.find(item => item.command === command);
          if (!batch) batches.push(batch = { command, paths: [] });
          batch.paths.push(entry.display);
          return true;
        }
        const argv = command.map(word => word.split("{}").join(entry.display));
        return (await ctx.run(argv, "")) === 0;
      }
    }
    return false;
  };
  const walk = async (entry: FindEntry) => {
    if (entry.depth >= minDepth) await evaluate(root, entry);
    if (entry.stat.kind !== "directory" || entry.depth >= maxDepth) return;
    for (const name of await ctx.fs.list(entry.path)) {
      const path = join(entry.path, name);
      const stat = await ctx.fs.stat(path);
      if (!stat) continue;
      await walk({ path, display: entry.display === "/" ? "/" + name : entry.display.replace(/\/$/, "") + "/" + name, stat, depth: entry.depth + 1, name });
    }
  };
  try {
    for (const root of roots) {
      const path = ctx.resolve(root);
      const stat = await ctx.fs.stat(path);
      if (!stat) {
        ctx.stderr.write("find: '" + root + "': No such file or directory\n");
        status = 1;
        continue;
      }
      await walk({ path, display: root, stat, depth: 0, name: baseOf(path) || "/" });
    }
  } catch (error) {
    if (!(error instanceof FindQuit)) throw error;
  }
  for (const batch of batches) {
    const index = batch.command.indexOf("{}");
    const argv = index < 0 ? [...batch.command, ...batch.paths] : [...batch.command.slice(0, index), ...batch.paths, ...batch.command.slice(index + 1)];
    if ((await ctx.run(argv, "")) !== 0) status = 1;
  }
  for (const path of deletions.sort((a, b) => b.length - a.length)) {
    try {
      await ctx.fs.remove(path);
    } catch (error) {
      ctx.stderr.write("find: cannot delete '" + path + "': " + failure(error) + "\n");
      status = 1;
    }
  }
  return status;
};

class FindQuit {}

const tee: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "ai", long: { append: "a" } });
  const text = ctx.stdin.read();
  ctx.stdout.write(text);
  let status = 0;
  for (const operand of parsed.operands) {
    try {
      await ctx.fs.write(ctx.resolve(operand), encode(text), parsed.flags.has("a"));
    } catch (error) {
      ctx.stderr.write("tee: " + operand + ": " + failure(error) + "\n");
      status = 1;
    }
  }
  return status;
};

const basename: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "az", values: "s", long: { multiple: "a", suffix: "s", zero: "z" } });
  const suffix = last(parsed, "s");
  const names = parsed.flags.has("a") || suffix !== undefined ? parsed.operands : parsed.operands.slice(0, 1);
  const strip = suffix ?? (parsed.flags.has("a") ? undefined : parsed.operands[1]);
  if (!names.length) throw new CommandError("missing operand");
  for (const name of names) {
    const trimmed = name.replace(/\/+$/, "") || "/";
    let base = trimmed === "/" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1);
    if (strip && base.endsWith(strip) && base !== strip) base = base.slice(0, -strip.length);
    ctx.stdout.write(base + "\n");
  }
  return 0;
};

const dirname: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "z" });
  if (!parsed.operands.length) throw new CommandError("missing operand");
  for (const name of parsed.operands) {
    const trimmed = name.replace(/\/+$/, "");
    if (!trimmed) ctx.stdout.write((name ? "/" : ".") + "\n");
    else {
      const index = trimmed.lastIndexOf("/");
      ctx.stdout.write((index < 0 ? "." : index === 0 ? "/" : trimmed.slice(0, index).replace(/\/+$/, "") || "/") + "\n");
    }
  }
  return 0;
};

const realpath: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "emsqfnz", long: { "canonicalize-existing": "e", "canonicalize-missing": "m" } });
  let status = 0;
  for (const operand of parsed.operands) {
    const path = ctx.resolve(operand);
    if (parsed.flags.has("e") && !(await ctx.fs.stat(path))) {
      ctx.stderr.write(ctx.name + ": " + operand + ": No such file or directory\n");
      status = 1;
      continue;
    }
    ctx.stdout.write(path + "\n");
  }
  return status;
};

const chmod: CommandHandler = async ctx => {
  const operands = ctx.args.filter(arg => !/^-[Rvcf]+$/.test(arg));
  let status = 0;
  for (const operand of operands.slice(1)) {
    if (!(await ctx.fs.stat(ctx.resolve(operand)))) {
      ctx.stderr.write("chmod: cannot access '" + operand + "': No such file or directory\n");
      status = 1;
    }
  }
  return status;
};

const mktemp: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "duqt", values: "p", long: { directory: "d", tmpdir: "p", "dry-run": "u", quiet: "q" } });
  const template = parsed.operands[0] ?? "tmp.XXXXXXXXXX";
  const dir = parsed.operands[0] && !parsed.flags.has("t") && last(parsed, "p") === undefined ? ctx.cwd : last(parsed, "p") ?? ctx.env.TMPDIR ?? "/tmp";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const name = template.replace(/X+$/, run => Array.from({ length: run.length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(""));
  const path = name.startsWith("/") ? name : ctx.resolve(dir + "/" + name);
  await mkdirs(ctx.fs, parentOf(path));
  if (!parsed.flags.has("u")) {
    if (parsed.flags.has("d")) await ctx.fs.mkdir(path);
    else await ctx.fs.write(path, new Uint8Array(0));
  }
  ctx.stdout.write(path + "\n");
  return 0;
};

const du: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "shacb", values: "d", long: { summarize: "s", "human-readable": "h", "max-depth": "d" } });
  const depth = parsed.flags.has("s") ? 0 : Number(last(parsed, "d") ?? Infinity);
  const show = (size: number) => (parsed.flags.has("h") ? human(size) : parsed.flags.has("b") ? String(size) : String(Math.ceil(size / 1024)));
  const walk = async (path: string, display: string, level: number): Promise<number> => {
    const stat = await ctx.fs.stat(path);
    if (!stat) throw new FsError("ENOENT", display);
    if (stat.kind === "file") {
      if (parsed.flags.has("a") && level <= depth) ctx.stdout.write(show(stat.size) + "\t" + display + "\n");
      return stat.size;
    }
    let total = 0;
    for (const name of await ctx.fs.list(path)) total += await walk(join(path, name), display.replace(/\/$/, "") + "/" + name, level + 1);
    if (level <= depth) ctx.stdout.write(show(total) + "\t" + display + "\n");
    return total;
  };
  for (const operand of parsed.operands.length ? parsed.operands : ["."]) await walk(ctx.resolve(operand), operand, 0);
  return 0;
};

const stat: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "L", values: "cf", long: { format: "c" } });
  const format = last(parsed, "c") ?? last(parsed, "f");
  let status = 0;
  for (const operand of parsed.operands) {
    const info = await ctx.fs.stat(ctx.resolve(operand));
    if (!info) {
      ctx.stderr.write("stat: cannot statx '" + operand + "': No such file or directory\n");
      status = 1;
      continue;
    }
    if (format) {
      ctx.stdout.write(format.replace(/%([snFYyAa%])/g, (_, c: string) => ({ s: String(info.size), n: operand, F: info.kind === "file" ? "regular file" : "directory", Y: String(Math.floor(info.mtime / 1000)), y: new Date(info.mtime).toISOString(), A: mode(info), a: (info.mode & 0o777).toString(8), "%": "%" })[c] ?? "") + "\n");
    } else ctx.stdout.write("  File: " + operand + "\n  Size: " + info.size + "\tType: " + (info.kind === "file" ? "regular file" : "directory") + "\nAccess: (" + (info.mode & 0o777).toString(8).padStart(4, "0") + "/" + mode(info) + ")\nModify: " + new Date(info.mtime).toISOString() + "\n");
  }
  return status;
};

export const fileCommands: Record<string, CommandHandler> = {
  cat,
  ls,
  mkdir,
  rm,
  rmdir,
  cp: ctx => transfer(ctx, false),
  mv: ctx => transfer(ctx, true),
  touch,
  find,
  tee,
  basename,
  dirname,
  realpath,
  readlink: realpath,
  chmod,
  mktemp,
  du,
  stat,
};

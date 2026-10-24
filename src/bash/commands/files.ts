import { CommandError, type CommandContext, type CommandHandler } from "../shell.ts";
import { FsError, baseOf, encode, normalize, parentOf, type FileStat, type FileSystem } from "../fs.ts";
import { globRegExp, posixRegExp } from "../text.ts";
import { strftime } from "./text.ts";
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
  const rounded = Math.ceil(value * 10) / 10;
  return (rounded < 10 ? rounded.toFixed(1) : String(Math.ceil(value))) + units[unit];
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

type FindTest = { kind: "test"; name: string; arg?: string; command?: string[]; batch?: boolean; regex?: RegExp };

type FindNode = { kind: "and"; left: FindNode; right: FindNode } | { kind: "or"; left: FindNode; right: FindNode } | { kind: "comma"; left: FindNode; right: FindNode } | { kind: "not"; node: FindNode } | FindTest;

type FindEntry = { path: string; display: string; stat: FileStat; depth: number; name: string; root: string; pruned: boolean };

const quote = (value: string) => (/^[\w@%+=:,.\/-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'");

function emacsRegExp(pattern: string): string {
  let out = "";
  let inBracket = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (inBracket) {
      out += c;
      if (c === "]") inBracket = false;
      continue;
    }
    if (c === "[") {
      inBracket = true;
      out += c;
      if (pattern[i + 1] === "^") out += pattern[++i];
      if (pattern[i + 1] === "]") out += pattern[++i];
      continue;
    }
    if (c === "\\" && i + 1 < pattern.length) {
      const n = pattern[++i];
      out += "(){}|".includes(n) ? n : "\\" + n;
      continue;
    }
    out += "(){}|".includes(c) ? "\\" + c : c;
  }
  return out;
}

function permBits(spec: string, base: number): number | undefined {
  if (/^[0-7]+$/.test(spec)) return parseInt(spec, 8);
  let mode = base;
  for (const clause of spec.split(",")) {
    const match = clause.match(/^([ugoa]*)([-+=])([rwxXst]*)$/);
    if (!match) return undefined;
    const who = match[1] === "" || match[1].includes("a") ? "ugo" : match[1];
    let bits = 0;
    for (const p of match[3]) bits |= p === "r" ? 4 : p === "w" ? 2 : p === "x" || p === "X" ? 1 : 0;
    let mask = 0;
    for (const w of who) mask |= bits << (w === "u" ? 6 : w === "g" ? 3 : 0);
    let clear = 0;
    for (const w of who) clear |= 7 << (w === "u" ? 6 : w === "g" ? 3 : 0);
    if (match[2] === "+") mode |= mask;
    else if (match[2] === "-") mode &= ~mask;
    else mode = (mode & ~clear) | mask;
  }
  return mode;
}

const FIND_ACTIONS = ["-delete", "-exec", "-execdir", "-fprint", "-fprint0", "-fprintf", "-ls", "-fls", "-ok", "-okdir", "-print", "-print0", "-printf"];
const FIND_UNARY = ["-delete", "-print", "-print0", "-true", "-false", "-empty", "-prune", "-quit", "-ls", "-readable", "-writable", "-executable", "-nouser", "-nogroup"];
const FIND_BINARY = ["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-type", "-xtype", "-size", "-newer", "-anewer", "-cnewer", "-regex", "-iregex", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-perm", "-user", "-group", "-uid", "-gid", "-links", "-inum", "-samefile", "-lname", "-ilname", "-printf", "-fprint", "-fprint0", "-used", "-newermt"];
const FIND_GLOBAL = ["-depth", "-d", "-follow", "-xdev", "-mount", "-noleaf", "-ignore_readdir_race", "-noignore_readdir_race", "-daystart", "-nowarn", "-warn"];

function findPrintf(spec: string, entry: FindEntry): string {
  const size = entry.stat.kind === "directory" ? 4096 : entry.stat.size;
  const blocks = entry.stat.kind === "directory" ? 4 : Math.ceil(entry.stat.size / 4096) * 4;
  const seconds = entry.stat.mtime / 1000;
  const date = new Date(entry.stat.mtime);
  const fraction = (entry.stat.mtime % 1000).toString().padStart(3, "0") + "0000000";
  const slash = entry.display.lastIndexOf("/");
  const values = (c: string): string | undefined => {
    switch (c) {
      case "p": return entry.display;
      case "f": return entry.depth === 0 ? entry.display.replace(/(.)\/+$/, "$1").replace(/^.*\/(?=.)/, "") : entry.name;
      case "h": return slash < 0 ? "." : slash === 0 ? "/" : entry.display.slice(0, slash);
      case "P": return entry.depth === 0 ? "" : entry.display.slice(entry.root.length).replace(/^\/+/, "");
      case "H": return entry.root;
      case "d": return String(entry.depth);
      case "y":
      case "Y": return entry.stat.kind === "directory" ? "d" : "f";
      case "m": return (entry.stat.mode & 0o7777).toString(8);
      case "M": return mode(entry.stat);
      case "s": return String(size);
      case "k": return String(blocks);
      case "b": return String(blocks * 2);
      case "u":
      case "g": return "user";
      case "U":
      case "G": return "1000";
      case "n": return "1";
      case "i": return "0";
      case "S": return "1";
      case "l": return "";
      case "%": return "%";
    }
    return undefined;
  };
  let out = "";
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === "\\" && i + 1 < spec.length) {
      const next = spec[i + 1];
      const octal = spec.slice(i + 1).match(/^[0-7]{1,3}/);
      if (octal) {
        out += String.fromCharCode(parseInt(octal[0], 8));
        i += octal[0].length;
        continue;
      }
      const simple: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", a: "\x07", b: "\b", f: "\f", r: "\r", v: "\v" };
      if (next === "c") break;
      out += simple[next] ?? "\\" + next;
      i++;
      continue;
    }
    if (c !== "%") {
      out += c;
      continue;
    }
    const match = spec.slice(i).match(/^%([-+ #0]*)(\d*)(?:\.(\d+))?([TAC][a-zA-Z@+]|[a-zA-Z%])/);
    if (!match) {
      out += c;
      continue;
    }
    i += match[0].length - 1;
    const directive = match[4];
    let value: string;
    if (/^[TAC]./.test(directive)) {
      const k = directive[1];
      value = k === "@" ? Math.floor(seconds) + "." + fraction : k === "+" ? strftime("%Y-%m-%d+%H:%M:%S", date) + "." + fraction : strftime("%" + k, date);
    } else if ("tac".includes(directive)) value = strftime("%a %b %e %H:%M:%S", date) + "." + fraction + strftime(" %Y", date);
    else value = values(directive) ?? match[0];
    if (match[3] !== undefined && !/^[dskb]$/.test(directive)) value = value.slice(0, Number(match[3]));
    const width = Number(match[2] || 0);
    if (value.length < width) value = match[1].includes("-") ? value.padEnd(width) : value.padStart(width, match[1].includes("0") && /^[dskb]$/.test(directive) ? "0" : " ");
    out += value;
  }
  return out;
}

const find: CommandHandler = async ctx => {
  const args = ctx.args;
  const roots: string[] = [];
  let i = 0;
  while (i < args.length && /^-[HLP]$/.test(args[i])) i++;
  if (args[i] === "--") i++;
  while (i < args.length && !(args[i].startsWith("-") && args[i].length > 1) && args[i] !== "!" && args[i] !== "(" && args[i] !== ")" && args[i] !== ",") roots.push(args[i++]);
  if (!roots.length) roots.push(".");
  let maxDepth = Infinity;
  let minDepth = 0;
  let depthFirst = false;
  let printed = false;
  let regexType = "emacs";
  const tokens = args.slice(i);
  let pos = 0;
  const batches = new Map<FindNode, { dir: string; paths: string[] }[]>();
  const primary = (): FindNode => {
    const token = tokens[pos++];
    if (token === undefined) throw new CommandError("expected an expression", 1);
    if (token === "(") {
      const node = comma();
      if (tokens[pos++] !== ")") throw new CommandError("invalid expression; I was expecting to find a ')' somewhere but did not see one.", 1);
      return node;
    }
    if (token === "!" || token === "-not") return { kind: "not", node: primary() };
    if (token === "-maxdepth" || token === "-mindepth") {
      const value = tokens[pos++];
      if (value === undefined || !/^\d+$/.test(value)) throw new CommandError("Expected a positive decimal integer argument to " + token + ", but got '" + (value ?? "") + "'", 1);
      if (token === "-maxdepth") maxDepth = Number(value);
      else minDepth = Number(value);
      return { kind: "test", name: "-true" };
    }
    if (token === "-regextype") {
      regexType = tokens[pos++] ?? "emacs";
      return { kind: "test", name: "-true" };
    }
    if (FIND_GLOBAL.includes(token)) {
      if (token === "-depth" || token === "-d") depthFirst = true;
      return { kind: "test", name: "-true" };
    }
    if (FIND_ACTIONS.includes(token)) printed = true;
    if (token === "-delete") depthFirst = true;
    if (token === "-exec" || token === "-execdir" || token === "-ok" || token === "-okdir") {
      const command: string[] = [];
      while (pos < tokens.length && tokens[pos] !== ";" && !(tokens[pos] === "+" && command[command.length - 1] === "{}")) command.push(tokens[pos++]);
      if (pos >= tokens.length) throw new CommandError("missing argument to '" + token + "'", 1);
      if (!command.length) throw new CommandError("invalid argument '" + tokens[pos] + "' to '" + token + "'", 1);
      const batch = tokens[pos++] === "+";
      return { kind: "test", name: token.startsWith("-exec") ? token : token === "-ok" ? "-exec" : "-execdir", command, batch };
    }
    if (FIND_BINARY.includes(token)) {
      const arg = tokens[pos++];
      if (arg === undefined) throw new CommandError("missing argument to '" + token + "'", 1);
      if (token === "-regex" || token === "-iregex") {
        let source: string;
        try {
          source = regexType === "emacs" || regexType === "posix-basic" ? posixRegExp(regexType === "emacs" ? emacsRegExp(arg) : arg, regexType === "emacs").source : posixRegExp(arg, true).source;
        } catch {
          source = arg;
        }
        return { kind: "test", name: token, arg, regex: new RegExp("^(?:" + source + ")$", token === "-iregex" ? "s" + "i" : "s") };
      }
      if (token === "-type" && !/^[fdlbcps](,[fdlbcps])*$/.test(arg)) throw new CommandError("Unknown argument to -type: " + arg, 1);
      if (token === "-size" && !/^[+-]?\d+[cwbkMG]?$/.test(arg)) throw new CommandError("invalid -size type '" + arg.replace(/^[+-]?\d+/, "") + "'", 1);
      if (/^-[acm](time|min)$/.test(token) && !/^[+-]?\d+(\.\d+)?$/.test(arg)) throw new CommandError("invalid argument '" + arg + "' to '" + token + "'", 1);
      return { kind: "test", name: token, arg };
    }
    if (FIND_UNARY.includes(token)) return { kind: "test", name: token };
    if (token.startsWith("-")) throw new CommandError("unknown predicate '" + token + "'", 1);
    throw new CommandError("paths must precede expression: '" + token + "'", 1);
  };
  const and = (): FindNode => {
    let node = primary();
    while (pos < tokens.length && tokens[pos] !== "-o" && tokens[pos] !== "-or" && tokens[pos] !== ")" && tokens[pos] !== ",") {
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
  const comma = (): FindNode => {
    let node = or();
    while (tokens[pos] === ",") {
      pos++;
      node = { kind: "comma", left: node, right: or() };
    }
    return node;
  };
  const expression: FindNode = tokens.length ? comma() : { kind: "test", name: "-true" };
  if (pos < tokens.length) throw new CommandError(tokens[pos] === ")" ? "invalid expression; you have too many ')'" : "paths must precede expression: '" + tokens[pos] + "'", 1);
  const root: FindNode = printed ? expression : { kind: "and", left: expression, right: { kind: "test", name: "-print" } };
  let status = 0;
  const now = Date.now();
  const refs = new Map<string, FileStat | null>();
  const reference = async (arg: string) => {
    if (!refs.has(arg)) refs.set(arg, await ctx.fs.stat(ctx.resolve(arg)));
    const stat = refs.get(arg);
    if (!stat) throw new CommandError("'" + arg + "': No such file or directory", 1);
    return stat;
  };
  const run = async (argv: string[], dir?: string): Promise<number> => {
    if (dir === undefined) return ctx.run(argv, "");
    const result = await ctx.exec("cd " + quote(dir) + " && " + argv.map(quote).join(" "));
    ctx.stdout.write(result.stdout);
    return result.status;
  };
  const evaluate = async (node: FindNode, entry: FindEntry): Promise<boolean> => {
    if (node.kind === "and" || node.kind === "or" || node.kind === "comma") {
      const left = await evaluate(node.left, entry);
      if (node.kind === "and" && !left) return false;
      if (node.kind === "or" && left) return true;
      return evaluate(node.right, entry);
    }
    if (node.kind === "not") return !(await evaluate(node.node, entry));
    const arg = node.arg ?? "";
    switch (node.name) {
      case "-true":
      case "-readable":
      case "-writable":
        return true;
      case "-false":
      case "-nouser":
      case "-nogroup":
      case "-lname":
      case "-ilname":
        return false;
      case "-name":
        return globRegExp(arg).test(entry.name);
      case "-iname":
        return globRegExp(arg, "i").test(entry.name);
      case "-path":
      case "-wholename":
        return globRegExp(arg).test(entry.display);
      case "-ipath":
      case "-iwholename":
        return globRegExp(arg, "i").test(entry.display);
      case "-regex":
      case "-iregex":
        return node.regex!.test(entry.display);
      case "-type":
      case "-xtype":
        return arg.split(",").some(type => (type === "f" && entry.stat.kind === "file") || (type === "d" && entry.stat.kind === "directory"));
      case "-empty":
        return entry.stat.kind === "file" ? entry.stat.size === 0 : (await ctx.fs.list(entry.path)).length === 0;
      case "-executable":
        return (entry.stat.mode & 0o111) !== 0;
      case "-size": {
        const match = arg.match(/^([+-]?)(\d+)([cwbkMG]?)$/)!;
        const unit = { c: 1, w: 2, k: 1024, M: 1024 ** 2, G: 1024 ** 3, b: 512, "": 512 }[match[3]]!;
        const size = Math.ceil((entry.stat.kind === "directory" ? 4096 : entry.stat.size) / unit);
        const n = Number(match[2]);
        return match[1] === "+" ? size > n : match[1] === "-" ? size < n : size === n;
      }
      case "-mtime":
      case "-atime":
      case "-ctime":
      case "-mmin":
      case "-amin":
      case "-cmin": {
        const match = arg.match(/^([+-]?)(\d+(?:\.\d+)?)$/)!;
        const minutes = node.name.endsWith("min");
        const age = (now - entry.stat.mtime) / (minutes ? 60000 : 86400000);
        const n = Number(match[2]);
        const value = minutes ? Math.ceil(age) : Math.floor(age);
        return match[1] === "+" ? value > n : match[1] === "-" ? (minutes ? age < n : value < n) : value === n;
      }
      case "-newer":
      case "-anewer":
      case "-cnewer":
        return entry.stat.mtime > (await reference(arg)).mtime;
      case "-newermt": {
        const time = Date.parse(arg);
        if (Number.isNaN(time)) throw new CommandError("I cannot figure out how to interpret '" + arg + "' as a date or time", 1);
        return entry.stat.mtime > time;
      }
      case "-samefile":
        return entry.path === ctx.resolve(arg);
      case "-perm": {
        const prefix = /^[-\/+]/.test(arg) ? arg[0] : "";
        const bits = permBits(prefix ? arg.slice(1) : arg, 0);
        if (bits === undefined) throw new CommandError("invalid mode '" + arg + "'", 1);
        const actual = entry.stat.mode & 0o7777;
        return prefix === "-" ? (actual & bits) === bits : prefix ? bits === 0 || (actual & bits) !== 0 : actual === bits;
      }
      case "-user":
      case "-group":
        return arg === "user" || arg === ctx.env.USER || arg === "1000";
      case "-uid":
      case "-gid":
        return arg === "1000";
      case "-links":
        return /^[-+]?\d+$/.test(arg) ? (arg.startsWith("+") ? 1 > Number(arg.slice(1)) : arg.startsWith("-") ? 1 < Number(arg.slice(1)) : Number(arg) === 1) : false;
      case "-inum":
      case "-used":
        return false;
      case "-prune":
        if (!depthFirst) entry.pruned = true;
        return true;
      case "-print":
        ctx.stdout.write(entry.display + "\n");
        return true;
      case "-print0":
        ctx.stdout.write(entry.display + "\0");
        return true;
      case "-printf":
        ctx.stdout.write(findPrintf(arg, entry));
        return true;
      case "-fprint":
      case "-fprint0":
        await ctx.fs.write(ctx.resolve(arg), encode(entry.display + (node.name === "-fprint0" ? "\0" : "\n")), true);
        return true;
      case "-ls":
        ctx.stdout.write("      0      " + (entry.stat.kind === "directory" ? 4 : Math.ceil(entry.stat.size / 4096) * 4) + " " + mode(entry.stat) + "   1 user     user     " + String(entry.stat.kind === "directory" ? 4096 : entry.stat.size).padStart(8) + " " + when(entry.stat.mtime) + " " + entry.display + "\n");
        return true;
      case "-delete":
        try {
          if (entry.stat.kind === "directory" && (await ctx.fs.list(entry.path)).length) throw new FsError("ENOTEMPTY", entry.path);
          if (entry.depth === 0 && entry.display === ".") return true;
          await ctx.fs.remove(entry.path);
          return true;
        } catch (error) {
          ctx.stderr.write("find: cannot delete '" + entry.display + "': " + failure(error) + "\n");
          status = 1;
          return false;
        }
      case "-quit":
        throw new FindQuit();
      case "-exec":
      case "-execdir": {
        const command = node.command ?? [];
        const dir = node.name === "-execdir" ? (entry.depth === 0 && entry.path !== "/" ? parentOf(entry.path) : parentOf(entry.path)) : undefined;
        const target = node.name === "-execdir" ? (entry.path === "/" ? "/" : "./" + baseOf(entry.path)) : entry.display;
        if (node.batch) {
          const list = batches.get(node) ?? [];
          batches.set(node, list);
          let batch = list.find(item => item.dir === (dir ?? ""));
          if (!batch) list.push((batch = { dir: dir ?? "", paths: [] }));
          batch.paths.push(target);
          return true;
        }
        return (await run(command.map(word => word.split("{}").join(target)), dir)) === 0;
      }
    }
    return false;
  };
  const walk = async (entry: FindEntry) => {
    if (!depthFirst && entry.depth >= minDepth) await evaluate(root, entry);
    if (entry.stat.kind === "directory" && entry.depth < maxDepth && !entry.pruned) {
      let names: string[] = [];
      try {
        names = await ctx.fs.list(entry.path);
      } catch (error) {
        ctx.stderr.write("find: '" + entry.display + "': " + failure(error) + "\n");
        status = 1;
      }
      for (const name of names) {
        const path = join(entry.path, name);
        const stat = await ctx.fs.stat(path);
        if (!stat) continue;
        await walk({ path, display: entry.display.endsWith("/") ? entry.display + name : entry.display + "/" + name, stat, depth: entry.depth + 1, name, root: entry.root, pruned: false });
      }
    }
    if (depthFirst && entry.depth >= minDepth) await evaluate(root, entry);
  };
  try {
    for (const start of roots) {
      const path = ctx.resolve(start);
      const stat = await ctx.fs.stat(path);
      if (!stat) {
        ctx.stderr.write("find: '" + start + "': No such file or directory\n");
        status = 1;
        continue;
      }
      const trimmed = start.replace(/(.)\/+$/, "$1");
      await walk({ path, display: start, stat, depth: 0, name: trimmed === "/" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1), root: start, pruned: false });
    }
  } catch (error) {
    if (!(error instanceof FindQuit)) throw error;
  }
  for (const [node, list] of batches) {
    if (node.kind !== "test") continue;
    const command = node.command ?? [];
    const index = command.lastIndexOf("{}");
    for (const batch of list) {
      const argv = [...command.slice(0, index), ...batch.paths, ...command.slice(index + 1)];
      if ((await run(argv, node.name === "-execdir" ? batch.dir : undefined)) !== 0) status = 1;
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
  const parsed = options(ctx.args, { flags: "shacbkmxLlS0", values: "dBt", long: { summarize: "s", "human-readable": "h", all: "a", total: "c", bytes: "b", "apparent-size": "A", "max-depth": "d", "block-size": "B", threshold: "t", "one-file-system": "x", "dereference": "L", "count-links": "l", "separate-dirs": "S", null: "0", si: "H", exclude: "exclude" } });
  const f = parsed.flags;
  const apparent = f.has("A") || f.has("b");
  const depth = f.has("s") ? 0 : Number(last(parsed, "d") ?? Infinity);
  const blockSize = (() => {
    const spec = last(parsed, "B");
    if (spec === undefined) return f.has("b") ? 1 : f.has("m") ? 1024 * 1024 : 1024;
    const match = spec.match(/^(\d*)([KMG]?)(i?B?)$/i);
    if (!match) throw new CommandError("invalid -B argument '" + spec + "'");
    return Number(match[1] || 1) * 1024 ** " KMG".indexOf((match[2] || " ").toUpperCase());
  })();
  const excludes = (parsed.values.get("exclude") ?? []).map(glob => globRegExp(glob));
  const show = (bytes: number) => {
    if (f.has("h")) return bytes === 0 ? "0" : human(bytes);
    return String(Math.ceil(bytes / blockSize));
  };
  const usage = (stat: FileStat) => (apparent ? (stat.kind === "file" ? stat.size : 0) : stat.kind === "directory" ? 4096 : Math.ceil(stat.size / 4096) * 4096);
  const terminator = f.has("0") ? "\0" : "\n";
  let status = 0;
  let total = 0;
  const walk = async (path: string, display: string, level: number): Promise<number> => {
    const stat = await ctx.fs.stat(path);
    if (!stat) throw new FsError("ENOENT", display);
    if (stat.kind === "file") {
      const size = usage(stat);
      if ((level === 0 || f.has("a")) && level <= depth) ctx.stdout.write(show(size) + "\t" + display + terminator);
      return size;
    }
    let sum = usage(stat);
    for (const name of await ctx.fs.list(path)) {
      if (excludes.some(glob => glob.test(name))) continue;
      const child = await walk(join(path, name), display.endsWith("/") ? display + name : display + "/" + name, level + 1);
      const childStat = await ctx.fs.stat(join(path, name));
      if (!f.has("S") || childStat?.kind === "file") sum += child;
    }
    if (level <= depth) ctx.stdout.write(show(sum) + "\t" + display + terminator);
    return sum;
  };
  for (const operand of parsed.operands.length ? parsed.operands : ["."]) {
    try {
      total += await walk(ctx.resolve(operand), operand, 0);
    } catch (error) {
      ctx.stderr.write("du: cannot access '" + operand + "': " + failure(error) + "\n");
      status = 1;
    }
  }
  if (f.has("c")) ctx.stdout.write(show(total) + "\ttotal" + terminator);
  return status;
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

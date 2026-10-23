import { CommandError, type CommandContext, type CommandHandler } from "../shell.ts";
import { baseOf, decode, encode, FsError, parentOf } from "../fs.ts";
import { allInput, eachInput, last, options } from "./util.ts";
import { mkdirs } from "./files.ts";
import { gunzip, gzip, pack, unpack, type TarEntry } from "./archive.ts";

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

async function bytesOf(ctx: CommandContext, operand: string): Promise<Uint8Array> {
  return operand === "-" ? encode(ctx.stdin.read()) : await ctx.fs.read(ctx.resolve(operand));
}

function compressor(mode: "gzip" | "gunzip" | "zcat"): CommandHandler {
  return async ctx => {
    const parsed = options(ctx.args, { flags: "cdfkqv123456789", long: { stdout: "c", decompress: "d", force: "f", keep: "k" } });
    const decompress = mode !== "gzip" || parsed.flags.has("d");
    const stdout = mode === "zcat" || parsed.flags.has("c");
    let status = 0;
    for (const operand of parsed.operands.length ? parsed.operands : ["-"]) {
      try {
        const input = await bytesOf(ctx, operand);
        const output = decompress ? await gunzip(input) : await gzip(input);
        if (stdout || operand === "-") {
          ctx.stdout.write(decode(output));
          continue;
        }
        const path = ctx.resolve(operand);
        if (decompress && !path.endsWith(".gz")) throw new CommandError(operand + ": unknown suffix -- ignored");
        await ctx.fs.write(decompress ? path.slice(0, -3) : path + ".gz", output);
        if (!parsed.flags.has("k")) await ctx.fs.remove(path);
      } catch (error) {
        if (error instanceof CommandError) throw error;
        ctx.stderr.write(ctx.name + ": " + operand + ": " + (error instanceof FsError && error.code === "ENOENT" ? "No such file or directory" : "not in gzip format") + "\n");
        status = 1;
      }
    }
    return status;
  };
}

async function collect(ctx: CommandContext, root: string, operand: string, entries: TarEntry[]): Promise<void> {
  const path = ctx.resolve(root === "." ? operand : root + "/" + operand);
  const stat = await ctx.fs.stat(path);
  if (!stat) throw new CommandError(operand + ": Cannot stat: No such file or directory");
  const name = operand.replace(/^\.\//, "").replace(/\/+$/, "");
  if (stat.kind === "file") {
    entries.push({ name, type: "file", data: await ctx.fs.read(path), mode: stat.mode, mtime: stat.mtime, linkname: "" });
    return;
  }
  entries.push({ name, type: "directory", data: new Uint8Array(), mode: stat.mode, mtime: stat.mtime, linkname: "" });
  for (const child of await ctx.fs.list(path)) await collect(ctx, root, name + "/" + child, entries);
}

const cmp: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "bls", long: { "print-bytes": "b", quiet: "s", silent: "s", verbose: "l" } });
  const [left, right = "-"] = parsed.operands;
  if (left === undefined) throw new CommandError("missing operand after 'cmp'", 2);
  const read = async (operand: string) => {
    try {
      return await bytesOf(ctx, operand);
    } catch (error) {
      if (error instanceof FsError) throw new CommandError(operand + ": " + (error.code === "ENOENT" ? "No such file or directory" : error.message), 2);
      throw error;
    }
  };
  const a = await read(left);
  const b = await read(right);
  const length = Math.min(a.length, b.length);
  const quiet = parsed.flags.has("s");
  let line = 1;
  let differ = false;
  for (let i = 0; i < length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y) {
      differ = true;
      if (parsed.flags.has("l")) {
        ctx.stdout.write(String(i + 1).padStart(String(length).length) + " " + x.toString(8).padStart(3) + " " + y.toString(8).padStart(3) + "\n");
        continue;
      }
      if (!quiet) ctx.stdout.write(left + " " + right + " differ: byte " + (i + 1) + ", line " + line + "\n");
      return 1;
    }
    if (x === 10) line++;
  }
  if (a.length !== b.length) {
    const shorter = a.length < b.length ? left : right;
    if (!quiet) ctx.stderr.write("cmp: EOF on " + shorter + (length ? " after byte " + length + ", line " + line : " which is empty") + "\n");
    return 1;
  }
  return differ ? 1 : 0;
};

const tar: CommandHandler = async ctx => {
  const args = ctx.args.slice();
  if (args[0] && !args[0].startsWith("-")) args[0] = "-" + args[0];
  const parsed = options(args, { flags: "ctxzvhp", values: "fC", long: { create: "c", extract: "x", list: "t", gzip: "z", verbose: "v", file: "f", directory: "C" } });
  const mode = ["c", "x", "t"].filter(flag => parsed.flags.has(flag));
  if (mode.length !== 1) throw new CommandError("You must specify one of the '-c', '-x' or '-t' options", 2);
  const file = last(parsed, "f");
  const root = last(parsed, "C") ?? ".";
  const zipped = parsed.flags.has("z") || /\.(tgz|tar\.gz)$/.test(file ?? "");
  if (mode[0] === "c") {
    if (!file) throw new CommandError("refusing to write archive data to the output; use -f", 2);
    if (!parsed.operands.length) throw new CommandError("Cowardly refusing to create an empty archive", 2);
    const entries: TarEntry[] = [];
    for (const operand of parsed.operands) await collect(ctx, root, operand, entries);
    if (parsed.flags.has("v")) for (const entry of entries) (file === "-" ? ctx.stderr : ctx.stdout).write(entry.name + (entry.type === "directory" ? "/" : "") + "\n");
    const archive = zipped ? await gzip(pack(entries)) : pack(entries);
    if (file === "-") ctx.stdout.write(decode(archive));
    else await ctx.fs.write(ctx.resolve(file), archive);
    return 0;
  }
  const raw = file && file !== "-" ? await ctx.fs.read(ctx.resolve(file)) : encode(ctx.stdin.read());
  const entries = unpack(zipped || (raw[0] === 0x1f && raw[1] === 0x8b) ? await gunzip(raw) : raw);
  const wanted = parsed.operands.map(operand => operand.replace(/\/+$/, ""));
  const selected = entries.filter(entry => (entry.type === "file" || entry.type === "directory") && (!wanted.length || wanted.some(name => entry.name === name || entry.name.startsWith(name + "/"))));
  for (const entry of selected) {
    if (mode[0] === "t" || parsed.flags.has("v")) ctx.stdout.write(entry.name + (entry.type === "directory" ? "/" : "") + "\n");
    if (mode[0] !== "x") continue;
    const target = ctx.resolve((root === "." ? "" : root + "/") + entry.name);
    if (entry.type === "directory") await mkdirs(ctx.fs, target);
    else {
      await mkdirs(ctx.fs, parentOf(target));
      await ctx.fs.write(target, entry.data);
    }
  }
  return 0;
};

function md5(data: Uint8Array): string {
  const k = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const r = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const length = data.length;
  const padded = new Uint8Array(((length + 72) >> 6) << 6);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(length / 2 ** 29), true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < padded.length; offset += 64) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const next = d;
      d = c;
      c = b;
      const sum = (a + f + k[i] + view.getUint32(offset + g * 4, true)) >>> 0;
      b = (b + ((sum << r[i]) | (sum >>> (32 - r[i])))) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map(word => [0, 8, 16, 24].map(shift => ((word >>> shift) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}

const md5sum: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "bt" });
  let status = 0;
  for (const operand of parsed.operands.length ? parsed.operands : ["-"]) {
    try {
      ctx.stdout.write(md5(await bytesOf(ctx, operand)) + "  " + operand + "\n");
    } catch {
      ctx.stderr.write("md5sum: " + operand + ": No such file or directory\n");
      status = 1;
    }
  }
  return status;
};

const tree: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "adf", values: "L" });
  const depth = Number(last(parsed, "L") ?? Infinity);
  let directories = 0;
  let files = 0;
  const walk = async (path: string, prefix: string, level: number) => {
    if (level > depth) return;
    const names = (await ctx.fs.list(path)).filter(name => parsed.flags.has("a") || !name.startsWith("."));
    const children: { name: string; directory: boolean }[] = [];
    for (const name of names) {
      const stat = await ctx.fs.stat(path === "/" ? "/" + name : path + "/" + name);
      if (stat && (stat.kind === "directory" || !parsed.flags.has("d"))) children.push({ name, directory: stat.kind === "directory" });
    }
    for (const [index, child] of children.entries()) {
      const end = index === children.length - 1;
      ctx.stdout.write(prefix + (end ? "└── " : "├── ") + child.name + "\n");
      if (child.directory) {
        directories++;
        await walk(path === "/" ? "/" + child.name : path + "/" + child.name, prefix + (end ? "    " : "│   "), level + 1);
      } else files++;
    }
  };
  for (const operand of parsed.operands.length ? parsed.operands : ["."]) {
    const path = ctx.resolve(operand);
    const stat = await ctx.fs.stat(path);
    if (!stat || stat.kind !== "directory") {
      ctx.stderr.write(operand + " [error opening dir]\n");
      continue;
    }
    ctx.stdout.write(operand + "\n");
    await walk(path, "", 1);
  }
  ctx.stdout.write("\n" + directories + " director" + (directories === 1 ? "y" : "ies") + (parsed.flags.has("d") ? "" : ", " + files + " file" + (files === 1 ? "" : "s")) + "\n");
};

const which: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "as" });
  let status = 0;
  for (const name of parsed.operands) {
    const found = await ctx.exec("type -t " + quote(name));
    const kind = found.stdout.trim();
    if (found.status !== 0 || !kind || kind === "function" || kind === "alias") {
      status = 1;
      continue;
    }
    if (!parsed.flags.has("s")) ctx.stdout.write((kind === "builtin" ? name + ": shell built-in command" : "/usr/bin/" + name) + "\n");
  }
  return status;
};

const env: CommandHandler = async ctx => {
  const args = ctx.args.slice();
  let clear = false;
  const assignments: string[] = [];
  while (args.length) {
    if (args[0] === "-i" || args[0] === "-") { clear = true; args.shift(); }
    else if (args[0] === "-u" && args[1]) { assignments.push("unset " + quote(args[1]) + ";"); args.splice(0, 2); }
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) assignments.push("export " + quote(args.shift()!) + ";");
    else break;
  }
  if (!args.length) {
    const vars = clear ? {} : { ...ctx.env };
    for (const assignment of assignments) {
      const match = /^export '([^=]*)=(.*)';$/s.exec(assignment);
      if (match) vars[match[1]] = match[2].replace(/'\\''/g, "'");
    }
    for (const [name, value] of Object.entries(vars).sort()) ctx.stdout.write(name + "=" + value + "\n");
    return 0;
  }
  const result = await ctx.exec("(" + assignments.join(" ") + " " + args.map(quote).join(" ") + ")", ctx.stdin.read());
  ctx.stdout.write(result.stdout);
  return result.status;
};

const time: CommandHandler = async ctx => {
  const started = performance.now();
  const status = ctx.args.length ? await ctx.run(ctx.args) : 0;
  const seconds = (performance.now() - started) / 1000;
  ctx.stderr.write("\nreal\t0m" + seconds.toFixed(3) + "s\nuser\t0m0.000s\nsys\t0m0.000s\n");
  return status;
};

const timeout: CommandHandler = async ctx => {
  const args = ctx.args.filter((arg, index) => index > 0 || !arg.startsWith("-"));
  const [limit, ...command] = args.filter(arg => !/^-(s|k|-signal|-kill-after)/.test(arg));
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(limit ?? "");
  if (!match || !command.length) throw new CommandError("usage: timeout DURATION COMMAND [ARG]...", 125);
  const ms = Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? "s"] ?? 1) * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<number>(resolve => { timer = setTimeout(() => resolve(124), ms); });
  try {
    return await Promise.race([ctx.run(command), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const yes: CommandHandler = ctx => {
  const line = (ctx.args.length ? ctx.args.join(" ") : "y") + "\n";
  const count = Math.max(1, Math.min(10_000, Math.floor(ctx.limits.maxOutputLength / line.length) - 1));
  ctx.stdout.write(line.repeat(count));
};

const strings: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "a", values: "n", numeric: true });
  const min = Number(last(parsed, "n") ?? 4);
  let status = 0;
  for (const operand of parsed.operands.length ? parsed.operands : ["-"]) {
    try {
      const data = await bytesOf(ctx, operand);
      let run = "";
      for (const byte of data) {
        if (byte >= 0x20 && byte < 0x7f || byte === 0x09) run += String.fromCharCode(byte);
        else {
          if (run.length >= min) ctx.stdout.write(run + "\n");
          run = "";
        }
      }
      if (run.length >= min) ctx.stdout.write(run + "\n");
    } catch {
      ctx.stderr.write("strings: " + operand + ": No such file\n");
      status = 1;
    }
  }
  return status;
};

const xxd: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "pr", values: "lc", long: { plain: "p", ps: "p", postscript: "p", revert: "r" } });
  const data = await bytesOf(ctx, parsed.operands[0] ?? "-");
  if (parsed.flags.has("r")) {
    const text = decode(data);
    const chunks: { offset: number; hex: string }[] = [];
    if (parsed.flags.has("p")) chunks.push({ offset: 0, hex: text.replace(/[^0-9a-fA-F]/g, "") });
    else
      for (const line of text.split("\n")) {
        const match = /^\s*([0-9a-fA-F]+):\s?(.*)$/.exec(line);
        if (!match) continue;
        const end = match[2].indexOf("  ");
        chunks.push({ offset: parseInt(match[1], 16), hex: (end < 0 ? match[2] : match[2].slice(0, end)).replace(/[^0-9a-fA-F]/g, "") });
      }
    let size = 0;
    for (const chunk of chunks) size = Math.max(size, chunk.offset + (chunk.hex.length >> 1));
    if (parsed.flags.has("p")) size = chunks[0]!.hex.length >> 1;
    const out = new Uint8Array(size);
    for (const chunk of chunks) for (let i = 0; i + 1 < chunk.hex.length; i += 2) out[chunk.offset + (i >> 1)] = parseInt(chunk.hex.slice(i, i + 2), 16);
    const target = parsed.operands[1];
    if (target !== undefined) await ctx.fs.write(ctx.resolve(target), out);
    else ctx.stdout.write(decode(out));
    return;
  }
  const limit = Math.min(data.length, Number(last(parsed, "l") ?? data.length));
  if (parsed.flags.has("p")) {
    let hex = "";
    for (let i = 0; i < limit; i++) hex += data[i].toString(16).padStart(2, "0");
    ctx.stdout.write((hex.match(/.{1,60}/g) ?? []).join("\n") + (hex ? "\n" : ""));
    return;
  }
  const columns = Number(last(parsed, "c") ?? 16);
  for (let offset = 0; offset < limit; offset += columns) {
    const row = data.slice(offset, Math.min(offset + columns, limit));
    let hex = "";
    for (let i = 0; i < columns; i++) hex += (i < row.length ? row[i].toString(16).padStart(2, "0") : "  ") + (i % 2 ? " " : "");
    const ascii = Array.from(row, byte => byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".").join("");
    ctx.stdout.write(offset.toString(16).padStart(8, "0") + ": " + hex + " " + ascii + "\n");
  }
};

const od: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "cxbd", values: "AtN" });
  const data = await bytesOf(ctx, parsed.operands[0] ?? "-");
  const type = last(parsed, "t") ?? (parsed.flags.has("c") ? "c" : parsed.flags.has("x") ? "x2" : "o2");
  const address = last(parsed, "A") ?? "o";
  const width = type.endsWith("1") || type === "c" ? 1 : 2;
  const cell = (offset: number) => {
    if (type === "c") {
      const byte = data[offset];
      const named: Record<number, string> = { 0: "\\0", 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r" };
      return (named[byte] ?? (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : byte.toString(8).padStart(3, "0"))).padStart(4);
    }
    const value = width === 1 ? data[offset] : data[offset] | ((data[offset + 1] ?? 0) << 8);
    const base = type.startsWith("x") ? 16 : type.startsWith("d") || type.startsWith("u") ? 10 : 8;
    return " " + value.toString(base).padStart(width === 1 ? (base === 16 ? 2 : 3) : base === 16 ? 4 : base === 10 ? 5 : 6, base === 10 ? " " : "0");
  };
  const label = (offset: number) => address === "n" ? "" : offset.toString(address === "x" ? 16 : address === "d" ? 10 : 8).padStart(7, "0");
  for (let offset = 0; offset < data.length; offset += 16) {
    let line = label(offset);
    for (let i = offset; i < Math.min(offset + 16, data.length); i += width) line += cell(i);
    ctx.stdout.write(line + "\n");
  }
  if (address !== "n") ctx.stdout.write(label(data.length) + "\n");
};

const split: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "d", values: "lba", numeric: true });
  const [input = "-", prefix = "x"] = parsed.operands;
  const lines = Number(last(parsed, "l") ?? last(parsed, "n") ?? 1000);
  const size = last(parsed, "b");
  const width = Number(last(parsed, "a") ?? 2);
  const data = await bytesOf(ctx, input);
  const chunks: Uint8Array[] = [];
  if (size) {
    const bytes = Number(size.replace(/[kKmM]$/, "")) * (/[kK]$/.test(size) ? 1024 : /[mM]$/.test(size) ? 1024 * 1024 : 1);
    for (let offset = 0; offset < data.length; offset += bytes) chunks.push(data.slice(offset, offset + bytes));
  } else {
    const all = decode(data).split(/(?<=\n)/);
    for (let index = 0; index < all.length; index += lines) chunks.push(encode(all.slice(index, index + lines).join("")));
  }
  for (const [index, chunk] of chunks.entries()) {
    let suffix = "";
    if (parsed.flags.has("d")) suffix = String(index).padStart(width, "0");
    else for (let value = index, i = 0; i < width; i++, value = Math.floor(value / 26)) suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    await ctx.fs.write(ctx.resolve(prefix + suffix), chunk);
  }
};

const join: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "i", values: "t12a" });
  const [left, right] = parsed.operands;
  if (!left || !right) throw new CommandError("missing operand", 1);
  const sep = last(parsed, "t");
  const split = (line: string) => sep === undefined ? line.trim().split(/\s+/) : line.split(sep);
  const f1 = Number(last(parsed, "1") ?? 1) - 1;
  const f2 = Number(last(parsed, "2") ?? 1) - 1;
  const lines = async (operand: string) => (await allInput(ctx, [operand])).text.split("\n").filter(Boolean).map(split);
  const a = await lines(left);
  const b = await lines(right);
  const key = (value: string | undefined) => parsed.flags.has("i") ? (value ?? "").toLowerCase() : value ?? "";
  const unpaired = parsed.values.get("a") ?? [];
  const out = sep ?? " ";
  const matched = new Set<number>();
  for (const row of a) {
    const hits = b.map((other, index) => [other, index] as const).filter(([other]) => key(other[f2]) === key(row[f1]));
    if (!hits.length && unpaired.includes("1")) ctx.stdout.write(row.join(out) + "\n");
    for (const [other, index] of hits) {
      matched.add(index);
      ctx.stdout.write([row[f1], ...row.filter((_, i) => i !== f1), ...other.filter((_, i) => i !== f2)].join(out) + "\n");
    }
  }
  if (unpaired.includes("2")) for (const [index, other] of b.entries()) if (!matched.has(index)) ctx.stdout.write(other.join(out) + "\n");
};

const expand: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "i", values: "t" });
  const tab = Number(last(parsed, "t") ?? 8);
  return eachInput(ctx, parsed.operands, text => {
    ctx.stdout.write(text.split("\n").map(line => {
      let out = "";
      let leading = true;
      for (const char of line) {
        if (char === "\t" && (leading || !parsed.flags.has("i"))) out += " ".repeat(tab - (out.length % tab));
        else {
          if (char !== " ") leading = false;
          out += char;
        }
      }
      return out;
    }).join("\n"));
  });
};

const file: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "bi" });
  for (const operand of parsed.operands) {
    const path = ctx.resolve(operand);
    const stat = await ctx.fs.stat(path);
    let kind: string;
    if (!stat) kind = "cannot open (No such file or directory)";
    else if (stat.kind === "directory") kind = parsed.flags.has("i") ? "inode/directory" : "directory";
    else {
      const data = await ctx.fs.read(path);
      const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
      const text = decode(data.slice(0, 4096));
      if (!data.length) kind = parsed.flags.has("i") ? "inode/x-empty" : "empty";
      else if (starts(0x1f, 0x8b)) kind = parsed.flags.has("i") ? "application/gzip" : "gzip compressed data";
      else if (starts(0x89, 0x50, 0x4e, 0x47)) kind = parsed.flags.has("i") ? "image/png" : "PNG image data";
      else if (starts(0xff, 0xd8, 0xff)) kind = parsed.flags.has("i") ? "image/jpeg" : "JPEG image data";
      else if (starts(0x25, 0x50, 0x44, 0x46)) kind = parsed.flags.has("i") ? "application/pdf" : "PDF document";
      else if (starts(0x50, 0x4b, 0x03, 0x04)) kind = parsed.flags.has("i") ? "application/zip" : "Zip archive data";
      else if (data.length > 262 && decode(data.slice(257, 262)) === "ustar") kind = parsed.flags.has("i") ? "application/x-tar" : "POSIX tar archive";
      else if (data.includes(0)) kind = parsed.flags.has("i") ? "application/octet-stream" : "data";
      else if (/^\s*[[{]/.test(text) && (() => { try { JSON.parse(decode(data)); return true; } catch { return false; } })()) kind = parsed.flags.has("i") ? "application/json" : "JSON text data";
      else if (/^#!.*\b(bash|sh)\b/.test(text)) kind = parsed.flags.has("i") ? "text/x-shellscript" : "Bourne-Again shell script, ASCII text executable";
      else kind = parsed.flags.has("i") ? "text/plain" : /[^\x00-\x7f]/.test(text) ? "Unicode text, UTF-8 text" : "ASCII text";
    }
    ctx.stdout.write((parsed.flags.has("b") ? "" : operand + ": ") + kind + "\n");
  }
};

const rg: CommandHandler = ctx => {
  const parsed = options(ctx.args, { flags: "ilcwFvnNHUSo", values: "eAgCBtm", long: { "ignore-case": "i", "files-with-matches": "l", count: "c", "word-regexp": "w", "fixed-strings": "F", "invert-match": "v", "line-number": "n", "no-line-number": "N", "only-matching": "o", glob: "g", context: "C", "max-count": "m", type: "t", hidden: "", "no-heading": "" } });
  const args = ["-r", "-E"];
  if (!parsed.flags.has("N") && !parsed.flags.has("l") && !parsed.flags.has("c")) args.push("-n");
  for (const flag of "ilcwFvo") if (parsed.flags.has(flag)) args.push("-" + flag);
  for (const key of ["A", "B", "C", "m"]) for (const value of parsed.values.get(key) ?? []) args.push("-" + key, value);
  for (const glob of parsed.values.get("g") ?? []) args.push(glob.startsWith("!") ? "--exclude=" + glob.slice(1) : "--include=" + glob);
  const patterns = parsed.values.get("e") ?? [];
  const operands = parsed.operands.slice();
  if (!patterns.length) {
    const pattern = operands.shift();
    if (pattern === undefined) throw new CommandError("no pattern given", 2);
    patterns.push(pattern);
  }
  for (const pattern of patterns) args.push("-e", pattern);
  return ctx.run(["grep", ...args, ...(operands.length ? operands : ["."])]);
};

const ln: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "sfnvr" });
  const [source, destination] = parsed.operands;
  if (!source) throw new CommandError("missing file operand", 1);
  const target = ctx.resolve(destination ?? baseOf(source));
  const from = ctx.resolve(parsed.flags.has("s") && !source.startsWith("/") ? parentOf(target) + "/" + source : source);
  const stat = await ctx.fs.stat(from);
  if (!stat) throw new CommandError("failed to access '" + source + "': No such file or directory", 1);
  if (stat.kind === "directory") throw new CommandError(source + ": links to directories are not supported", 1);
  if (await ctx.fs.stat(target) && !parsed.flags.has("f")) throw new CommandError("failed to create link '" + (destination ?? baseOf(source)) + "': File exists", 1);
  await ctx.fs.write(target, await ctx.fs.read(from));
  ctx.stderr.write("ln: this filesystem has no links; copied '" + source + "' instead\n");
};

export const extraCommands: Record<string, CommandHandler> = {
  cmp,
  env,
  expand,
  file,
  gunzip: compressor("gunzip"),
  gzip: compressor("gzip"),
  join,
  ln,
  md5sum,
  od,
  rg,
  split,
  strings,
  tar,
  time,
  timeout,
  tree,
  which,
  xxd,
  yes,
  zcat: compressor("zcat"),
};

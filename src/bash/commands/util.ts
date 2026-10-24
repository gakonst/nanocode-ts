import { CommandError, budget, type CommandContext, type Input, type Limits } from "../shell.ts";
import { byte, decode, FsError, type FileSystem, type LinkStat } from "../fs.ts";

export type LinkFileSystem = FileSystem & {
  chmod?(path: string, mode: number): Promise<void>;
  utimes?(path: string, mtime: number): Promise<void>;
  symlink?(target: string, path: string): Promise<void>;
  readlink?(path: string): Promise<string | null>;
  lstat?(path: string): Promise<LinkStat | null>;
};

export function linked(ctx: CommandContext): LinkFileSystem {
  return ctx.fs as LinkFileSystem;
}

export async function linkOf(ctx: CommandContext, path: string): Promise<string | null> {
  const fs = linked(ctx);
  return fs.readlink ? fs.readlink(path) : null;
}

export async function lstatOf(ctx: CommandContext, path: string): Promise<LinkStat | null> {
  const fs = linked(ctx);
  return fs.lstat ? fs.lstat(path) : fs.stat(path);
}

export async function canonical(ctx: CommandContext, path: string, mode: "existing" | "parents" | "missing"): Promise<string | null> {
  const fs = linked(ctx);
  const pending = ctx.resolve(path).split("/").filter(Boolean);
  const parts: string[] = [];
  let hops = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    const current = "/" + [...parts, part].join("/");
    const target = fs.readlink ? await fs.readlink(current) : null;
    if (target !== null) {
      if (++hops > 40) return null;
      if (target.startsWith("/")) parts.length = 0;
      pending.unshift(...target.split("/").filter(Boolean));
      continue;
    }
    const stat = await fs.stat(current);
    if (!stat && (mode === "existing" || (mode === "parents" && pending.length))) return null;
    if (stat && stat.kind !== "directory" && pending.length && mode !== "missing") return null;
    parts.push(part);
  }
  return "/" + parts.join("/");
}

export type Parsed = { flags: Set<string>; values: Map<string, string[]>; operands: string[] };

export type Spec = { flags?: string; values?: string; long?: Record<string, string>; numeric?: boolean };

export function options(args: string[], spec: Spec): Parsed {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const operands: string[] = [];
  const add = (key: string, value: string) => values.set(key, [...(values.get(key) ?? []), value]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const key = spec.long?.[name];
      if (key === undefined) throw new CommandError("unrecognized option '" + arg + "'", 2);
      if (key === "") continue;
      if ((spec.values ?? "").includes(key) || key.length > 1) {
        const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
        if (value === undefined) throw new CommandError("option '" + arg + "' requires an argument", 2);
        add(key, value);
      } else flags.add(key);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (spec.numeric && /^-\d+$/.test(arg)) {
        add("n", arg.slice(1));
        continue;
      }
      let valid = true;
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if ((spec.values ?? "").includes(flag)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
          if (value === undefined) throw new CommandError("option requires an argument -- '" + flag + "'", 2);
          add(flag, value);
          break;
        }
        if (!(spec.flags ?? "").includes(flag)) {
          valid = false;
          break;
        }
        flags.add(flag);
      }
      if (!valid) throw new CommandError("invalid option -- '" + arg.slice(1) + "'", 2);
      continue;
    }
    operands.push(arg);
  }
  return { flags, values, operands };
}

export function last(parsed: Parsed, key: string): string | undefined {
  const list = parsed.values.get(key);
  return list?.[list.length - 1];
}

export function device(path: string, size = 65536): string | undefined {
  if (path === "/dev/null") return "";
  if (path === "/dev/zero") return "\0".repeat(size);
  if (path !== "/dev/urandom" && path !== "/dev/random") return undefined;
  let out = "";
  const bytes = new Uint8Array(Math.min(size, 65536));
  while (out.length < size) {
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < size; i++) out += byte(bytes[i]!);
  }
  return out;
}

export async function readInput(ctx: CommandContext, operand: string, size?: number): Promise<string> {
  if (operand === "-" || operand === "/dev/stdin" || operand === "/dev/fd/0") return ctx.stdin.text();
  const path = ctx.resolve(operand);
  const stat = size === undefined ? await ctx.fs.stat(path) : null;
  const special = size !== undefined || !stat ? device(path, size) : undefined;
  if (special !== undefined) return special;
  if (stat) budget(ctx.limits, 2 * stat.size, ctx.name + ": " + operand);
  return decode(await ctx.fs.read(path));
}

export async function eachInput(ctx: CommandContext, operands: string[], visit: (text: string, name: string) => void | Promise<void>, size?: number): Promise<number> {
  let status = 0;
  for (const operand of operands.length ? operands : ["-"]) {
    let text: string;
    try {
      text = await readInput(ctx, operand, size);
    } catch (error) {
      if (!(error instanceof FsError)) throw error;
      ctx.stderr.write(ctx.name + ": " + operand + ": " + (error.code === "ENOENT" ? "No such file or directory" : error.code === "EISDIR" ? "Is a directory" : error.message) + "\n");
      status = 1;
      continue;
    }
    await visit(text, operand);
  }
  return status;
}

export async function allInput(ctx: CommandContext, operands: string[]): Promise<{ text: string; status: number }> {
  const parts: string[] = [];
  let size = 0;
  const status = await eachInput(ctx, operands, chunk => {
    size += chunk.length;
    budget(ctx.limits, size, ctx.name + ": its input");
    parts.push(chunk);
  });
  return { text: parts.length === 1 ? parts[0]! : parts.join(""), status };
}

const SLICE = 1 << 16;
let yielded = 0;
let paused = 0;

export async function pause(ctx: CommandContext) {
  if (ctx.stdout.backlog) await ctx.stdout.drain();
  const now = Date.now();
  if (now - yielded < 25 && ++paused < 64) return;
  yielded = now;
  paused = 0;
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (ctx.signal.aborted) throw new CommandError("aborted", 124);
}

export async function put(ctx: CommandContext, text: string) {
  if (text.length <= SLICE) {
    ctx.stdout.write(text);
    await pause(ctx);
    return;
  }
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + SLICE);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end++;
    ctx.stdout.write(text.slice(start, end));
    start = end;
    await pause(ctx);
  }
}

export function batches(input: Input, separator = "\n", limits?: Limits): () => Promise<string | null> {
  let carry = "";
  return async () => {
    for (;;) {
      const chunk = await input.chunk();
      if (chunk === null) {
        const rest = carry;
        carry = "";
        return rest || null;
      }
      const tail = separator.length > 1 ? carry.slice(1 - separator.length) : "";
      const found = (tail + chunk).lastIndexOf(separator);
      const text = carry ? carry + chunk : chunk;
      if (found < 0) {
        if (limits && text.length > 1 << 20) budget(limits, 2 * text.length, "a line of " + text.length + " characters");
        carry = text;
        continue;
      }
      const end = carry.length - tail.length + found;
      carry = text.slice(end + separator.length);
      return end + separator.length === text.length ? text : text.slice(0, end + separator.length);
    }
  };
}

export async function eachBatch(ctx: CommandContext, operands: string[], visit: (text: string, name: string) => void | Promise<void>, separator = "\n"): Promise<number> {
  let status = 0;
  for (const operand of operands.length ? operands : ["-"]) {
    if (operand === "-" || operand === "/dev/stdin" || operand === "/dev/fd/0") {
      const next = batches(ctx.stdin, separator, ctx.limits);
      for (let text = await next(); text !== null; text = await next()) await visit(text, operand);
      continue;
    }
    let text: string;
    try {
      text = await readInput(ctx, operand);
    } catch (error) {
      if (!(error instanceof FsError)) throw error;
      ctx.stderr.write(ctx.name + ": " + operand + ": " + (error.code === "ENOENT" ? "No such file or directory" : error.code === "EISDIR" ? "Is a directory" : error.message) + "\n");
      status = 1;
      continue;
    }
    await visit(text, operand);
  }
  return status;
}

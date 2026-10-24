import { CommandError, type CommandContext } from "../shell.ts";
import { byte, decode, FsError } from "../fs.ts";

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
  if (operand === "-" || operand === "/dev/stdin") return ctx.stdin.read();
  const path = ctx.resolve(operand);
  const special = size !== undefined || !(await ctx.fs.stat(path)) ? device(path, size) : undefined;
  if (special !== undefined) return special;
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
  let text = "";
  const status = await eachInput(ctx, operands, chunk => {
    text += chunk;
  });
  return { text, status };
}

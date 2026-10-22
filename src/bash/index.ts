import type { HostTool } from "../contracts.ts";
import { MemoryFileSystem, decode, encode, parentOf, resolvePath, type FileInput, type FileSystem } from "./fs.ts";
import { Input, Output, Runner, State, run, type CommandHandler, type Limits } from "./shell.ts";
import { fileCommands, mkdirs } from "./commands/files.ts";
import { textCommands } from "./commands/text.ts";
import { sed } from "./commands/sed.ts";
import { awk } from "./commands/awk.ts";
import { jq } from "./commands/jq.ts";
import { curl } from "./commands/curl.ts";

export { MemoryFileSystem, FsError, normalize, resolvePath, type FileInput, type FileKind, type FileStat, type FileSystem } from "./fs.ts";
export { CommandError, type CommandContext, type CommandHandler, type Limits } from "./shell.ts";

export type BashOptions = {
  files?: Record<string, FileInput>;
  fs?: FileSystem;
  env?: Record<string, string>;
  cwd?: string;
  fetch?: typeof fetch;
  limits?: Partial<Limits>;
  commands?: Record<string, CommandHandler>;
};

export type ExecOptions = { stdin?: string; env?: Record<string, string>; cwd?: string; signal?: AbortSignal };

export type BashResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean };

export type BashToolOptions = { name?: string; description?: string; maxOutputLength?: number };

export const DEFAULT_LIMITS: Limits = {
  maxCommands: 100_000,
  maxLoopIterations: 10_000,
  maxCallDepth: 64,
  maxOutputLength: 1_000_000,
  maxBufferLength: 16_000_000,
  timeoutMs: 30_000,
};

const COMMANDS: Record<string, CommandHandler> = { ...fileCommands, ...textCommands, sed, awk, gawk: awk, jq, curl };

export const BASH_COMMANDS = Object.keys(COMMANDS).sort();

export class Bash {
  readonly fs: FileSystem;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly limits: Limits;
  readonly commands: Map<string, CommandHandler>;
  readonly fetch?: typeof fetch;

  private constructor(options: BashOptions) {
    this.fs = options.fs ?? new MemoryFileSystem(options.files);
    this.cwd = resolvePath("/", options.cwd ?? "/home/user");
    this.env = { HOME: "/home/user", USER: "user", PATH: "/usr/local/bin:/usr/bin:/bin", SHELL: "/bin/bash", LANG: "C.UTF-8", TMPDIR: "/tmp", ...options.env };
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.commands = new Map(Object.entries({ ...COMMANDS, ...options.commands }));
    this.fetch = options.fetch;
  }

  static async create(options: BashOptions = {}): Promise<Bash> {
    const shell = new Bash(options);
    if (options.fs && options.files) for (const [path, content] of Object.entries(options.files)) await shell.writeFile(path, content);
    for (const dir of [shell.cwd, "/tmp"]) await mkdirs(shell.fs, dir);
    return shell;
  }

  async exec(script: string, options: ExecOptions = {}): Promise<BashResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("execution timed out after " + this.limits.timeoutMs + " ms"), this.limits.timeoutMs);
    const onAbort = () => controller.abort("execution aborted");
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const state = new State();
    const cwd = resolvePath(this.cwd, options.cwd ?? this.cwd);
    state.cwd = cwd;
    for (const [name, value] of Object.entries({ ...this.env, ...options.env, PWD: cwd })) {
      state.vars.set(name, [value]);
      state.exported.add(name);
    }
    const runner = new Runner({ fs: this.fs, commands: this.commands, fetch: this.fetch, limits: this.limits }, state, controller.signal);
    const stdout = new Output(this.limits.maxOutputLength, false);
    const stderr = new Output(this.limits.maxOutputLength, false);
    let exitCode: number;
    try {
      exitCode = await run(runner, script, { stdin: new Input(options.stdin ?? ""), stdout, stderr });
    } catch (error) {
      stderr.write("bash: " + (error instanceof Error ? error.message : String(error)) + "\n");
      exitCode = 1;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    return { stdout: stdout.text(), stderr: stderr.text(), exitCode, truncated: stdout.truncated || stderr.truncated };
  }

  async readFile(path: string): Promise<string> {
    return decode(await this.fs.read(resolvePath(this.cwd, path)));
  }

  async writeFile(path: string, content: FileInput): Promise<void> {
    const target = resolvePath(this.cwd, path);
    await mkdirs(this.fs, parentOf(target));
    await this.fs.write(target, typeof content === "string" ? encode(content) : content);
  }

  tool(options: BashToolOptions = {}): { definition: HostTool; call(input: unknown, signal?: AbortSignal): Promise<string> } {
    const limit = options.maxOutputLength ?? 30_000;
    return {
      definition: bashTool(options),
      call: async (input, signal) => {
        const command = typeof input === "string" ? input : (input as { command?: unknown } | null)?.command;
        if (typeof command !== "string") throw new Error("bash: input must be { command: string }");
        return formatResult(await this.exec(command, { signal }), limit);
      },
    };
  }

}

export const BASH_CODE_MODE_INSTRUCTIONS = "Code Mode cells also have `bash`, a simulated bash over an in-memory filesystem that keeps its files for this session: `await bash(\"ls -la | wc -l\")`, or as a tagged template, await bash`grep -rn ${pattern} src`, which quotes each interpolated value, resolves to { stdout, stderr, exitCode }, and `bash.readFile(path)` and `bash.writeFile(path, text)` reach the same files from JavaScript. It has the usual file and text tools (cat, ls, find, grep, sed, awk, jq, sort, uniq, cut, tr, xargs, head, tail, wc, diff, base64, sha256sum, ...), and its curl goes through the same paying fetch as `fetch`, so curl can call MPP services. Variables and the working directory reset between calls; files persist.";

export const BASH_TOOL_DESCRIPTION = "Run a bash script in a sandboxed, simulated shell (no real processes) over a persistent in-memory filesystem shared by every call; variables, functions and the working directory reset between calls. Supports pipes, redirections (> >> < 2> 2>&1 &> heredocs, here-strings), && || ;, if/for/while/until/case, functions, $(...), $((...)), globbing, brace expansion, arrays and set -euo pipefail. Commands: " + BASH_COMMANDS.join(", ") + ", plus builtins (cd, pwd, export, read, test/[ ], [[ ]], source, eval, printf -v, ...). jq covers paths, filters, map/select, reduce, assignment and -r/-c/-n/-s/--arg; curl supports -X -H -d --json -o -i -s -f -w -L and pays MPP (HTTP 402) services automatically when the host provides a paying fetch. Output is truncated when very long.";

export function bashTool(options: BashToolOptions = {}): HostTool {
  return {
    name: options.name ?? "bash",
    description: options.description ?? BASH_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The bash script to run." } },
      required: ["command"],
      additionalProperties: false,
    },
  };
}

export function formatResult(result: BashResult, limit = 30_000): string {
  let text = result.stdout;
  if (result.stderr) text += (text && !text.endsWith("\n") ? "\n" : "") + "[stderr]\n" + result.stderr;
  if (text.length > limit) {
    const head = Math.floor(limit * 0.6);
    const tail = limit - head;
    text = text.slice(0, head) + "\n[... " + (text.length - limit) + " characters truncated ...]\n" + text.slice(-tail);
  } else if (result.truncated) text += "\n[output truncated]";
  if (result.exitCode !== 0) text += (text && !text.endsWith("\n") ? "\n" : "") + "[exit code " + result.exitCode + "]";
  return text || "(no output)";
}

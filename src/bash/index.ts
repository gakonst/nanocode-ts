import type { HostTool, WorkspaceHost } from "../contracts.ts";
import { FsError, MemoryFileSystem, decode, display, encode, parentOf, resolvePath, type FileInput, type FileSystem } from "./fs.ts";
import { BUILTINS, Input, LimitError, Output, Runner, State, megabytes, run, type CommandHandler, type Limits } from "./shell.ts";
import { fileCommands, mkdirs } from "./commands/files.ts";
import { textCommands } from "./commands/text.ts";
import { sed } from "./commands/sed.ts";
import { awk } from "./commands/awk.ts";
import { jq } from "./commands/jq.ts";
import { curl, wget } from "./commands/curl.ts";
import { unzip, zip } from "./commands/zip.ts";
import { patch } from "./commands/patch.ts";
import { extraCommands } from "./commands/extra.ts";
import { systemCommands } from "./commands/system.ts";
import { gitCommands, type GitHubOptions } from "./commands/git.ts";
import { wasmCommands, wasmHost, type WasmOptions } from "./commands/wasm.ts";
import { pythonCommands, type PythonOptions } from "./commands/python.ts";

export { MemoryFileSystem, FsError, normalize, resolvePath, type FileInput, type FileKind, type FileStat, type FileSystem, type LinkStat } from "./fs.ts";
export { SqlFileSystem } from "./sql.ts";
export { mounted } from "./mount.ts";
export { CommandError, PipeError, streaming, type CommandContext, type CommandHandler, type Limits } from "./shell.ts";
export { codeload, githubArchives, withGitHub, type GitHubFetchOptions, type GitHubOptions, type GitHubToken } from "./commands/git.ts";
export { type WasmOptions } from "./commands/wasm.ts";
export { preloadPython, PYODIDE_URL, PYODIDE_VERSION, pythonHint, type Pyodide, type PyodideFS, type PythonOptions, type PythonRemote, type PythonReply, type PythonRequest } from "./commands/python.ts";

export type BashOptions = {
  files?: Record<string, FileInput>;
  fs?: FileSystem;
  env?: Record<string, string>;
  cwd?: string;
  fetch?: typeof fetch;
  github?: GitHubOptions;
  wasm?: WasmOptions;
  python?: PythonOptions;
  limits?: Partial<Limits>;
  commands?: Record<string, CommandHandler>;
  observe?: (event: BashEvent) => void;
};

export type ExecOptions = { stdin?: string; env?: Record<string, string>; cwd?: string; signal?: AbortSignal; timeoutMs?: number };

export type BashResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean };

export type BashCategory = "none" | "search_admission" | "resource_limit" | "timeout" | "cancelled" | "syntax" | "command_not_found" | "command_exit" | "input_validation" | "exception";

export type BashEvent =
  | { phase: "started"; call: number; command: string }
  | { phase: "finished"; call: number; command: string; status: "success" | "error"; category: BashCategory; exitCode: number | null; durationMs: number; outputTruncated: boolean };

const WORKSPACE_TIMEOUT_MS = 600_000;

export const DEFAULT_LIMITS: Limits = {
  maxCommands: 1_000_000,
  maxLoopIterations: 1_000_000,
  maxCallDepth: 1000,
  maxOutputLength: 1_000_000,
  maxBufferLength: 16_000_000,
  maxMemoryBytes: 1 << 30,
  maxFileOperations: 1_000_000,
  timeoutMs: 30_000,
};

const COMMANDS: Record<string, CommandHandler> = { ...fileCommands, ...textCommands, ...extraCommands, ...systemCommands, ...gitCommands(), ...wasmCommands(), ...pythonCommands(), sed, awk, gawk: awk, jq, curl, wget, patch, unzip, zip, wat2wasm: async context => (await import("./commands/wat.ts")).wat(context) };

export const BASH_COMMANDS = Object.keys(COMMANDS).sort();

export class Bash {
  readonly fs: FileSystem;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly limits: Limits;
  readonly commands: Map<string, CommandHandler>;
  readonly fetch?: typeof fetch;
  readonly observe?: (event: BashEvent) => void;
  readonly #wasm: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly #python: "remote" | "pyodide" | "none";
  #calls = 0;

  private constructor(options: BashOptions) {
    this.fs = options.fs ?? new MemoryFileSystem(options.files);
    this.cwd = resolvePath("/", options.cwd ?? "/home/user");
    this.env = { HOME: "/home/user", USER: "user", PATH: "/usr/local/bin:/usr/bin:/bin", SHELL: "/bin/bash", LANG: "C.UTF-8", TMPDIR: "/tmp", ...options.env };
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.commands = new Map(Object.entries({ ...COMMANDS, ...(options.github ? gitCommands(options.github) : {}), ...(options.wasm ? wasmCommands(options.wasm) : {}), ...(options.python ? pythonCommands(options.python) : {}), ...options.commands }));
    this.#python = options.python?.remote ? "remote" : compiles() ? "pyodide" : "none";
    if (this.#python === "none") for (const name of ["python", "python3", "pip", "pip3"]) if (!options.commands?.[name]) this.commands.delete(name);
    this.fetch = options.fetch;
    this.observe = options.observe;
    this.#wasm = wasmHost(this, options.wasm);
  }

  static async create(options: BashOptions = {}): Promise<Bash> {
    const shell = new Bash(options);
    if (options.fs && options.files) for (const [path, content] of Object.entries(options.files)) await shell.writeFile(path, content);
    for (const dir of [shell.cwd, "/tmp"]) await mkdirs(shell.fs, dir);
    return shell;
  }

  async exec(script: string, options: ExecOptions = {}): Promise<BashResult> {
    const call = ++this.#calls;
    const command = this.#command(script);
    const started = Date.now();
    this.#emit({ phase: "started", call, command });
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? this.limits.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("execution timed out after " + timeoutMs + " ms");
    }, timeoutMs);
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
    for (const [name, value] of Object.entries({ BASH: "/bin/bash", BASH_VERSION: "5.2.21(1)-release", HOSTNAME: "localhost", SHLVL: "1", IFS: " \t\n", OPTIND: "1", OSTYPE: "linux-gnu", PPID: "1", UID: "1000", EUID: "1000" })) if (!state.vars.has(name)) state.vars.set(name, [value]);
    const budget = { used: 0, refused: false };
    const runner = new Runner({ fs: budgeted(this.fs, this.limits.maxFileOperations, budget), commands: this.commands, fetch: this.fetch, limits: { ...this.limits, timeoutMs } }, state, controller.signal);
    const stdout = new Output(this.limits.maxOutputLength, false);
    const stderr = new Output(this.limits.maxOutputLength, false);
    let exitCode: number;
    let category: BashCategory | undefined;
    try {
      exitCode = await run(runner, script, { stdin: new Input(options.stdin ?? ""), stdout, stderr });
    } catch (error) {
      stderr.write("bash: " + (error instanceof Error ? error.message : String(error)) + "\n");
      exitCode = 1;
      category = "exception";
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    const truncated = stdout.truncated || stderr.truncated;
    if (exitCode === 0) category = "none";
    else if (options.signal?.aborted) category = (options.signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError" ? "timeout" : "cancelled";
    else if (timedOut) category = "timeout";
    else if (budget.refused) category = "search_admission";
    else if (category === undefined) category = runner.failure === "syntax" ? "syntax" : runner.failure === "limit" ? "resource_limit" : exitCode === 127 ? "command_not_found" : "command_exit";
    this.#emit({ phase: "finished", call, command, status: exitCode === 0 ? "success" : "error", category, exitCode, durationMs: Date.now() - started, outputTruncated: truncated });
    return { stdout: display(stdout.text()), stderr: display(stderr.text()), exitCode, truncated };
  }

  #command(script: string): string {
    const name = /^\s*([A-Za-z_][\w.-]*)(?=\s|;|\||&|$)/.exec(script.slice(0, 128))?.[1];
    return name !== undefined && (this.commands.has(name) || Object.hasOwn(BUILTINS, name)) ? name : "other";
  }

  #emit(event: BashEvent) {
    if (!this.observe) return;
    try {
      Promise.resolve(this.observe(event)).catch(() => {});
    } catch {}
  }

  async readFile(path: string): Promise<string> {
    return display(decode(await this.fs.read(resolvePath(this.cwd, path))));
  }

  async writeFile(path: string, content: FileInput): Promise<void> {
    const target = resolvePath(this.cwd, path);
    await mkdirs(this.fs, parentOf(target));
    await this.fs.write(target, typeof content === "string" ? encode(content) : content);
  }

  workspace(): WorkspaceHost {
    return {
      read: async path => {
        const target = resolvePath(this.cwd, path);
        const stat = await this.fs.stat(target);
        if (!stat) return null;
        if (stat.kind !== "file") throw new FsError("EISDIR", target);
        if (6 * stat.size > this.limits.maxMemoryBytes) throw new LimitError(path + " is " + megabytes(stat.size) + ", more than the " + megabytes(Math.floor(this.limits.maxMemoryBytes / 6)) + " this host's file tools read whole; read parts of it with bash (head -c, tail -c, sed -n, grep, split) instead");
        return display(decode(await this.fs.read(target)));
      },
      write: (path, contents) => this.writeFile(path, contents),
      readBytes: path => this.fs.read(resolvePath(this.cwd, path)),
      writeBytes: async (path, data, append) => {
        const target = resolvePath(this.cwd, path);
        await mkdirs(this.fs, parentOf(target));
        await this.fs.write(target, data, append);
      },
      remove: async path => this.fs.remove(resolvePath(this.cwd, path)),
      run: async (request, signal) => {
        const result = await this.exec(request.command, { cwd: request.cwd, signal, timeoutMs: request.timeout_ms ?? WORKSPACE_TIMEOUT_MS, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
        return { stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode, truncated: result.truncated };
      },
      wasm: (request, signal) => this.#wasm(request, signal),
    };
  }

}

function budgeted(fs: FileSystem, limit: number, budget: { used: number; refused: boolean }): FileSystem {
  const charge = () => {
    if (++budget.used <= limit) return;
    budget.refused = true;
    throw new LimitError("too many file operations (limit " + limit + "); search a narrower path");
  };
  return {
    stat: path => (charge(), DEVICES.has(path) ? Promise.resolve({ kind: "file", size: 0, mtime: 0, mode: 0o666 }) : fs.stat(path)),
    read: path => (charge(), DEVICES.has(path) ? Promise.resolve(device(path)) : fs.read(path)),
    write: (path, data, append) => (charge(), DEVICES.has(path) ? Promise.resolve() : fs.write(path, data, append)),
    list: path => (charge(), path === "/dev" ? fs.list(path).catch(() => []).then(names => [...new Set([...names, ...[...DEVICES].map(name => name.slice(5))])].sort()) : fs.list(path)),
    mkdir: path => (charge(), fs.mkdir(path)),
    remove: path => (charge(), fs.remove(path)),
    rename: (from, to) => (charge(), fs.rename(from, to)),
    ...(fs.chmod ? { chmod: (path: string, mode: number) => (charge(), fs.chmod!(path, mode)) } : {}),
    ...(fs.utimes ? { utimes: (path: string, mtime: number) => (charge(), fs.utimes!(path, mtime)) } : {}),
    ...(fs.symlink ? { symlink: (target: string, path: string) => (charge(), fs.symlink!(target, path)) } : {}),
    ...(fs.readlink ? { readlink: (path: string) => (charge(), fs.readlink!(path)) } : {}),
    ...(fs.lstat ? { lstat: (path: string) => (charge(), fs.lstat!(path)) } : {}),
    ...(fs.search ? { search: (dir: string, literals: string[]) => (charge(), fs.search!(dir, literals)) } : {}),
  };
}

const DEVICES = new Set(["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"]);

function device(path: string): Uint8Array {
  if (path === "/dev/null") return new Uint8Array(0);
  const bytes = new Uint8Array(1 << 20);
  if (path !== "/dev/zero") for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
  return bytes;
}

const BASH_GIT_INSTRUCTIONS = "To get a public GitHub repository, run `git clone https://github.com/OWNER/REPO [DIR]` (or `gh repo clone OWNER/REPO [DIR]`, with `-b REF` for a branch, tag or commit): it downloads a source snapshot of the current files without earlier history, and local git works on it and on `git init` repositories: status, add, rm, mv, commit (-m, -a, --amend), diff (--cached, --stat, between commits), log, show, branch, checkout/switch (-b), restore and reset (--hard); fetch, pull, push, merge, rebase and stash do not.";

const BASH_GITHUB_FILE_INSTRUCTIONS = "For single files, read `https://raw.githubusercontent.com/OWNER/REPO/REF/PATH` (REF may be HEAD), and for archives `https://codeload.github.com/OWNER/REPO/tar.gz/REF`, rather than api.github.com: this host may share its address with others, so the API can answer 403 rate limit exceeded.";

const BASH_PROGRAM_INSTRUCTIONS = "WebAssembly programs built for WASI (wasm32-wasi) run directly: `./prog.wasm ARGS`, `wasm prog.wasm ARGS` or `wasmtime prog.wasm ARGS`, with stdin, stdout, exit codes, the environment and the files under the working directory (up to 64 MiB, written back when the program exits). There is no C or Rust compiler: write WebAssembly text and assemble it with `wat2wasm prog.wat` (writes prog.wasm; flat or folded instructions, memory, data, globals and imports such as WASI's `fd_write`), rather than writing module bytes by hand, or download the .wasm file. `wasm --invoke NAME FILE ARGS` calls one exported function and prints its result. Python 3 runs on Pyodide (CPython compiled to WebAssembly, loaded on first use): `python3 script.py ARGS`, `python3 -c CODE`, `python3 -m MODULE` and stdin work on the files under the working directory and /tmp, numpy, pandas and the other packages Pyodide ships load when imported, and `pip install PKG` installs pure-Python wheels for the rest of the session. Python has no network access (urllib, requests and sockets fail), so download files with curl first and read them from Python.";

export const BASH_SHELL_INSTRUCTIONS = BASH_GIT_INSTRUCTIONS + " " + BASH_GITHUB_FILE_INSTRUCTIONS + " " + BASH_PROGRAM_INSTRUCTIONS;

function compiles(): boolean {
  try {
    new (WebAssembly as unknown as { Module: new (bytes: Uint8Array) => unknown }).Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return true;
  } catch {
    return false;
  }
}

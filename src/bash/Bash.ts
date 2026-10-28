/**
 * Simulated bash shell over a pluggable file system, with Unix text tools, git, curl, jq, Python,
 * and WebAssembly commands.
 *
 * @module
 */
import type * as Contracts from '../Contracts.ts'
import type * as Command from './Command.ts'
import * as FileSystem from './FileSystem.ts'
import type * as GitHub from './GitHub.ts'
import * as MemoryFileSystem from './MemoryFileSystem.ts'
import type * as Python from './Python.ts'
import type * as Wasm from './Wasm.ts'
import { decode, display, encode, parentOf } from './internal/Fs.ts'
import * as Shell from './internal/Shell.ts'
import { awk } from './internal/commands/awk.ts'
import { curl, wget } from './internal/commands/curl.ts'
import { extraCommands } from './internal/commands/extra.ts'
import { fileCommands, mkdirs } from './internal/commands/files.ts'
import { gitCommands } from './internal/commands/git.ts'
import { jq } from './internal/commands/jq.ts'
import { patch } from './internal/commands/patch.ts'
import { pythonCommands } from './internal/commands/python.ts'
import { sed } from './internal/commands/sed.ts'
import { systemCommands } from './internal/commands/system.ts'
import { textCommands } from './internal/commands/text.ts'
import { wasmCommands, wasmHost } from './internal/commands/wasm.ts'
import { unzip, zip } from './internal/commands/zip.ts'

export type { Limits } from './internal/Shell.ts'

/** Shell that `create` returns. */
export type Bash = {
  /** Command handlers by name, after the host's additions and removals. */
  readonly commands: Map<string, Command.Handler>
  /** Working directory that each `exec` starts in. */
  readonly cwd: string
  /** Environment variables that each `exec` starts with. */
  readonly env: Record<string, string>
  /** Runs a script and returns its output and exit code. It does not throw for a failed script. */
  exec(script: string, options?: ExecOptions): Promise<Result>
  /** File system of the shell. */
  readonly fs: FileSystem.FileSystem
  /** Limits of the shell. */
  readonly limits: Shell.Limits
  /** Returns the text of the file at `path`, resolved against `cwd`. */
  readFile(path: string): Promise<string>
  /** Returns the workspace host that the WebAssembly runtime uses for file tools, shell runs, and WebAssembly cells. */
  workspace(): Contracts.WorkspaceHost
  /** Writes the file at `path`, resolved against `cwd`, and makes its parent directories. */
  writeFile(path: string, content: FileSystem.FileInput): Promise<void>
}

/** Failure class of one `exec`, in the `finished` event. */
export type Category =
  | 'none'
  | 'search_admission'
  | 'resource_limit'
  | 'timeout'
  | 'cancelled'
  | 'syntax'
  | 'command_not_found'
  | 'command_exit'
  | 'input_validation'
  | 'exception'

/** Event that `create.Options.observe` receives before and after each `exec`. */
export type Event =
  | {
      /** Command name of the script, or `other`. */
      command: string
      /** Sequence number of the `exec` call on this shell, from 1. */
      call: number
      phase: 'started'
    }
  | {
      /** Sequence number of the `exec` call on this shell, from 1. */
      call: number
      /** Failure class, or `none` for exit code 0. */
      category: Category
      /** Command name of the script, or `other`. */
      command: string
      /** Duration of the call in milliseconds. */
      durationMs: number
      /** Exit code of the script. */
      exitCode: number | null
      /** Whether `exec` cut stdout or stderr at `maxOutputLength`. */
      outputTruncated: boolean
      phase: 'finished'
      /** `success` for exit code 0, and `error` otherwise. */
      status: 'success' | 'error'
    }

/** Options of one `exec` call. */
export type ExecOptions = {
  /** Working directory, resolved against the shell's `cwd`. */
  cwd?: string
  /** Environment variables added to the shell's `env`. */
  env?: Record<string, string>
  /** Aborts the execution. */
  signal?: AbortSignal
  /** Standard input. */
  stdin?: string
  /** Deadline in milliseconds. Defaults to `limits.timeoutMs`. */
  timeoutMs?: number
}

/** Output of one `exec` call. */
export type Result = {
  /** Exit code of the script. */
  exitCode: number
  /** Standard error. */
  stderr: string
  /** Standard output. */
  stdout: string
  /** Whether stdout or stderr reached `maxOutputLength` and lost its tail. */
  truncated: boolean
}

const workspaceTimeoutMs = 600_000

/** Limits that `create` applies when the host does not override them. */
export const defaultLimits: Shell.Limits = {
  maxCommands: 1_000_000,
  maxLoopIterations: 1_000_000,
  maxCallDepth: 1000,
  maxOutputLength: 1_000_000,
  maxBufferLength: 16_000_000,
  maxMemoryBytes: 1 << 30,
  maxFileOperations: 1_000_000,
  timeoutMs: 30_000,
}

// Later entries shadow earlier ones, so the order of the spreads is significant.
const builtinCommands: Record<string, Command.Handler> = {
  ...fileCommands,
  ...textCommands,
  ...extraCommands,
  ...systemCommands,
  ...gitCommands(),
  ...wasmCommands(),
  ...pythonCommands(),
  sed,
  awk,
  gawk: awk,
  jq,
  curl,
  wget,
  patch,
  unzip,
  zip,
  wat2wasm: async (context) => (await import('./internal/commands/wat.ts')).wat(context),
}

/** Sorted names of the commands that every shell has, before host options add or remove any. */
export const commandNames = Object.keys(builtinCommands).sort()

/**
 * Creates a shell. Without `fs`, it seeds an in-memory file system with `files`. It makes `cwd` and
 * `/tmp`.
 */
export async function create(options: create.Options = {}): Promise<Bash> {
  const fs = options.fs ?? MemoryFileSystem.create({ files: options.files })
  const cwd = FileSystem.resolvePath('/', options.cwd ?? '/home/user')
  const env = {
    HOME: '/home/user',
    USER: 'user',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    ...options.env,
  }
  const limits = { ...defaultLimits, ...options.limits }
  const commands = new Map(
    Object.entries({
      ...builtinCommands,
      ...(options.github ? gitCommands(options.github) : {}),
      ...(options.wasm ? wasmCommands(options.wasm) : {}),
      ...(options.python ? pythonCommands(options.python) : {}),
      ...options.commands,
    }),
  )
  const python = options.python?.remote ? 'remote' : compiles() ? 'pyodide' : 'none'
  if (python === 'none')
    for (const name of ['python', 'python3', 'pip', 'pip3'])
      if (!options.commands?.[name]) commands.delete(name)
  let calls = 0

  const emit = (event: Event) => {
    if (!options.observe) return
    try {
      Promise.resolve(options.observe(event)).catch(() => {})
    } catch {}
  }

  const commandOf = (script: string): string => {
    const name = /^\s*([A-Za-z_][\w.-]*)(?=\s|;|\||&|$)/.exec(script.slice(0, 128))?.[1]
    return name !== undefined && (commands.has(name) || Object.hasOwn(Shell.BUILTINS, name))
      ? name
      : 'other'
  }

  const shell: Bash = {
    commands,
    cwd,
    env,
    async exec(script: string, execOptions: ExecOptions = {}): Promise<Result> {
      const call = ++calls
      const command = commandOf(script)
      const started = Date.now()
      emit({ phase: 'started', call, command })
      const controller = new AbortController()
      let timedOut = false
      const timeoutMs = execOptions.timeoutMs ?? limits.timeoutMs
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort('execution timed out after ' + timeoutMs + ' ms')
      }, timeoutMs)
      const onAbort = () => controller.abort('execution aborted')
      if (execOptions.signal?.aborted) onAbort()
      execOptions.signal?.addEventListener('abort', onAbort, { once: true })
      const state = new Shell.State()
      const directory = FileSystem.resolvePath(cwd, execOptions.cwd ?? cwd)
      state.cwd = directory
      for (const [name, value] of Object.entries({ ...env, ...execOptions.env, PWD: directory })) {
        state.vars.set(name, [value])
        state.exported.add(name)
      }
      for (const [name, value] of Object.entries({
        BASH: '/bin/bash',
        BASH_VERSION: '5.2.21(1)-release',
        HOSTNAME: 'localhost',
        SHLVL: '1',
        IFS: ' \t\n',
        OPTIND: '1',
        OSTYPE: 'linux-gnu',
        PPID: '1',
        UID: '1000',
        EUID: '1000',
      }))
        if (!state.vars.has(name)) state.vars.set(name, [value])
      const budget = { used: 0, refused: false }
      const runner = new Shell.Runner(
        {
          fs: budgeted(fs, limits.maxFileOperations, budget),
          commands,
          fetch: options.fetch,
          limits: { ...limits, timeoutMs },
        },
        state,
        controller.signal,
      )
      const stdout = new Shell.Output(limits.maxOutputLength, false)
      const stderr = new Shell.Output(limits.maxOutputLength, false)
      let exitCode: number
      let category: Category | undefined
      try {
        exitCode = await Shell.run(runner, script, {
          stdin: new Shell.Input(execOptions.stdin ?? ''),
          stdout,
          stderr,
        })
      } catch (error) {
        stderr.write('bash: ' + (error instanceof Error ? error.message : String(error)) + '\n')
        exitCode = 1
        category = 'exception'
      } finally {
        clearTimeout(timer)
        execOptions.signal?.removeEventListener('abort', onAbort)
      }
      const truncated = stdout.truncated || stderr.truncated
      if (exitCode === 0) category = 'none'
      else if (execOptions.signal?.aborted)
        category =
          (execOptions.signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError'
            ? 'timeout'
            : 'cancelled'
      else if (timedOut) category = 'timeout'
      else if (budget.refused) category = 'search_admission'
      else if (category === undefined)
        category =
          runner.failure === 'syntax'
            ? 'syntax'
            : runner.failure === 'limit'
              ? 'resource_limit'
              : exitCode === 127
                ? 'command_not_found'
                : 'command_exit'
      emit({
        phase: 'finished',
        call,
        command,
        status: exitCode === 0 ? 'success' : 'error',
        category,
        exitCode,
        durationMs: Date.now() - started,
        outputTruncated: truncated,
      })
      return { stdout: display(stdout.text()), stderr: display(stderr.text()), exitCode, truncated }
    },

    fs,
    limits,

    async readFile(path: string): Promise<string> {
      return display(decode(await fs.read(FileSystem.resolvePath(cwd, path))))
    },

    async writeFile(path: string, content: FileSystem.FileInput): Promise<void> {
      const target = FileSystem.resolvePath(cwd, path)
      await mkdirs(fs, parentOf(target))
      await fs.write(target, typeof content === 'string' ? encode(content) : content)
    },

    workspace(): Contracts.WorkspaceHost {
      return {
        read: async (path) => {
          const target = FileSystem.resolvePath(cwd, path)
          const stat = await fs.stat(target)
          if (!stat) return null
          if (stat.kind !== 'file') throw new FileSystem.FsError('EISDIR', target)
          if (6 * stat.size > limits.maxMemoryBytes)
            throw new Shell.LimitError(
              path +
                ' is ' +
                Shell.megabytes(stat.size) +
                ', more than the ' +
                Shell.megabytes(Math.floor(limits.maxMemoryBytes / 6)) +
                " this host's file tools read whole; read parts of it with bash (head -c, tail -c, sed -n, grep, split) instead",
            )
          return display(decode(await fs.read(target)))
        },
        write: (path, contents) => shell.writeFile(path, contents),
        readBytes: (path) => fs.read(FileSystem.resolvePath(cwd, path)),
        writeBytes: async (path, data, append) => {
          const target = FileSystem.resolvePath(cwd, path)
          await mkdirs(fs, parentOf(target))
          await fs.write(target, data, append)
        },
        remove: async (path) => fs.remove(FileSystem.resolvePath(cwd, path)),
        run: async (request, signal) => {
          const result = await shell.exec(request.command, {
            cwd: request.cwd,
            signal,
            timeoutMs: request.timeout_ms ?? workspaceTimeoutMs,
            ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
          })
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exitCode,
            truncated: result.truncated,
          }
        },
        wasm: (request, signal) => wasm(request, signal),
      }
    },
  }
  const wasm = wasmHost(shell, options.wasm)

  if (options.fs && options.files)
    for (const [path, content] of Object.entries(options.files))
      await shell.writeFile(path, content)
  for (const dir of [cwd, '/tmp']) await mkdirs(fs, dir)
  return shell
}

export declare namespace create {
  type Options = {
    /** Command handlers that add to or replace the built-in commands, by name. */
    commands?: Record<string, Command.Handler>
    /** Working directory. Defaults to `/home/user`. */
    cwd?: string
    /** Environment variables added to the defaults, such as `HOME` and `PATH`. */
    env?: Record<string, string>
    /** Network fetch for `curl`, `wget`, and `git clone`. Without it, the shell has no network access. */
    fetch?: typeof fetch
    /** Files to write before the first `exec`, keyed by path. */
    files?: Record<string, FileSystem.FileInput>
    /** File system of the shell. Defaults to a new in-memory file system. */
    fs?: FileSystem.FileSystem
    /** Options of the `git` and `gh` commands. */
    github?: GitHub.Options
    /** Limits that override `defaultLimits`. */
    limits?: Partial<Shell.Limits>
    /** Receives an event before and after each `exec`. Its errors are ignored. */
    observe?: (event: Event) => void
    /** Options of the Python commands. */
    python?: Python.Options
    /** Options of the WebAssembly commands. */
    wasm?: Wasm.Options
  }
}

const gitInstructions =
  'To get a public GitHub repository, run `git clone https://github.com/OWNER/REPO [DIR]` (or `gh repo clone OWNER/REPO [DIR]`, with `-b REF` for a branch, tag or commit): it downloads a source snapshot of the current files without earlier history, and local git works on it and on `git init` repositories: status, add, rm, mv, commit (-m, -a, --amend), diff (--cached, --stat, between commits), log, show, branch, checkout/switch (-b), restore and reset (--hard); fetch, pull, push, merge, rebase and stash do not.'

const githubFileInstructions =
  'For single files, read `https://raw.githubusercontent.com/OWNER/REPO/REF/PATH` (REF may be HEAD), and for archives `https://codeload.github.com/OWNER/REPO/tar.gz/REF`, rather than api.github.com: this host may share its address with others, so the API can answer 403 rate limit exceeded.'

const programInstructions =
  "WebAssembly programs built for WASI (wasm32-wasi) run directly: `./prog.wasm ARGS`, `wasm prog.wasm ARGS` or `wasmtime prog.wasm ARGS`, with stdin, stdout, exit codes, the environment and the files under the working directory (up to 64 MiB, written back when the program exits). There is no C or Rust compiler: write WebAssembly text and assemble it with `wat2wasm prog.wat` (writes prog.wasm; flat or folded instructions, memory, data, globals and imports such as WASI's `fd_write`), rather than writing module bytes by hand, or download the .wasm file. `wasm --invoke NAME FILE ARGS` calls one exported function and prints its result. Python 3 runs on Pyodide (CPython compiled to WebAssembly, loaded on first use): `python3 script.py ARGS`, `python3 -c CODE`, `python3 -m MODULE` and stdin work on the files under the working directory and /tmp, numpy, pandas and the other packages Pyodide ships load when imported, and `pip install PKG` installs pure-Python wheels for the rest of the session. Python has no network access (urllib, requests and sockets fail), so download files with curl first and read them from Python."

/** Model-facing notes on the shell's git, GitHub, WebAssembly, and Python support. */
export const instructions =
  gitInstructions + ' ' + githubFileInstructions + ' ' + programInstructions

function budgeted(
  fs: FileSystem.FileSystem,
  limit: number,
  budget: { used: number; refused: boolean },
): FileSystem.FileSystem {
  const charge = () => {
    if (++budget.used <= limit) return
    budget.refused = true
    throw new Shell.LimitError(
      'too many file operations (limit ' + limit + '); search a narrower path',
    )
  }
  return {
    stat: (path) => (
      charge(),
      devices.has(path)
        ? Promise.resolve({ kind: 'file', size: 0, mtime: 0, mode: 0o666 })
        : fs.stat(path)
    ),
    read: (path) => (charge(), devices.has(path) ? Promise.resolve(device(path)) : fs.read(path)),
    write: (path, data, append) => (
      charge(),
      devices.has(path) ? Promise.resolve() : fs.write(path, data, append)
    ),
    list: (path) => (
      charge(),
      path === '/dev'
        ? fs
            .list(path)
            .catch(() => [])
            .then((names) =>
              [...new Set([...names, ...[...devices].map((name) => name.slice(5))])].sort(),
            )
        : fs.list(path)
    ),
    mkdir: (path) => (charge(), fs.mkdir(path)),
    remove: (path) => (charge(), fs.remove(path)),
    rename: (from, to) => (charge(), fs.rename(from, to)),
    ...(fs.chmod
      ? { chmod: (path: string, mode: number) => (charge(), fs.chmod!(path, mode)) }
      : {}),
    ...(fs.utimes
      ? { utimes: (path: string, mtime: number) => (charge(), fs.utimes!(path, mtime)) }
      : {}),
    ...(fs.symlink
      ? { symlink: (target: string, path: string) => (charge(), fs.symlink!(target, path)) }
      : {}),
    ...(fs.readlink ? { readlink: (path: string) => (charge(), fs.readlink!(path)) } : {}),
    ...(fs.lstat ? { lstat: (path: string) => (charge(), fs.lstat!(path)) } : {}),
    ...(fs.search
      ? { search: (dir: string, literals: string[]) => (charge(), fs.search!(dir, literals)) }
      : {}),
    ...(fs.excerpt
      ? { excerpt: (path: string, literals: string[]) => (charge(), fs.excerpt!(path, literals)) }
      : {}),
    ...(fs.matches
      ? {
          matches: (dir: string, literals: string[], ignoreCase: boolean) => (
            charge(),
            fs.matches!(dir, literals, ignoreCase)
          ),
        }
      : {}),
    ...(fs.writeMany
      ? {
          writeMany: (dirs: string[], files: FileSystem.NewFile[]) => {
            for (let index = 0; index < dirs.length + files.length; index++) charge()
            return fs.writeMany!(
              dirs,
              files.filter((file) => !devices.has(file.path)),
            )
          },
        }
      : {}),
  }
}

const devices = new Set(['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom'])

function device(path: string): Uint8Array {
  if (path === '/dev/null') return new Uint8Array(0)
  const bytes = new Uint8Array(1 << 20)
  if (path !== '/dev/zero')
    for (let i = 0; i < bytes.length; i += 65536)
      crypto.getRandomValues(bytes.subarray(i, i + 65536))
  return bytes
}

function compiles(): boolean {
  try {
    new (WebAssembly as unknown as { Module: new (bytes: Uint8Array) => unknown }).Module(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    )
    return true
  } catch {
    return false
  }
}

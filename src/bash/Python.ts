/**
 * Python 3 on Pyodide for the shell: options, the remote wire types, the Pyodide version, and
 * helpers that warm the runtime.
 *
 * @module
 */
export { preload, pyodideUrl, pyodideVersion } from './internal/commands/python.ts'

/** Options of the `python`, `python3`, `pip`, and `pip3` commands. */
export type Options = {
  /** Largest upload in bytes of one remote request. Defaults to 6 MiB. */
  batchBytes?: number
  /** Base URL of the Pyodide distribution. Defaults to the jsDelivr CDN of `pyodideVersion`. */
  indexURL?: string
  /** Loads the Pyodide runtime in place of the default loader. */
  load?: () => Promise<Pyodide>
  /** Largest workspace snapshot in bytes that one run copies into Python. Defaults to 64 MiB. */
  maxBytes?: number
  /** Most files in one workspace snapshot. Defaults to 20,000. */
  maxFiles?: number
  /** Identifier of the file mirror that a worker or remote keeps between runs. Defaults to a random UUID. */
  mirror?: string
  /** Runs Python on another host, such as a Durable Object, in place of a local Pyodide. */
  remote?: Remote
  /** Whether Node runs Pyodide on a worker thread. Defaults to true when the host has worker threads. */
  worker?: boolean
}

/** Pyodide runtime methods that the shell uses. */
export type Pyodide = {
  /** Emscripten file system of the runtime. */
  FS: PyodideFS
  /** Python globals of the runtime. */
  globals: { get(name: string): unknown }
  /** Loads packages by name. */
  loadPackage(names: string | string[], options?: Messages): Promise<unknown>
  /** Loads the packages that `code` imports. */
  loadPackagesFromImports(code: string, options?: Messages): Promise<unknown>
  /** Runs Python source and returns its last value. */
  runPython(code: string, options?: { globals?: unknown }): unknown
  /** Sets the buffer that interrupts running Python. */
  setInterruptBuffer(buffer: unknown): void
  /** Sets the stderr stream. */
  setStderr(options: Stream): void
  /** Sets the stdin source. */
  setStdin(options: { read(buffer: Uint8Array): number; isatty?: boolean }): void
  /** Sets the stdout stream. */
  setStdout(options: Stream): void
}

/** Emscripten file system methods that the shell uses. */
export type PyodideFS = {
  /** Returns whether `path` exists. */
  analyzePath(path: string): { exists: boolean }
  /** Changes the working directory. */
  chdir(path: string): void
  /** Returns whether `mode` is a directory. */
  isDir(mode: number): boolean
  /** Returns whether `mode` is a regular file. */
  isFile(mode: number): boolean
  /** Makes a directory and its parents. */
  mkdirTree(path: string): void
  /** Returns the entry names of a directory, with `.` and `..`. */
  readdir(path: string): string[]
  /** Returns the bytes of a file. */
  readFile(path: string): Uint8Array
  /** Removes an empty directory. */
  rmdir(path: string): void
  /** Returns the mode of an entry. */
  stat(path: string): { mode: number }
  /** Removes a file. */
  unlink(path: string): void
  /** Writes the bytes of a file. */
  writeFile(path: string, data: Uint8Array): void
}

/** Runs one Python request on another host. */
export type Remote = (request: Request, signal: AbortSignal) => Promise<Reply>

/** Result of one Python request. */
export type Reply = {
  /** Directories that the run made. */
  dirs: string[]
  /** Files that the run changed, as base64 bytes, or `null` for a removed file. */
  files: [string, string | null][]
  /** Files above the reply limit, with their sizes in bytes. The shell fetches them by range. */
  large?: [string, number][]
  /** Mirror identifier of the remote. */
  mirror?: string
  /** Kept files that the mirror does not hold. The shell sends them again. */
  missing?: string[]
  /** Files that did not fit in the reply. The shell fetches them in another request. */
  more?: string[]
  /** Exit status. */
  status: number
  /** Standard error of the run. */
  stderr: string
  /** Standard output of the run. */
  stdout: string
}

/** One Python run, file upload, or file download. */
export type Request = {
  /** Whether `files` append to the mirror's files. */
  append?: boolean
  /** Arguments of the program, from `sys.argv[1]`. */
  argv: string[]
  /** Working directory. */
  cwd: string
  /** Directories to make before the run. */
  dirs: string[]
  /** Environment variables. */
  env: Record<string, string>
  /** Files to download from the mirror in place of a run. */
  fetch?: string[]
  /** Script path when `kind` is `file`. */
  filename: string
  /** Files to place before the run, as path and base64 bytes. */
  files: [string, string][]
  /** Files that the mirror already holds and keeps for the run. */
  keep?: string[]
  /** Source of the program. */
  kind: 'code' | 'stdin' | 'file' | 'module' | 'pip' | 'version'
  /** Mirror identifier. Without it, the remote replaces `roots` on each run. */
  mirror?: string
  /** Command name, such as `python3`. */
  name: string
  /** Byte offset and length of a ranged download. */
  range?: [number, number]
  /** Directories that the run reads and writes. */
  roots: string[]
  /** Standard input of the run. */
  stdin: string
  /** Whether the request only uploads files. */
  sync?: boolean
  /** Code, module name, or pip arguments, by `kind`. */
  target: string
  /** Deadline of the run in milliseconds. */
  timeoutMs: number
}

type Messages = {
  messageCallback?: (message: string) => void
  errorCallback?: (message: string) => void
}

type Stream = { write(buffer: Uint8Array): number; isatty?: boolean }

const shipped: readonly (readonly [string, RegExp])[] = [
  ['matplotlib', /\b(matplotlib|pyplot|plt|chart|charts|plot|plots|graph)\b/],
  ['networkx', /\bnetworkx\b/],
  ['numpy', /\b(numpy|np)\b/],
  ['pandas', /\b(pandas|dataframe|pd)\b/],
  ['pillow', /\b(pillow|pil)\b/],
  ['scikit-learn', /\b(scikit-learn|sklearn)\b/],
  ['scipy', /\bscipy\b/],
  ['sympy', /\bsympy\b/],
]

/**
 * Returns the Pyodide packages that `text` mentions, for `preload`. Returns `undefined` when the
 * text mentions neither Python nor a package other than matplotlib.
 */
export function hint(text: string): readonly string[] | undefined {
  const lower = text.toLowerCase()
  const named = shipped.filter((entry) => entry[0] !== 'matplotlib' && entry[1].test(lower))
  if (!named.length && !/\b(python3?|pip3?|pyodide|py)\b|\.py\b/.test(lower)) return undefined
  return shipped.filter((entry) => entry[1].test(lower)).map((entry) => entry[0])
}

export { preload, pyodideUrl, pyodideVersion } from './internal/commands/python.ts'

export type Options = {
  batchBytes?: number
  indexURL?: string
  load?: () => Promise<Pyodide>
  maxBytes?: number
  maxFiles?: number
  mirror?: string
  remote?: Remote
  shared?: boolean
  worker?: boolean
}

export type Pyodide = {
  FS: PyodideFS
  globals: { get(name: string): unknown }
  loadPackage(names: string | string[], options?: Messages): Promise<unknown>
  loadPackagesFromImports(code: string, options?: Messages): Promise<unknown>
  runPython(code: string, options?: { globals?: unknown }): unknown
  setInterruptBuffer(buffer: unknown): void
  setStderr(options: Stream): void
  setStdin(options: { read(buffer: Uint8Array): number; isatty?: boolean }): void
  setStdout(options: Stream): void
}

export type PyodideFS = {
  analyzePath(path: string): { exists: boolean }
  chdir(path: string): void
  isDir(mode: number): boolean
  isFile(mode: number): boolean
  mkdirTree(path: string): void
  readdir(path: string): string[]
  readFile(path: string): Uint8Array
  rmdir(path: string): void
  stat(path: string): { mode: number }
  unlink(path: string): void
  writeFile(path: string, data: Uint8Array): void
}

export type Remote = (request: Request, signal: AbortSignal) => Promise<Reply>

export type Reply = {
  dirs: string[]
  files: [string, string | null][]
  large?: [string, number][]
  mirror?: string
  missing?: string[]
  more?: string[]
  status: number
  stderr: string
  stdout: string
}

export type Request = {
  append?: boolean
  argv: string[]
  cwd: string
  dirs: string[]
  env: Record<string, string>
  fetch?: string[]
  filename: string
  files: [string, string][]
  keep?: string[]
  kind: 'code' | 'stdin' | 'file' | 'module' | 'pip' | 'version'
  listing?: [string, string][]
  mirror?: string
  name: string
  range?: [number, number]
  roots: string[]
  stamps?: [string, string][]
  stdin: string
  sync?: boolean
  target: string
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

export function hint(text: string): readonly string[] | undefined {
  const lower = text.toLowerCase()
  const named = shipped.filter((entry) => entry[0] !== 'matplotlib' && entry[1].test(lower))
  if (!named.length && !/\b(python3?|pip3?|pyodide|py)\b|\.py\b/.test(lower)) return undefined
  return shipped.filter((entry) => entry[1].test(lower)).map((entry) => entry[0])
}

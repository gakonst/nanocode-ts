/**
 * Bash interpreter: the runner, its state, pipes, builtins, and the command contract.
 *
 * @module
 */
import { FsError, resolvePath, type FileSystem } from '../FileSystem.ts'
import { decode, masked, encode, rejoin } from './Fs.ts'
import {
  DECLARATIONS,
  SyntaxError as ParseError,
  ansiEscape,
  forced,
  parse,
  type Assign,
  type Command,
  type Part,
  type Pipeline,
  type Redirect,
  type Script,
  type Word,
  type AndOr,
} from './Syntax.ts'
import { functionText, wordText } from './Print.ts'
import { ArithError, evaluateArith, type ArithValue } from './Arith.ts'
import { escapeRegExp, globSource, hasGlob, posixRegExp } from './Text.ts'
import { TestError, evaluateTest, type TestArg } from './Condition.ts'

/** Resource limits of one shell. */
export type Limits = {
  /** Largest buffered pipe or command input in characters. */
  maxBufferLength: number
  /** Deepest nesting of function calls and sources. */
  maxCallDepth: number
  /** Most commands that one `exec` runs. */
  maxCommands: number
  /** Most file system operations that one `exec` performs. */
  maxFileOperations: number
  /** Most iterations of one loop. */
  maxLoopIterations: number
  /** Memory budget in bytes for commands that hold whole inputs. */
  maxMemoryBytes: number
  /** Most characters of stdout and of stderr that `exec` returns. Later output is cut. */
  maxOutputLength: number
  /** Deadline of one `exec` in milliseconds. */
  timeoutMs: number
}

export class LimitError extends Error {
  readonly status: number
  constructor(message: string, status = 126) {
    super(message)
    this.status = status
  }
}

export function megabytes(bytes: number): string {
  return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + ' MB'
}

export function budget(limits: Limits, bytes: number, what: string) {
  if (bytes > limits.maxMemoryBytes)
    throw new LimitError(
      what +
        ' needs about ' +
        megabytes(bytes) +
        ", which exceeds this host's memory budget of " +
        megabytes(limits.maxMemoryBytes),
    )
}

export function flatten(text: string): string {
  if (text.length > 256) text.charCodeAt(text.length >> 1)
  return text
}

export function append<T>(target: T[], items: readonly T[]) {
  for (let i = 0; i < items.length; i++) target.push(items[i]!)
}

/** Failure of a command. The shell writes the message to stderr and exits with `status`. */
export class CommandError extends Error {
  override readonly name = 'Command.CommandError'
  /** Exit status of the command. Defaults to 1. */
  readonly status: number
  constructor(message: string, status = 1) {
    super(message)
    this.status = status
  }
}

class FatalError extends Error {
  reported = false
  readonly status: number
  constructor(message: string, status = 1) {
    super(message)
    this.status = status
  }
}

export class ExitSignal {
  readonly status: number
  constructor(status: number) {
    this.status = status
  }
}

class ReturnSignal {
  readonly status: number
  constructor(status: number) {
    this.status = status
  }
}

class LoopSignal {
  readonly kind: 'break' | 'continue'
  readonly levels: number
  constructor(kind: 'break' | 'continue', levels: number) {
    this.kind = kind
    this.levels = levels
  }
}

/** Write to a pipe whose reader closed. Commands stop quietly when they catch it. */
export class PipeError extends Error {
  override readonly name = 'Command.PipeError'
  constructor() {
    super('Broken pipe')
  }
}

class KillSignal {
  readonly status: number
  constructor(status: number) {
    this.status = status
  }
}

const PIPE_HIGH = 1 << 20
const SPILL = 1 << 20
const PIPE_TAKE = 1 << 16
const WHOLE_INPUT = 16
const PIPE_SLICE = 1 << 20

export class Pipe {
  #chunks: string[] = []
  size = 0
  ended = false
  closed = false
  readonly limit: number
  readonly memory: number
  readonly signal: AbortSignal | undefined
  #reader: (() => void) | undefined
  #writer: (() => void) | undefined

  constructor(limit: number, signal?: AbortSignal, memory = Infinity) {
    this.limit = limit
    this.memory = memory
    this.signal = signal
    signal?.addEventListener('abort', () => this.#wake(), { once: true })
  }

  #wake() {
    const reader = this.#reader
    const writer = this.#writer
    this.#reader = this.#writer = undefined
    reader?.()
    writer?.()
  }

  #abort() {
    if (this.signal?.aborted)
      throw new LimitError(
        typeof this.signal.reason === 'string' ? this.signal.reason : 'execution aborted',
        124,
      )
  }

  push(text: string) {
    if (this.closed) throw new PipeError()
    flatten(text)
    if (this.size > 0 && this.size + text.length > this.limit)
      throw new LimitError('pipe buffer exceeded ' + this.limit + ' characters')
    this.#chunks.push(text)
    this.size += text.length
    const reader = this.#reader
    this.#reader = undefined
    reader?.()
  }

  async take(): Promise<string | null> {
    while (!this.#chunks.length) {
      if (this.ended || this.closed) return null
      this.#abort()
      await new Promise<void>((resolve) => (this.#reader = resolve))
    }
    const chunks = this.#chunks
    const head = chunks[0]
    if (head.length > PIPE_SLICE) {
      let cut = PIPE_SLICE
      const code = head.charCodeAt(cut - 1)
      if (code >= 0xd800 && code <= 0xdbff) cut++
      chunks[0] = head.slice(cut)
      this.size -= cut
      if (this.size <= PIPE_HIGH) {
        const writer = this.#writer
        this.#writer = undefined
        writer?.()
      }
      return head.slice(0, cut)
    }
    let end = 0
    let length = 0
    while (end < chunks.length && length < PIPE_TAKE) length += chunks[end++].length
    const text = end === 1 ? chunks[0] : chunks.slice(0, end).join('')
    if (end === chunks.length) this.#chunks = []
    else this.#chunks = chunks.slice(end)
    this.size -= length
    if (this.size <= PIPE_HIGH) {
      const writer = this.#writer
      this.#writer = undefined
      writer?.()
    }
    return text
  }

  async wait(strict: boolean) {
    while (this.size > PIPE_HIGH && !this.closed) {
      this.#abort()
      await new Promise<void>((resolve) => (this.#writer = resolve))
    }
    if (strict && this.closed) throw new PipeError()
  }

  end() {
    this.ended = true
    this.#wake()
  }

  close() {
    this.closed = true
    this.#chunks = []
    this.size = 0
    this.#wake()
  }
}

export class Output {
  #chunks: string[] = []
  length = 0
  truncated = false
  readonly limit: number
  readonly strict: boolean
  readonly discard: boolean
  #pipe: Pipe | undefined
  #spill: ((text: string) => Promise<void>) | undefined
  #pending: Promise<void> | undefined
  #failure: unknown

  constructor(limit: number, strict = true, discard = false) {
    this.limit = limit
    this.strict = strict
    this.discard = discard
  }

  static pipe(pipe: Pipe): Output {
    const out = new Output(pipe.limit)
    out.#pipe = pipe
    return out
  }

  static spill(limit: number, spill: (text: string) => Promise<void>): Output {
    const out = new Output(limit)
    out.#spill = spill
    return out
  }

  get piped(): boolean {
    return this.#pipe !== undefined
  }

  get closed(): boolean {
    return this.#pipe?.closed ?? false
  }

  get bounded(): boolean {
    return !this.#pipe && !this.#spill && !this.discard
  }

  get backlog(): boolean {
    return this.#pipe ? this.#pipe.size > PIPE_HIGH : this.#pending !== undefined
  }

  write(text: string) {
    if (!text || this.discard) return
    if (this.#pipe) {
      this.#pipe.push(text)
      return
    }
    if (this.length + text.length > this.limit) {
      if (this.strict) throw new LimitError('output exceeded ' + this.limit + ' characters')
      text = text.slice(0, this.limit - this.length)
      this.truncated = true
      if (!text) return
    }
    this.#chunks.push(flatten(text))
    this.length += text.length
    if (this.#spill && this.length >= SPILL) this.#flush(false)
  }

  #flush(all: boolean) {
    let text = this.#chunks.length === 1 ? this.#chunks[0] : this.#chunks.join('')
    let keep = ''
    const last = text.charCodeAt(text.length - 1)
    if (!all && last >= 0xd800 && last <= 0xdbff) {
      keep = text.slice(-1)
      text = text.slice(0, -1)
    }
    this.#chunks = keep ? [keep] : []
    this.length = keep.length
    if (!text) return
    const spill = this.#spill!
    const pending: Promise<void> = (this.#pending ?? Promise.resolve())
      .then(() => spill(text))
      .catch((error) => {
        this.#failure ??= error
      })
      .then(() => {
        if (this.#pending === pending) this.#pending = undefined
      })
    this.#pending = pending
  }

  async drain() {
    if (this.#pipe) return this.#pipe.wait(true)
    await this.#settled()
  }

  async settle() {
    if (this.#pipe) return this.#pipe.wait(false)
    if (this.#spill && this.length) this.#flush(true)
    await this.#settled()
  }

  async #settled() {
    if (this.#pending) await this.#pending
    if (this.#failure === undefined) return
    const failure = this.#failure
    this.#failure = undefined
    throw failure
  }

  text(): string {
    if (this.#chunks.length > 1) this.#chunks = [this.#chunks.join('')]
    return rejoin(this.#chunks[0] ?? '')
  }
}

export class Input {
  #text: string
  #pos = 0
  #scan = 0
  #pipe: Pipe | undefined
  #done = true

  constructor(text = '') {
    this.#text = text
  }

  static pipe(pipe: Pipe): Input {
    const input = new Input()
    input.#pipe = pipe
    input.#done = false
    return input
  }

  get ready(): boolean {
    return this.#done
  }

  #refuse(size: number): never {
    const pipe = this.#pipe!
    if (size > pipe.memory)
      throw new LimitError(
        'input of more than ' +
          megabytes(pipe.memory) +
          " exceeds this host's memory budget of " +
          megabytes(pipe.memory),
      )
    throw new LimitError('input exceeded ' + pipe.limit * WHOLE_INPUT + ' characters')
  }

  #pending(): never {
    throw new Error('stdin is an open pipe; read it with await stdin.text(), chunk() or readLine()')
  }

  async #more(): Promise<boolean> {
    if (this.#done) return false
    const chunk = await this.#pipe!.take()
    if (chunk === null) {
      this.#done = true
      return false
    }
    const rest = this.#text.length - this.#pos
    if (rest + chunk.length > Math.min(this.#pipe!.limit * WHOLE_INPUT, this.#pipe!.memory))
      this.#refuse(rest + chunk.length)
    this.#scan = Math.max(0, this.#scan - this.#pos)
    this.#text = rest ? this.#text.slice(this.#pos) + chunk : chunk
    this.#pos = 0
    return true
  }

  async fill() {
    if (this.#done || !this.#pipe) return
    const pipe = this.#pipe
    const cap = Math.min(pipe.limit * WHOLE_INPUT, pipe.memory)
    const parts = [this.#pos ? this.#text.slice(this.#pos) : this.#text]
    let size = parts[0].length
    for (let chunk = await pipe.take(); chunk !== null; chunk = await pipe.take()) {
      size += chunk.length
      if (size > cap) this.#refuse(size)
      parts.push(chunk)
    }
    this.#done = true
    this.#text = rejoin(parts.join(''))
    this.#pos = this.#scan = 0
  }

  async text(): Promise<string> {
    await this.fill()
    return this.read()
  }

  async chunk(): Promise<string | null> {
    if (this.#pos >= this.#text.length && !(await this.#more())) return null
    const text = this.#pos ? this.#text.slice(this.#pos) : this.#text
    this.#text = ''
    this.#pos = this.#scan = 0
    return this.#pipe ? rejoin(text) : text
  }

  async readLine(delimiter = '\n'): Promise<{ text: string; complete: boolean } | null> {
    const mark = delimiter === '' ? '\0' : delimiter
    for (;;) {
      const end = this.#text.indexOf(mark, Math.max(this.#pos, this.#scan))
      if (end >= 0) {
        const text = this.#text.slice(this.#pos, end)
        this.#pos = this.#scan = end + mark.length
        return { text: this.#pipe ? rejoin(text) : text, complete: true }
      }
      this.#scan = Math.max(this.#pos, this.#text.length - mark.length + 1)
      if (!(await this.#more())) break
    }
    if (this.#pos >= this.#text.length) return null
    const text = this.#text.slice(this.#pos)
    this.#text = ''
    this.#pos = this.#scan = 0
    return { text: this.#pipe ? rejoin(text) : text, complete: false }
  }

  async readChars(count: number): Promise<string> {
    while (this.#text.length - this.#pos < count && (await this.#more()));
    return this.chars(count)
  }

  close() {
    this.#pipe?.close()
    if (!this.#done) {
      this.#done = true
      this.#text = ''
      this.#pos = 0
    }
  }

  read(): string {
    if (!this.#done) this.#pending()
    const rest = this.#text.slice(this.#pos)
    this.#pos = this.#text.length
    return rest
  }

  line(delimiter = '\n'): { text: string; complete: boolean } | null {
    if (!this.#done) this.#pending()
    if (this.#pos >= this.#text.length) return null
    const end =
      delimiter === ''
        ? this.#text.indexOf('\0', this.#pos)
        : this.#text.indexOf(delimiter, this.#pos)
    if (end < 0) return { text: this.read(), complete: false }
    const text = this.#text.slice(this.#pos, end)
    this.#pos = end + Math.max(1, delimiter.length)
    return { text, complete: true }
  }

  chars(count: number): string {
    if (!this.#done && this.#text.length - this.#pos < count) this.#pending()
    const text = this.#text.slice(this.#pos, this.#pos + count)
    this.#pos += text.length
    return text
  }
}

export type Fd = { input?: Input; output?: Output; close?: () => void }

export type IO = { stdin: Input; stdout: Output; stderr: Output; fds?: Map<number, Fd> }

/** Context of one command invocation. */
export type CommandContext = {
  /** Arguments after the command name. */
  args: string[]
  /** Working directory. */
  cwd: string
  /** Exported environment variables. */
  env: Record<string, string>
  /** Runs a script in a subshell and returns its status and stdout. */
  exec(script: string, stdin?: string): Promise<{ status: number; stdout: string }>
  /** Network fetch of the shell. Absent when the shell has no network access. */
  fetch?: typeof fetch
  /** File system of the shell, with the umask applied. */
  fs: FileSystem
  /** Limits of the shell. */
  limits: Limits
  /** Name that invoked the command. */
  name: string
  /** Returns `path` resolved against `cwd`. */
  resolve(path: string): string
  /** Runs another command and returns its exit status. */
  run(argv: string[], stdin?: string): Promise<number>
  /** Aborts when the execution times out or is cancelled. */
  signal: AbortSignal
  /** Waits `ms` milliseconds, or until `signal` aborts. */
  sleep(ms: number): Promise<void>
  /** Standard error. */
  stderr: Output
  /** Standard input. */
  stdin: Input
  /** Standard output. */
  stdout: Output
  /** File mode creation mask, such as `0o022`. */
  umask: number
}

/** Command implementation. It returns the exit status, or nothing for 0. */
export type CommandHandler = (context: CommandContext) => Promise<number | void> | number | void

const STREAMS = new WeakSet<CommandHandler>()

const UNREAD = new Set([
  'basename',
  'chmod',
  'cp',
  'date',
  'dirname',
  'du',
  'echo',
  'false',
  'hostname',
  'id',
  'ln',
  'ls',
  'mkdir',
  'mktemp',
  'mv',
  'printf',
  'pwd',
  'readlink',
  'realpath',
  'rm',
  'rmdir',
  'seq',
  'sleep',
  'stat',
  'touch',
  'true',
  'uname',
  'which',
  'whoami',
  'yes',
])

/** Marks `handler` as one that reads stdin as it arrives. Other handlers start after their stdin is complete. */
export function streaming<T extends CommandHandler>(handler: T): T {
  STREAMS.add(handler)
  return handler
}

type Job = {
  id: number
  pid: number
  source: string
  controller: AbortController
  promise: Promise<number>
  status?: number
  signal?: number
}

type Shared = {
  steps: number
  processes: number
  pid: number
  failure: 'syntax' | 'limit' | undefined
  temporaries: string[]
  flushes: (() => Promise<void>)[]
  started: number
  running: Set<Promise<number>>
}

export type ShellHost = {
  fs: FileSystem
  commands: Map<string, CommandHandler>
  fetch?: typeof fetch
  limits: Limits
}

type Frame = Map<
  string,
  {
    value?: string[]
    map?: Map<string, string>
    ref?: string
    exported: boolean
    readonly: boolean
    integer: boolean
  }
>

class ExpansionError extends Error {}

export class State {
  vars = new Map<string, string[]>()
  exported = new Set<string>()
  integers = new Set<string>()
  functions = new Map<string, Command>()
  frames: Frame[] = []
  maps = new Map<string, Map<string, string>>()
  refs = new Map<string, string>()
  sources = new Map<string, string>()
  readonly = new Set<string>()
  jobs = new Map<number, Job>()
  cases = new Map<string, 'l' | 'u'>()
  stack: string[] = []
  traps = new Map<string, string>()
  shopt = new Set<string>()
  positional: string[] = []
  arg0 = 'bash'
  optind = 1
  optpos = 1
  cwd = '/'
  umask = 0o022
  status = 0
  options = {
    errexit: false,
    nounset: false,
    pipefail: false,
    xtrace: false,
    noglob: false,
    noclobber: false,
  }

  clone(): State {
    const state = new State()
    for (const [name, value] of this.vars) state.vars.set(name, value.slice())
    for (const [name, map] of this.maps) state.maps.set(name, new Map(map))
    state.refs = new Map(this.refs)
    state.jobs = new Map(this.jobs)
    state.sources = new Map(this.sources)
    state.readonly = new Set(this.readonly)
    state.cases = new Map(this.cases)
    state.stack = [...this.stack]
    state.shopt = new Set(this.shopt)
    state.arg0 = this.arg0
    state.optind = this.optind
    state.optpos = this.optpos
    state.exported = new Set(this.exported)
    state.integers = new Set(this.integers)
    state.functions = new Map(this.functions)
    state.positional = [...this.positional]
    state.cwd = this.cwd
    state.umask = this.umask
    state.status = this.status
    state.options = { ...this.options }
    return state
  }
}

type Piece = { text: string; quoted: boolean; split: boolean } | { split: 'break' }

const BRACE_LIMIT = 100_000

const LINES: string[] = []

function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, '\\$&')
}

function message(error: unknown): string {
  if (error instanceof FsError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

type Item = { c: string } | { p: Part }

function braces(items: Item[], count: { n: number }): Item[][] {
  for (let i = 0; i < items.length; i++) {
    const open = items[i]
    if (!('c' in open) || open.c !== '{') continue
    let depth = 0
    let end = -1
    const commas: number[] = []
    for (let j = i; j < items.length; j++) {
      const item = items[j]
      if (!('c' in item)) continue
      if (item.c === '{') depth++
      else if (item.c === '}') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      } else if (item.c === ',' && depth === 1) commas.push(j)
    }
    if (end < 0) return [items]
    const prefix = items.slice(0, i)
    const suffix = items.slice(end + 1)
    let alternatives: Item[][] | undefined
    if (commas.length) {
      const bounds = [i, ...commas, end]
      alternatives = bounds.slice(1).map((bound, k) => items.slice(bounds[k] + 1, bound))
    } else {
      const inner = items.slice(i + 1, end)
      if (inner.every((item) => 'c' in item)) {
        const text = inner.map((item) => (item as { c: string }).c).join('')
        const numeric = text.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/)
        const letters = text.match(/^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/)
        if (numeric || letters) {
          const values: string[] = []
          if (numeric) {
            const [from, to] = [Number(numeric[1]), Number(numeric[2])]
            const step = Math.abs(Number(numeric[3] ?? 1)) || 1
            const width =
              /^-?0\d/.test(numeric[1]) || /^-?0\d/.test(numeric[2])
                ? Math.max(numeric[1].length, numeric[2].length)
                : 0
            for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) {
              values.push(
                width
                  ? n < 0
                    ? '-' + String(-n).padStart(width - 1, '0')
                    : String(n).padStart(width, '0')
                  : String(n),
              )
              if (values.length > BRACE_LIMIT) throw new LimitError('brace expansion too large')
            }
          } else {
            const [from, to] = [letters![1].charCodeAt(0), letters![2].charCodeAt(0)]
            const step = Math.abs(Number(letters![3] ?? 1)) || 1
            for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step)
              values.push(String.fromCharCode(n))
          }
          alternatives = values.map((value) => [{ c: value }])
        }
      }
    }
    if (!alternatives) continue
    const result: Item[][] = []
    for (const alternative of alternatives) {
      for (const expanded of braces([...prefix, ...alternative, ...suffix], count)) {
        if (++count.n > BRACE_LIMIT) throw new LimitError('brace expansion too large')
        result.push(expanded)
      }
    }
    return result
  }
  return [items]
}

function braceExpand(word: Word): Word[] {
  if (!word.some((part) => part.type === 'text' && !part.quoted && part.value.includes('{')))
    return [word]
  const items: Item[] = []
  for (const part of word) {
    if (part.type === 'text' && !part.quoted) for (const c of part.value) items.push({ c })
    else items.push({ p: part })
  }
  const expanded = braces(items, { n: 0 })
  if (expanded.length === 1 && expanded[0] === items) return [word]
  return expanded.map((list) => {
    const parts: Part[] = []
    for (const item of list) {
      const last = parts[parts.length - 1]
      if ('c' in item) {
        if (last?.type === 'text' && !last.quoted) last.value += item.c
        else parts.push({ type: 'text', value: item.c, quoted: false })
      } else parts.push(item.p)
    }
    return parts
  })
}

export class Runner {
  state: State
  readonly host: ShellHost
  readonly signal: AbortSignal
  readonly #shared: Shared
  #deferred: { path: string; body: Script }[] = []
  #ignored = false
  #depth = 0
  #condition = 0
  #substitution: number | undefined
  #trapping = false

  constructor(host: ShellHost, state: State, signal: AbortSignal, shared?: Shared) {
    this.host = host
    this.state = state
    this.signal = signal
    this.#shared = shared ?? {
      steps: 0,
      processes: 0,
      pid: 1000,
      failure: undefined,
      temporaries: [],
      flushes: [],
      started: Date.now(),
      running: new Set(),
    }
  }

  get failure(): 'syntax' | 'limit' | undefined {
    return this.#shared.failure
  }

  set failure(value: 'syntax' | 'limit' | undefined) {
    this.#shared.failure = value
  }

  get temporaries(): string[] {
    return this.#shared.temporaries
  }

  get flushes(): (() => Promise<void>)[] {
    return this.#shared.flushes
  }

  fork(state: State, signal = this.signal): Runner {
    const runner = new Runner(this.host, state, signal, this.#shared)
    runner.#depth = this.#depth
    runner.#condition = this.#condition
    return runner
  }

  async isolated(run: () => Promise<number>, io?: IO): Promise<number> {
    let status: number
    try {
      status = await run()
    } catch (error) {
      if (
        error instanceof ExitSignal ||
        error instanceof ReturnSignal ||
        error instanceof KillSignal
      )
        status = error.status
      else if (error instanceof PipeError) status = 141
      else if (error instanceof FatalError && io) {
        if (!error.reported) io.stderr.write('bash: ' + error.message + '\n')
        status = 1
      } else throw error
    }
    return io && this.state.traps.has('EXIT') ? await this.exitTrap(io, status) : status
  }

  check() {
    if (this.signal.aborted) {
      const reason = this.signal.reason
      if (reason instanceof KillSignal) throw reason
      throw new LimitError(typeof reason === 'string' ? reason : 'execution aborted', 124)
    }
    if (++this.#shared.steps > this.host.limits.maxCommands)
      throw new LimitError(`too many commands (limit ${this.host.limits.maxCommands})`)
  }

  enter() {
    if (++this.#depth > this.host.limits.maxCallDepth) {
      this.#depth--
      throw new LimitError(`maximum call depth exceeded (limit ${this.host.limits.maxCallDepth})`)
    }
  }

  leave() {
    this.#depth--
  }

  buffer(): Output {
    return new Output(this.host.limits.maxBufferLength)
  }

  resolve(path: string): string {
    return resolvePath(this.state.cwd, path)
  }

  get(name: string): string | undefined {
    return this.state.vars.get(name)?.[0]
  }

  target(name: string): string {
    if (!this.state.refs.size) return name
    for (let i = 0; i < 8 && this.state.refs.has(name); i++) name = this.state.refs.get(name)!
    return name
  }

  set(name: string, value: string | string[]) {
    if (this.state.refs.size) {
      name = this.target(name)
      const element = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(name)
      if (element && typeof value === 'string') {
        if (this.state.readonly.has(element[1]))
          throw new FatalError(element[1] + ': readonly variable')
        const map = this.state.maps.get(element[1])
        if (map) map.set(element[2], value)
        else {
          const array = (this.state.vars.get(element[1]) ?? []).slice()
          const index = Number(
            evaluateArith(element[2], { get: (n) => this.get(n) ?? '', set: () => undefined }),
          )
          array[index < 0 ? array.length + index : index] = value
          this.state.vars.set(element[1], array)
        }
        return
      }
    }
    if (this.state.readonly.has(name)) throw new FatalError(name + ': readonly variable')
    this.state.vars.set(name, typeof value === 'string' ? [value] : value)
  }

  async exitTrap(io: IO, status: number): Promise<number> {
    const action = this.state.traps.get('EXIT')
    if (action === undefined) return status
    this.state.traps.delete('EXIT')
    this.state.status = status
    try {
      await this.script(parse(action), io)
    } catch (error) {
      if (error instanceof ExitSignal) return error.status
      if (
        !(
          error instanceof ReturnSignal ||
          error instanceof LoopSignal ||
          error instanceof ParseError
        )
      )
        throw error
    }
    return status
  }

  async jobs() {
    while (this.#shared.running.size) await Promise.allSettled([...this.#shared.running])
  }

  background(item: AndOr, io: IO) {
    const controller = new AbortController()
    const runner = this.fork(this.state.clone(), AbortSignal.any([this.signal, controller.signal]))
    const pid = ++this.#shared.pid
    let id = 1
    for (const job of this.state.jobs.values()) if (job.id >= id) id = job.id + 1
    const stdio: IO = { stdin: new Input(), stdout: io.stdout, stderr: io.stderr, fds: io.fds }
    const job: Job = { id, pid, source: item.source ?? '', controller, promise: Promise.resolve(0) }
    job.promise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return guard(runner, stdio, () => runner.isolated(() => runner.andOr(item, stdio)))
    })()
      .catch((error) => {
        stdio.stderr.write('bash: ' + message(error) + '\n')
        return 1
      })
      .then((status) => {
        job.status = status
        this.#shared.running.delete(job.promise)
        return status
      })
    this.#shared.running.add(job.promise)
    this.state.jobs.set(pid, job)
    this.state.vars.set('!', [String(pid)])
  }

  named(name: string): string | undefined {
    const element = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]$/.exec(name)
    return element ? this.state.vars.get(element[1]!)?.[Number(element[2])] : this.get(name)
  }

  coproc(name: string, run: (runner: Runner, stdio: IO) => Promise<number>, io: IO): number {
    const controller = new AbortController()
    const runner = this.fork(this.state.clone(), AbortSignal.any([this.signal, controller.signal]))
    const pid = ++this.#shared.pid
    let id = 1
    for (const job of this.state.jobs.values()) if (job.id >= id) id = job.id + 1
    const input = new Pipe(this.host.limits.maxBufferLength, this.signal)
    const output = new Pipe(this.host.limits.maxBufferLength, this.signal)
    const stdio: IO = {
      stdin: Input.pipe(input),
      stdout: Output.pipe(output),
      stderr: io.stderr,
      fds: io.fds,
    }
    const job: Job = { id, pid, source: 'coproc ' + name, controller, promise: Promise.resolve(0) }
    job.promise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return guard(runner, stdio, () => runner.isolated(() => run(runner, stdio)))
    })()
      .catch((error) => {
        io.stderr.write('bash: ' + message(error) + '\n')
        return 1
      })
      .then((status) => {
        output.end()
        job.status = status
        this.#shared.running.delete(job.promise)
        return status
      })
    this.#shared.running.add(job.promise)
    this.state.jobs.set(pid, job)
    this.state.vars.set('!', [String(pid)])
    const fds = new Map(io.fds ?? [])
    let read = 63
    while (fds.has(read)) read--
    let write = read - 1
    while (fds.has(write)) write--
    fds.set(read, { input: Input.pipe(output) })
    fds.set(write, { output: Output.pipe(input), close: () => input.end() })
    io.fds = fds
    this.state.vars.set(name, [String(read), String(write)])
    this.state.vars.set(name + '_PID', [String(pid)])
    return 0
  }

  job(id: string): Job | undefined {
    const jobs = [...this.state.jobs.values()].sort((a, b) => a.id - b.id)
    if (id === '%%' || id === '%+' || id === '%') return jobs[jobs.length - 1]
    if (id === '%-') return jobs[jobs.length - 2]
    if (/^%\d+$/.test(id)) return jobs.find((job) => job.id === Number(id.slice(1)))
    if (id.startsWith('%'))
      return jobs.find((job) => job.source.startsWith(id.slice(id[1] === '?' ? 2 : 1)))
    return /^\d+$/.test(id) ? this.state.jobs.get(Number(id)) : undefined
  }

  reap(job: Job, io: IO) {
    if (
      job.signal &&
      job.signal !== 2 &&
      job.signal !== 13 &&
      job.signal !== 15 &&
      this.state.jobs.has(job.pid)
    )
      io.stderr.write(
        'bash: line ' +
          (this.get('LINENO') ?? '1') +
          ': ' +
          job.pid +
          ' ' +
          (SIGNAL_NAMES[job.signal] ?? 'Killed').padEnd(24) +
          job.source +
          '\n',
      )
    this.state.jobs.delete(job.pid)
  }

  async cleanup() {
    for (const flush of this.flushes.splice(0)) await flush()
    for (const path of this.temporaries.splice(0))
      await this.host.fs.remove(path).catch(() => undefined)
  }

  environment(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of this.state.exported) {
      const value = this.state.vars.get(name)
      if (value) env[name] = value[0] ?? ''
    }
    return env
  }

  async script(script: Script, io: IO): Promise<number> {
    let status = this.state.status
    for (const item of script) {
      if (item.background) {
        this.background(item, io)
        status = this.state.status = 0
      } else status = await this.andOr(item, io)
    }
    return status
  }

  async andOr(item: AndOr, io: IO): Promise<number> {
    let status = await this.guarded(item.first, io, item.rest.length > 0)
    for (let i = 0; i < item.rest.length; i++) {
      const { op, pipeline } = item.rest[i]
      if ((op === '&&') === (status === 0))
        status = await this.guarded(pipeline, io, i < item.rest.length - 1)
    }
    return status
  }

  async guarded(pipeline: Pipeline, io: IO, guarded: boolean): Promise<number> {
    if (guarded) this.#condition++
    let status: number
    try {
      status = await this.pipeline(pipeline, io)
    } finally {
      if (guarded) this.#condition--
    }
    this.state.status = status
    if (guarded || this.#condition > 0) {
      this.#ignored = status !== 0
      return status
    }
    const compound =
      pipeline.commands.length === 1 &&
      pipeline.commands[0].type !== 'simple' &&
      !(pipeline.commands[0].type === 'group' && pipeline.commands[0].subshell)
    if (compound && this.#ignored && status !== 0) return status
    this.#ignored = false
    if (status !== 0 && !pipeline.negate) {
      const trap = this.state.traps.get('ERR')
      if (trap) {
        this.state.traps.delete('ERR')
        try {
          await this.script(parse(trap), io)
        } finally {
          this.state.traps.set('ERR', trap)
          this.state.status = status
        }
      }
      if (this.state.options.errexit) throw new ExitSignal(status)
    }
    return status
  }

  async condition(script: Script, io: IO): Promise<number> {
    this.#condition++
    try {
      return await this.script(script, io)
    } finally {
      this.#condition--
    }
  }

  async subshell(run: () => Promise<number>, io?: IO): Promise<number> {
    const saved = this.state
    this.state = saved.clone()
    try {
      return await this.isolated(run, io)
    } finally {
      this.state = saved
    }
  }

  async pipeline(pipeline: Pipeline, io: IO): Promise<number> {
    if (pipeline.timed) {
      const start = Date.now()
      try {
        return await this.pipeline({ negate: pipeline.negate, commands: pipeline.commands }, io)
      } finally {
        io.stderr.write(
          '\nreal\t' + ((Date.now() - start) / 1000).toFixed(3) + 's\nuser\t0.000s\nsys\t0.000s\n',
        )
      }
    }
    let status: number
    if (pipeline.commands.length === 1) {
      status = await this.command(pipeline.commands[0], io)
      const text = String(status)
      const current = this.state.vars.get('PIPESTATUS')
      if (current?.length !== 1 || current[0] !== text) this.state.vars.set('PIPESTATUS', [text])
    } else {
      const count = pipeline.commands.length
      const pipes: Pipe[] = []
      for (let i = 1; i < count; i++)
        pipes.push(
          new Pipe(this.host.limits.maxBufferLength, this.signal, this.host.limits.maxMemoryBytes),
        )
      const settled = await Promise.allSettled(
        pipeline.commands.map((command, i) => {
          const last = i === count - 1 && this.state.shopt.has('lastpipe')
          const runner = last ? this : this.fork(this.state.clone())
          const stage: IO = {
            stdin: i ? Input.pipe(pipes[i - 1]) : io.stdin,
            stdout: i < count - 1 ? Output.pipe(pipes[i]) : io.stdout,
            stderr: io.stderr,
            fds: io.fds,
          }
          return (
            last
              ? runner.command(command, stage)
              : runner.isolated(() => runner.command(command, stage))
          ).finally(() => {
            if (i < count - 1) pipes[i].end()
            if (i) pipes[i - 1].close()
          })
        }),
      )
      const statuses: number[] = []
      for (const result of settled) {
        if (result.status === 'rejected') throw result.reason
        statuses.push(result.value)
      }
      status = statuses[statuses.length - 1]
      this.state.vars.set('PIPESTATUS', statuses.map(String))
      if (this.state.options.pipefail)
        status = [...statuses].reverse().find((code) => code !== 0) ?? 0
    }
    return pipeline.negate ? Number(status === 0) : status
  }

  async command(command: Command, io: IO): Promise<number> {
    this.check()
    if (command.type === 'function') {
      this.state.functions.set(command.name, command.body)
      this.state.sources.set(command.name, this.state.vars.get('BASH_SOURCE')?.[0] ?? 'environment')
      return 0
    }
    if (!command.redirects.length) {
      try {
        return await (command.type === 'simple'
          ? this.simple(command, io)
          : this.compound(command, io))
      } catch (error) {
        if (!(error instanceof ExpansionError)) throw error
        io.stderr.write('bash: ' + error.message + '\n')
        return 1
      }
    }
    const mark = this.#deferred.length
    let redirected: { io: IO; flush(): Promise<void> }
    try {
      redirected = await this.redirect(command.redirects, io)
    } catch (error) {
      if (!(error instanceof FsError || error instanceof CommandError)) throw error
      io.stderr.write('bash: ' + message(error) + '\n')
      return 1
    }
    const head =
      command.type === 'simple' && command.words.length === 1 ? command.words[0] : undefined
    if (
      Array.isArray(head) &&
      head.length === 1 &&
      head[0].type === 'text' &&
      !head[0].quoted &&
      head[0].value === 'exec' &&
      command.redirects.length
    ) {
      Object.assign(io, redirected.io)
      this.flushes.push(redirected.flush)
      return 0
    }
    try {
      return await this.compound(command, redirected.io)
    } catch (error) {
      if (error instanceof ExpansionError) {
        io.stderr.write('bash: ' + error.message + '\n')
        return 1
      }
      if (error instanceof FatalError && !error.reported && command.redirects.length) {
        redirected.io.stderr.write('bash: ' + error.message + '\n')
        error.reported = true
      }
      throw error
    } finally {
      await redirected.flush()
      if (this.#deferred.length > mark)
        for (const { path, body } of this.#deferred.splice(mark)) {
          const text = decode(await this.host.fs.read(path).catch(() => new Uint8Array(0)))
          await this.subshell(() =>
            this.script(body, {
              stdin: new Input(text),
              stdout: io.stdout,
              stderr: io.stderr,
              fds: io.fds,
            }),
          )
        }
    }
  }

  async processPath(part: Part & { type: 'process' }, io: IO): Promise<string> {
    for (const dir of ['/dev', '/dev/fd'])
      if (!(await this.host.fs.stat(dir))) await this.host.fs.mkdir(dir)
    const path = '/dev/fd/' + (63 - (this.#shared.processes++ % 54))
    this.temporaries.push(path)
    if (part.output) {
      await this.host.fs.write(path, new Uint8Array(0))
      this.#deferred.push({ path, body: part.body })
      return path
    }
    this.enter()
    const out = this.buffer()
    try {
      await this.subshell(() =>
        this.script(part.body, { stdin: io.stdin, stdout: out, stderr: io.stderr, fds: io.fds }),
      )
    } finally {
      this.leave()
    }
    await this.host.fs.write(path, encode(out.text()))
    return path
  }

  async compound(command: Command, io: IO): Promise<number> {
    switch (command.type) {
      case 'simple':
        return this.simple(command, io)
      case 'if': {
        for (const clause of command.clauses) {
          if ((await this.condition(clause.cond, io)) === 0) return this.script(clause.body, io)
        }
        return command.otherwise ? this.script(command.otherwise, io) : 0
      }
      case 'while': {
        let status = 0
        for (let iteration = 1; ; iteration++) {
          this.iteration(iteration)
          const cond = await this.condition(command.cond, io)
          if ((cond === 0) === command.until) break
          const signal = await this.body(command.body, io)
          if (typeof signal === 'number') status = signal
          else if (signal === 'break') break
        }
        return status
      }
      case 'for': {
        let values: string[] = []
        if (command.items)
          for (const item of command.items) append(values, await this.fields(item, io))
        else values = [...this.state.positional]
        let status = 0
        if (command.select) {
          const menu = () => {
            const width = String(values.length).length
            io.stderr.write(
              values
                .map((value, index) => String(index + 1).padStart(width) + ') ' + value + '\n')
                .join(''),
            )
          }
          if (!values.length) return 0
          menu()
          for (let iteration = 1; ; iteration++) {
            this.iteration(iteration)
            io.stderr.write(this.get('PS3') ?? '#? ')
            const line = await io.stdin.readLine('\n')
            if (!line) {
              io.stdout.write('\n')
              return 1
            }
            this.set('REPLY', line.text)
            if (line.text.trim() === '') {
              menu()
              continue
            }
            const choice = /^\s*\d+\s*$/.test(line.text) ? Number(line.text) : 0
            this.set(command.name, choice >= 1 && choice <= values.length ? values[choice - 1] : '')
            const signal = await this.body(command.body, io)
            if (typeof signal === 'number') status = signal
            else if (signal === 'break') break
          }
          return status
        }
        for (let i = 0; i < values.length; i++) {
          this.iteration(i + 1)
          this.set(command.name, values[i])
          const signal = await this.body(command.body, io)
          if (typeof signal === 'number') status = signal
          else if (signal === 'break') break
        }
        return status
      }
      case 'cfor': {
        let status = 0
        await this.arith(command.init, io)
        for (let iteration = 1; ; iteration++) {
          this.iteration(iteration)
          if (command.cond.length && (await this.arith(command.cond, io)) === 0) break
          const signal = await this.body(command.body, io)
          if (typeof signal === 'number') status = signal
          else if (signal === 'break') break
          await this.arith(command.step, io)
        }
        return status
      }
      case 'case': {
        const value = await this.string(command.word, io)
        let status = 0
        let falling = false
        for (const item of command.items) {
          let matched = falling
          if (!matched) {
            for (const pattern of item.patterns) {
              if (compiled('^' + globbed(await this.pattern(pattern, io)) + '$').test(value)) {
                matched = true
                break
              }
            }
          }
          if (!matched) continue
          status = await this.script(item.body, io)
          if (item.next === 'break') return status
          falling = item.next === 'fall'
        }
        return status
      }
      case 'coproc': {
        const body = command.body
        return this.coproc(command.name, (runner, stdio) => runner.command(body, stdio), io)
      }
      case 'group': {
        if (!command.subshell) return this.script(command.body, io)
        const inner = { ...io }
        return this.subshell(() => this.script(command.body, inner), inner)
      }
      case 'arith':
        try {
          return (await this.arith(command.expr, io)) !== 0 ? 0 : 1
        } catch (error) {
          if (!(error instanceof ArithError)) throw error
          io.stderr.write('bash: ' + error.message + '\n')
          return 1
        }
      case 'test': {
        const args: TestArg[] = []
        for (const token of command.tokens) {
          if ('op' in token) args.push({ text: token.op, op: true })
          else {
            const pieces = await this.pieces(token.word, io)
            const text = joinPieces(pieces, 'text')
            args.push(
              pieces.some((piece) => piece.split !== 'break' && piece.quoted)
                ? {
                    text,
                    pattern: joinPieces(pieces, 'pattern'),
                    regex: joinPieces(pieces, 'regex'),
                  }
                : { text },
            )
          }
        }
        return this.test(args, true, io)
      }
    }
    return 0
  }

  iteration(count: number) {
    if (count > this.host.limits.maxLoopIterations)
      throw new LimitError(`too many loop iterations (limit ${this.host.limits.maxLoopIterations})`)
  }

  async body(script: Script, io: IO): Promise<number | 'break' | 'continue'> {
    try {
      return await this.script(script, io)
    } catch (error) {
      if (!(error instanceof LoopSignal)) throw error
      if (error.levels > 1) throw new LoopSignal(error.kind, error.levels - 1)
      return error.kind
    }
  }

  async test(args: TestArg[], double: boolean, io: IO): Promise<number> {
    try {
      const result = await evaluateTest(args, double, {
        stat: (path) => this.host.fs.stat(this.resolve(path)),
        lstat: (path) =>
          this.host.fs.lstat ? this.host.fs.lstat(this.resolve(path)) : Promise.resolve(null),
        isSet: (name) => {
          const element = name.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/)
          if (!element) return this.state.vars.has(name) || this.state.maps.has(name)
          const map = this.state.maps.get(element[1])
          if (map) return map.has(element[2])
          return this.state.vars.get(element[1])?.[Number(element[2])] !== undefined
        },
        match: (text, pattern) => compiled('^' + globbed(pattern) + '$').test(text),
        regex: (text, source) => {
          const match = text.match(posixRegExp(source, true))
          this.set('BASH_REMATCH', match ? [...match].map((group) => group ?? '') : [])
          return match !== null
        },
      })
      return result ? 0 : 1
    } catch (error) {
      if (!(error instanceof TestError || error instanceof globalThis.SyntaxError)) throw error
      io.stderr.write((double ? 'bash: ' : 'bash: test: ') + error.message + '\n')
      return 2
    }
  }

  async arith(word: Word, io: IO): Promise<ArithValue> {
    const source = await this.string(word, io)
    return evaluateArith(source, {
      get: (name, index) => {
        if (this.state.refs.size) name = this.target(name)
        const value = this.state.vars.get(name)
        if (value === undefined && this.state.options.nounset)
          throw new FatalError(name + ': unbound variable')
        return value?.[index ?? 0] ?? ''
      },
      set: (name, value, index) => {
        if (this.state.refs.size) name = this.target(name)
        if (index === undefined) this.set(name, String(value))
        else {
          const array = this.state.vars.get(name) ?? []
          array[index < 0 ? array.length + index : index] = String(value)
          this.set(name, array)
        }
      },
    })
  }

  async simple(command: Command & { type: 'simple' }, io: IO): Promise<number> {
    this.#substitution = undefined
    if (command.line !== undefined) {
      const line = (LINES[command.line] ??= String(command.line))
      if (this.state.vars.get('LINENO')?.[0] !== line) this.state.vars.set('LINENO', [line])
    }
    if (this.state.traps.size && this.state.traps.has('DEBUG')) await this.debugTrap(command, io)
    const head = command.words[0]
    if (
      head &&
      Array.isArray(head) &&
      head.length === 1 &&
      head[0].type === 'text' &&
      !head[0].quoted &&
      DECLARATIONS.has(head[0].value) &&
      !this.state.functions.has(head[0].value)
    ) {
      return this.declare(head[0].value, command.words.slice(1), io)
    }
    const argv: string[] = []
    for (const word of command.words)
      if (Array.isArray(word)) append(argv, await this.fields(word, io))
    if (!argv.length) {
      for (const assign of command.assigns) await this.assign(assign, io)
      return this.#substitution ?? 0
    }
    const saved: [string, string[] | undefined, boolean][] = []
    for (const assign of command.assigns) {
      saved.push([
        assign.name,
        this.state.vars.get(assign.name)?.slice(),
        this.state.exported.has(assign.name),
      ])
      await this.assign(assign, io)
      this.state.exported.add(assign.name)
    }
    try {
      if (this.state.options.xtrace) io.stderr.write('+ ' + argv.join(' ') + '\n')
      return await this.dispatch(argv, io)
    } finally {
      for (const [name, value, exported] of saved.reverse()) {
        if (value === undefined) this.state.vars.delete(name)
        else this.state.vars.set(name, value)
        if (!exported) this.state.exported.delete(name)
      }
    }
  }

  async assign(assign: Assign, io: IO) {
    const name = this.target(assign.name)
    const map = this.state.maps.get(name)
    if (assign.items) {
      if (this.state.readonly.has(name)) throw new FatalError(name + ': readonly variable')
      if (map) {
        if (!assign.append) map.clear()
        for (let i = 0; i < assign.items.length; i++) {
          const key = assign.keys?.[i]
          if (key) map.set(await this.string(key, io), await this.string(assign.items[i], io))
          else {
            const value = await this.string(assign.items[i], io)
            const next = assign.items[++i]
            map.set(value, next ? await this.string(next, io) : '')
          }
        }
        return
      }
      const entries: (number | string)[] = []
      for (let i = 0; i < assign.items.length; i++) {
        const key = assign.keys?.[i]
        if (key)
          entries.push(Number(await this.arith(key, io)), await this.string(assign.items[i], io))
        else for (const value of await this.fields(assign.items[i], io)) entries.push(value)
      }
      let size = 0
      for (const entry of entries) size += typeof entry === 'string' ? entry.length + 40 : 8
      budget(this.host.limits, size, name + ': an array of ' + entries.length + ' elements')
      const array = assign.append ? (this.state.vars.get(name) ?? []) : []
      let position = array.length
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (typeof entry === 'number') {
          position = entry
          array[position++] = entries[++i] as string
        } else array[position++] = entry
      }
      this.set(name, array)
      return
    }
    let value = assign.value ? await this.string(assign.value, io) : ''
    if (map) {
      if (this.state.readonly.has(name)) throw new FatalError(name + ': readonly variable')
      const key = assign.index ? await this.string(assign.index, io) : '0'
      map.set(key, assign.append ? (map.get(key) ?? '') + value : value)
      return
    }
    const letter = this.state.cases.get(name)
    if (letter) value = letter === 'l' ? value.toLowerCase() : value.toUpperCase()
    if (this.state.integers.has(name)) {
      const number = await this.arith(
        [
          {
            type: 'text',
            value: assign.append
              ? (this.get(name) || '0') + '+(' + (value || '0') + ')'
              : value || '0',
            quoted: true,
          },
        ],
        io,
      )
      value = String(number)
      this.set(name, value)
      return
    }
    if (assign.index) {
      const index = Number(await this.arith(assign.index, io))
      const array = this.state.vars.get(name) ?? []
      const position = index < 0 ? array.length + index : index
      array[position] = assign.append ? (array[position] ?? '') + value : value
      this.set(name, array)
      return
    }
    if (assign.append) {
      const current = this.state.vars.get(name)
      if (current && current.length > 1) {
        current.push(value)
        this.set(name, current)
        return
      }
      const before = current?.[0] ?? ''
      const next = before + value
      if (next.length >>> 20 !== before.length >>> 20)
        budget(this.host.limits, 4 * next.length, name)
      if (next.length > 4096 && Math.clz32(next.length) < Math.clz32(before.length)) flatten(next)
      this.set(name, next)
    } else this.set(name, value)
  }

  local(name: string) {
    const frame = this.state.frames[this.state.frames.length - 1]
    if (!frame || frame.has(name)) return
    const state = this.state
    frame.set(name, {
      value: state.vars.get(name),
      map: state.maps.get(name),
      ref: state.refs.get(name),
      exported: state.exported.has(name),
      readonly: state.readonly.has(name),
      integer: state.integers.has(name),
    })
  }

  async declare(builtin: string, items: (Word | Assign)[], io: IO): Promise<number> {
    const flags = new Set<string>()
    const targets: (Assign | string)[] = []
    for (const item of items) {
      if (!Array.isArray(item)) {
        targets.push(item)
        continue
      }
      for (const field of await this.fields(item, io)) {
        if (/^[-+][a-zA-Z]+$/.test(field) && !targets.length)
          for (const flag of field.slice(1)) flags.add(field[0] === '+' ? '+' + flag : flag)
        else targets.push(field)
      }
    }
    if (builtin === 'local' && !this.state.frames.length) {
      io.stderr.write('bash: local: can only be used in a function\n')
      return 1
    }
    const exporting = builtin === 'export' || flags.has('x')
    const scoped =
      builtin === 'local' ||
      ((builtin === 'declare' || builtin === 'typeset') &&
        !flags.has('g') &&
        this.state.frames.length > 0)
    if (!targets.length || flags.has('p')) {
      if (flags.has('f') || flags.has('F')) {
        for (const name of [...this.state.functions.keys()].sort())
          io.stdout.write(
            flags.has('F') || builtin === 'export'
              ? 'declare -f ' + name + '\n'
              : functionText(name, this.state.functions.get(name)!) + '\n',
          )
        return 0
      }
      const names = targets.length
        ? targets.map((target) => (typeof target === 'string' ? target : target.name))
        : [...this.state.vars.keys(), ...this.state.maps.keys()].sort()
      for (const name of names) {
        const map = this.state.maps.get(name)
        if (map) {
          io.stdout.write(
            'declare -A ' +
              name +
              '=(' +
              [...map]
                .map(([key, value]) => '[' + key + ']=' + JSON.stringify(value) + ' ')
                .join('') +
              ')\n',
          )
          continue
        }
        if (exporting && !targets.length && !this.state.exported.has(name)) continue
        const ref = this.state.refs.get(name)
        if (ref !== undefined) {
          io.stdout.write(
            'declare -n' +
              (this.state.readonly.has(name) ? 'r' : '') +
              ' ' +
              name +
              '=' +
              JSON.stringify(ref) +
              '\n',
          )
          continue
        }
        const value = this.state.vars.get(name)
        if (!value) continue
        const flag =
          (value.length > 1 ? 'a' : '') +
          (this.state.integers.has(name) ? 'i' : '') +
          (this.state.readonly.has(name) ? 'r' : '') +
          (this.state.exported.has(name) ? 'x' : '')
        const body =
          value.length > 1
            ? '(' +
              value
                .map((item, index) => '[' + index + ']=' + JSON.stringify(item))
                .filter(() => true)
                .join(' ') +
              ')'
            : JSON.stringify(value[0] ?? '')
        io.stdout.write('declare -' + (flag || '-') + ' ' + name + '=' + body + '\n')
      }
      return 0
    }
    let status = 0
    for (const target of targets) {
      let assign: Assign | undefined
      let name: string
      if (typeof target === 'string') {
        const eq = target.indexOf('=')
        name = eq < 0 ? target : target.slice(0, eq)
        if (eq >= 0)
          assign = {
            name,
            value: [{ type: 'text', value: target.slice(eq + 1), quoted: true }],
            append: false,
          }
      } else {
        assign = target
        name = target.name
      }
      if (flags.has('f') || flags.has('F')) {
        const body = this.state.functions.get(name)
        if (!body) status = 1
        else if (builtin === 'declare' || builtin === 'typeset')
          io.stdout.write(flags.has('F') ? name + '\n' : functionText(name, body) + '\n')
        continue
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        io.stderr.write('bash: ' + builtin + ': `' + name + "': not a valid identifier\n")
        status = 1
        continue
      }
      if (flags.has('n') && builtin !== 'export') {
        if (scoped) this.local(name)
        this.state.refs.set(
          name,
          assign?.value ? await this.string(assign.value, io) : (this.state.refs.get(name) ?? ''),
        )
        if (flags.has('r')) this.state.readonly.add(name)
        continue
      }
      if (
        !flags.has('p') &&
        this.state.refs.has(name) &&
        !(scoped && !this.state.frames[this.state.frames.length - 1]?.has(name))
      ) {
        const resolved = this.target(name)
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(resolved)) {
          if (assign) assign = { ...assign, name: resolved }
          name = resolved
        }
      }
      if (scoped && this.state.readonly.has(name)) {
        io.stderr.write('bash: ' + builtin + ': ' + name + ': readonly variable\n')
        status = 1
        continue
      }
      if (scoped) {
        const fresh = !this.state.frames[this.state.frames.length - 1]?.has(name)
        this.local(name)
        if (fresh) {
          this.state.refs.delete(name)
          this.state.maps.delete(name)
          if (!assign) this.state.vars.delete(name)
        }
      }
      if (flags.has('i')) this.state.integers.add(name)
      if (flags.has('l') || flags.has('u')) this.state.cases.set(name, flags.has('l') ? 'l' : 'u')
      if (flags.has('A') && !this.state.maps.has(name)) {
        this.state.maps.set(name, new Map())
        this.state.vars.delete(name)
      }
      if (assign) await this.assign(assign, io)
      else if (scoped && builtin === 'local') this.state.vars.delete(name)
      else if (flags.has('a') && !this.state.vars.has(name)) this.set(name, [])
      if (exporting) this.state.exported.add(name)
      if (flags.has('+x') || flags.has('n')) this.state.exported.delete(name)
      if (builtin === 'readonly' || flags.has('r')) this.state.readonly.add(name)
    }
    return status
  }

  async dispatch(argv: string[], io: IO, functions = true): Promise<number> {
    const [name, ...args] = argv
    const fn = functions ? this.state.functions.get(name) : undefined
    if (fn) return this.call(fn, args, io, name)
    const builtin = BUILTINS[name]
    if (builtin) {
      try {
        const status = await builtin.call(this, args, io)
        if (io.stdout.backlog) await io.stdout.settle()
        return status
      } catch (error) {
        if (
          error instanceof CommandError ||
          error instanceof FsError ||
          error instanceof ArithError
        ) {
          io.stderr.write('bash: ' + name + ': ' + message(error) + '\n')
          return error instanceof CommandError ? error.status : 1
        }
        throw error
      }
    }
    const handler = this.host.commands.get(name)
    if (handler) {
      const status = await this.external(name, handler, args, io)
      if (io.stdout.backlog) await io.stdout.settle()
      return status
    }
    if (name.includes('/')) {
      const path = this.resolve(name)
      const stat = await this.host.fs.stat(path)
      if (stat?.kind === 'file') {
        const wasm = this.host.commands.get('wasm')
        if (wasm && stat.size >= 8) {
          const head = await this.host.fs.read(path)
          if (head[0] === 0 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d)
            return this.external(name, wasm, [name, ...args], io)
        }
        return this.source(path, args, io, true, name)
      }
      io.stderr.write(
        'bash: ' + name + ': ' + (stat ? 'Is a directory' : 'No such file or directory') + '\n',
      )
      return stat ? 126 : 127
    }
    io.stderr.write('bash: ' + name + ': command not found' + missing(name) + '\n')
    return 127
  }

  async external(name: string, handler: CommandHandler, args: string[], io: IO): Promise<number> {
    const cwd = this.state.cwd
    const runner = this
    let env: Record<string, string> | undefined
    const context: CommandContext = {
      name,
      args,
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      cwd,
      get env() {
        return (env ??= runner.environment())
      },
      set env(value) {
        env = value
      },
      fs: masked(this.host.fs, this.state.umask),
      fetch: this.host.fetch,
      signal: this.signal,
      limits: this.host.limits,
      umask: this.state.umask,
      resolve: (path) => resolvePath(cwd, path),
      run: async (argv, stdin) => {
        this.check()
        return this.dispatch(argv, {
          stdin: stdin === undefined ? io.stdin : new Input(stdin),
          stdout: io.stdout,
          stderr: io.stderr,
        })
      },
      exec: async (script, stdin) => {
        this.check()
        const stdout = this.buffer()
        let parsed: Script
        try {
          parsed = parse(script)
        } catch (error) {
          if (!(error instanceof ParseError)) throw error
          io.stderr.write('bash: ' + error.message + '\n')
          return { status: 2, stdout: '' }
        }
        this.enter()
        try {
          const status = await this.subshell(() =>
            this.script(parsed, { stdin: new Input(stdin ?? ''), stdout, stderr: io.stderr }),
          )
          return { status, stdout: stdout.text() }
        } finally {
          this.leave()
        }
      },
      sleep: (ms) => this.sleep(ms),
    }
    try {
      if (
        !io.stdin.ready &&
        !STREAMS.has(handler) &&
        !(UNREAD.has(name) && handler === this.host.commands.get(name))
      )
        await io.stdin.fill()
      return (await handler(context)) ?? 0
    } catch (error) {
      if (
        error instanceof LimitError ||
        error instanceof ExitSignal ||
        error instanceof FatalError ||
        error instanceof PipeError ||
        error instanceof KillSignal
      )
        throw error
      if (this.signal.aborted)
        throw new LimitError(
          typeof this.signal.reason === 'string' ? this.signal.reason : 'execution aborted',
          124,
        )
      io.stderr.write(name + ': ' + message(error) + '\n')
      return error instanceof CommandError ? error.status : 1
    }
  }

  async sleep(ms: number) {
    if (ms > 0) {
      await new Promise<void>((resolve) => {
        const abort = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          this.signal.removeEventListener('abort', abort)
          resolve()
        }, ms)
        this.signal.addEventListener('abort', abort, { once: true })
      })
    }
    this.check()
  }

  async call(body: Command, args: string[], io: IO, name: string): Promise<number> {
    this.enter()
    const positional = this.state.positional
    const frame: Frame = new Map()
    const names = this.state.vars.get('FUNCNAME')
    const sources = this.state.vars.get('BASH_SOURCE')
    this.state.vars.set('FUNCNAME', [name, ...(names ?? [])])
    this.state.vars.set('BASH_SOURCE', [
      this.state.sources.get(name) ?? 'environment',
      ...(sources ?? []),
    ])
    this.state.positional = args
    this.state.frames.push(frame)
    const trap = this.state.traps.get('RETURN')
    try {
      return await this.command(body, io)
    } catch (error) {
      if (error instanceof ReturnSignal) return error.status
      throw error
    } finally {
      await this.returnTrap(trap, io)
      this.state.frames.pop()
      const state = this.state
      for (const [name, saved] of frame) {
        if (saved.value === undefined) state.vars.delete(name)
        else state.vars.set(name, saved.value)
        if (saved.map === undefined) state.maps.delete(name)
        else state.maps.set(name, saved.map)
        if (saved.ref === undefined) state.refs.delete(name)
        else state.refs.set(name, saved.ref)
        if (saved.exported) state.exported.add(name)
        else state.exported.delete(name)
        if (saved.readonly) state.readonly.add(name)
        else state.readonly.delete(name)
        if (saved.integer) state.integers.add(name)
        else state.integers.delete(name)
      }
      state.positional = positional
      if (names) state.vars.set('FUNCNAME', names)
      else state.vars.delete('FUNCNAME')
      if (sources) state.vars.set('BASH_SOURCE', sources)
      else state.vars.delete('BASH_SOURCE')
      this.leave()
    }
  }

  async returnTrap(before: string | undefined, io: IO) {
    const action = this.state.traps.get('RETURN')
    if (action === undefined || action === before || this.#trapping) return
    const status = this.state.status
    this.#trapping = true
    try {
      await this.script(parse(action), io)
    } catch (error) {
      if (!(error instanceof ReturnSignal || error instanceof ParseError)) throw error
    } finally {
      this.#trapping = false
      this.state.status = status
    }
  }

  async debugTrap(command: Command & { type: 'simple' }, io: IO) {
    const action = this.state.traps.get('DEBUG')
    if (action === undefined || this.#trapping || this.state.frames.length) return
    const text = [
      ...command.assigns.map(
        (assign) =>
          assign.name +
          (assign.append ? '+=' : '=') +
          (assign.value
            ? wordText(assign.value)
            : assign.items
              ? '(' + assign.items.map(wordText).join(' ') + ')'
              : ''),
      ),
      ...command.words.filter(Array.isArray).map((word) => wordText(word as Word)),
    ].join(' ')
    const status = this.state.status
    this.#trapping = true
    this.state.vars.set('BASH_COMMAND', [text])
    try {
      await this.script(parse(action), io)
    } catch (error) {
      if (!(error instanceof ParseError)) throw error
    } finally {
      this.#trapping = false
      this.state.status = status
    }
  }

  async source(
    path: string,
    args: string[],
    io: IO,
    isolated: boolean,
    arg0?: string,
    label?: string,
  ): Promise<number> {
    const text = decode(await this.host.fs.read(path))
    let script: Script
    try {
      script = parse(text)
    } catch (error) {
      if (!(error instanceof ParseError)) throw error
      io.stderr.write('bash: ' + path + ': ' + error.message + '\n')
      return 2
    }
    const run = async () => {
      this.enter()
      const positional = this.state.positional
      const sources = this.state.vars.get('BASH_SOURCE')
      if (args.length || isolated) this.state.positional = args
      if (arg0 !== undefined) this.state.arg0 = arg0
      this.state.vars.set('BASH_SOURCE', [arg0 ?? label ?? path, ...(sources ?? [])])
      const trap = this.state.traps.get('RETURN')
      try {
        return await this.script(script, io)
      } catch (error) {
        if (error instanceof ReturnSignal) return error.status
        throw error
      } finally {
        if (!isolated && args.length && this.state.positional === args)
          this.state.positional = positional
        await this.returnTrap(trap, io)
        if (sources) this.state.vars.set('BASH_SOURCE', sources)
        else this.state.vars.delete('BASH_SOURCE')
        this.leave()
      }
    }
    return isolated ? this.subshell(run, io) : run()
  }

  async redirect(redirects: Redirect[], io: IO): Promise<{ io: IO; flush(): Promise<void> }> {
    if (!redirects.length) return { io, flush: async () => undefined }
    const fds: [Input, Output, Output] = [io.stdin, io.stdout, io.stderr]
    let extra = io.fds
    const table = () => (extra === io.fds ? (extra = new Map(io.fds ?? [])) : extra!)
    const writes: Output[] = []
    const bad = (fd: number | string) => new CommandError(fd + ': Bad file descriptor')
    const device = (target: string) => {
      const match = /^\/dev\/fd\/(\d+)$/.exec(target)
      if (!match) return undefined
      const fd = Number(match[1])
      return fd <= 2 || extra?.has(fd) ? fd : undefined
    }
    const open = async (target: string, append: boolean, redirect?: Redirect): Promise<Output> => {
      if (target === '/dev/null') return new Output(0, false, true)
      if (target === '/dev/stdout') return fds[1]
      if (target === '/dev/stderr') return fds[2]
      const fd = device(target)
      if (fd !== undefined) {
        const out = fd === 1 || fd === 2 ? fds[fd] : extra?.get(fd)?.output
        if (!out) throw bad(fd)
        if (fd > 2) writes.push(out)
        return out
      }
      if (target === '') throw new CommandError('ambiguous redirect')
      const path = this.resolve(target)
      const stat = await this.host.fs.stat(path)
      if (stat?.kind === 'directory') throw new FsError('EISDIR', target)
      if (
        !append &&
        stat &&
        this.state.options.noclobber &&
        !(redirect && forced.has(redirect)) &&
        stat.kind === 'file'
      )
        throw new CommandError(target + ': cannot overwrite existing file')
      if (!append || !stat) await this.host.fs.write(path, new Uint8Array(0))
      if (!stat && this.state.umask !== 0o022 && this.host.fs.chmod)
        await this.host.fs.chmod(path, 0o666 & ~this.state.umask)
      const out = Output.spill(this.host.limits.maxBufferLength, (text) =>
        this.host.fs.write(path, encode(text), true),
      )
      writes.push(out)
      return out
    }
    const input = async (target: string): Promise<Input> => {
      if (target === '/dev/null') return new Input('')
      if (target === '/dev/stdin') return fds[0]
      const fd = device(target)
      if (fd !== undefined) {
        const found = fd === 0 ? fds[0] : extra?.get(fd)?.input
        if (!found) throw bad(fd)
        return found
      }
      return new Input(decode(await this.host.fs.read(this.resolve(target))))
    }
    const flush = async () => {
      for (const out of writes) await out.settle()
    }
    const allocate = (redirect: Redirect) => {
      if (redirect.name === undefined) return redirect.fd
      let fd = 10
      while (extra?.has(fd)) fd++
      this.set(redirect.name, String(fd))
      return fd
    }
    try {
      for (const redirect of redirects) {
        const op = redirect.op
        if (op === '<<' || op === '<<-' || op === '<<<') {
          const text =
            op !== '<<<'
              ? await this.string(redirect.body ?? [], io)
              : (await this.string(redirect.target, io)) + '\n'
          const fd = allocate(redirect) ?? 0
          if (fd === 0) fds[0] = new Input(text)
          else if (fd > 2) table().set(fd, { input: new Input(text) })
          continue
        }
        const target = await this.string(redirect.target, io)
        if (op === '<' || op === '<>') {
          const fd = allocate(redirect) ?? 0
          if (
            op === '<>' &&
            device(target) === undefined &&
            target !== '/dev/null' &&
            target !== '/dev/stdin'
          ) {
            const path = this.resolve(target)
            const stat = await this.host.fs.stat(path)
            if (stat?.kind === 'directory') throw new FsError('EISDIR', target)
            if (!stat) await this.host.fs.write(path, new Uint8Array(0))
            const source = await input(target)
            if (fd === 0) fds[0] = source
            else {
              const out = Output.spill(this.host.limits.maxBufferLength, (text) =>
                this.host.fs.write(path, encode(text), true),
              )
              writes.push(out)
              if (fd === 1 || fd === 2) fds[fd] = out
              else table().set(fd, { input: source, output: out })
            }
            continue
          }
          const source = await input(target)
          if (fd === 0) fds[0] = source
          else if (fd > 2) table().set(fd, { input: source })
          continue
        }
        if ((op === '>&' || op === '<&') && /^\d+-?$/.test(target)) {
          const fd = allocate(redirect) ?? (op === '>&' ? 1 : 0)
          const from = Number(target.replace('-', ''))
          const source: Fd | undefined =
            from === 0
              ? { input: fds[0] }
              : from === 1 || from === 2
                ? { output: fds[from] }
                : extra?.get(from)
          if (!source) throw bad(from)
          if (fd === 1 || fd === 2) {
            if (!source.output) throw bad(from)
            fds[fd] = source.output
            if (from > 2) writes.push(source.output)
          } else if (fd === 0) {
            if (!source.input) throw bad(from)
            fds[0] = source.input
          } else table().set(fd, source)
          if (target.endsWith('-') && from > 2) table().delete(from)
          continue
        }
        if ((op === '>&' || op === '<&') && target === '-') {
          const fd =
            redirect.name !== undefined
              ? Number(this.named(redirect.name) ?? -1)
              : (redirect.fd ?? (op === '>&' ? 1 : 0))
          if (fd === 1 || fd === 2) fds[fd] = new Output(0, false, true)
          else if (fd === 0) fds[0] = new Input('')
          else {
            const entry = extra?.get(fd)
            await entry?.output?.settle()
            entry?.close?.()
            table().delete(fd)
          }
          continue
        }
        if (
          op === '&>' ||
          op === '&>>' ||
          (op === '>&' && redirect.fd === null && redirect.name === undefined)
        ) {
          const out = await open(target, op === '&>>', redirect)
          fds[1] = out
          fds[2] = out
          continue
        }
        const fd = allocate(redirect) ?? 1
        const out = await open(target, op === '>>', redirect)
        if (fd === 1 || fd === 2) fds[fd] = out
        else if (fd === 0) fds[0] = new Input('')
        else table().set(fd, { output: out })
      }
    } catch (error) {
      await flush()
      throw error
    }
    return {
      io: { stdin: fds[0], stdout: fds[1], stderr: fds[2], ...(extra ? { fds: extra } : {}) },
      flush,
    }
  }

  async substitute(body: Script, io: IO): Promise<string> {
    const only =
      body.length === 1 && !body[0].rest.length && body[0].first.commands.length === 1
        ? body[0].first.commands[0]
        : undefined
    if (
      only?.type === 'simple' &&
      !only.words.length &&
      !only.assigns.length &&
      only.redirects.length === 1 &&
      only.redirects[0].op === '<'
    ) {
      const target = await this.string(only.redirects[0].target, io)
      try {
        const text = decode(await this.host.fs.read(this.resolve(target)))
        this.#substitution = 0
        return text.replace(/\n+$/, '')
      } catch (error) {
        io.stderr.write('bash: ' + message(error) + '\n')
        this.#substitution = 1
        return ''
      }
    }
    this.enter()
    const out = this.buffer()
    try {
      const status = await this.subshell(() =>
        this.script(body, { stdin: io.stdin, stdout: out, stderr: io.stderr, fds: io.fds }),
      )
      this.#substitution = status
      this.state.status = status
    } finally {
      this.leave()
    }
    const text = out.text()
    let end = text.length
    while (end && text.charCodeAt(end - 1) === 10) end--
    return end === text.length ? text : text.slice(0, end)
  }

  special(name: string): string[] | undefined {
    const state = this.state
    switch (name) {
      case '?':
        return [String(state.status)]
      case '#':
        return [String(state.positional.length)]
      case '$':
        return ['1']
      case '!':
        return state.vars.get('!') ?? ['']
      case '0':
        return [state.arg0]
      case '-':
        return [
          (state.options.errexit ? 'e' : '') +
            (state.options.nounset ? 'u' : '') +
            (state.options.xtrace ? 'x' : '') +
            'hBc',
        ]
      case 'RANDOM':
        return [String(Math.floor(Math.random() * 32768))]
      case 'SECONDS':
        return (
          state.vars.get(name) ?? [String(Math.floor((Date.now() - this.#shared.started) / 1000))]
        )
      case 'EPOCHSECONDS':
        return [String(Math.floor(Date.now() / 1000))]
      case 'EPOCHREALTIME':
        return [(Date.now() / 1000).toFixed(6)]
      case 'BASHPID':
        return ['1']
      case 'SRANDOM':
        return [String(Math.floor(Math.random() * 4294967296))]
    }
    if (/^\d+$/.test(name)) {
      const value = state.positional[Number(name) - 1]
      return value === undefined ? undefined : [value]
    }
    return state.vars.get(name)
  }

  quick(name: string): { values: string[]; list: boolean; joined: boolean } | undefined {
    if (name === '@' || name === '*' || this.state.maps.has(name) || this.state.refs.has(name))
      return undefined
    const value = this.special(name)
    if (value === undefined)
      return this.state.options.nounset ? undefined : { values: [''], list: false, joined: false }
    return { values: [value[0] ?? ''], list: false, joined: false }
  }

  async param(
    part: Part & { type: 'param' },
    io: IO,
  ): Promise<{ values: string[]; list: boolean; joined: boolean }> {
    let name = part.name
    if (part.op === 'bad') throw new ExpansionError(name + ': bad substitution')
    if (part.op === 'names') {
      const names = [...new Set([...this.state.vars.keys(), ...this.state.maps.keys()])]
        .filter((key) => key.startsWith(name))
        .sort()
      return { values: names, list: true, joined: false }
    }
    if (part.op === 'indirect' && part.index) {
      const key = await this.string(part.index, io)
      if (key === '@' || key === '*') {
        name = this.target(name)
        const map = this.state.maps.get(name)
        return {
          values: map ? [...map.keys()] : Object.keys(this.state.vars.get(name) ?? []),
          list: true,
          joined: key === '*',
        }
      }
    }
    if (part.op === 'indirect' && !part.index && this.state.refs.has(name))
      return { values: [this.state.refs.get(name)!], list: false, joined: false }
    if (part.op === 'indirect' || part.indirect) {
      name = this.special(this.target(name))?.[0] ?? ''
      const bracket = name.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/)
      if (bracket) {
        const map = this.state.maps.get(bracket[1])
        const values = map ? [...map.values()] : (this.state.vars.get(bracket[1]) ?? [])
        if (bracket[2] === '@' || bracket[2] === '*')
          return { values, list: true, joined: bracket[2] === '*' }
        if (map) return { values: [map.get(bracket[2]) ?? ''], list: false, joined: false }
        const index = Number(
          evaluateArith(bracket[2], { get: (n) => this.get(n) ?? '', set: () => undefined }),
        )
        return {
          values: [values[index < 0 ? values.length + index : index] ?? ''],
          list: false,
          joined: false,
        }
      }
      if (name !== '' && !/^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])$/.test(name))
        throw new ExpansionError(part.name + ': invalid indirect expansion')
    }
    let index = part.index ? await this.string(part.index, io) : undefined
    if (this.state.refs.size && this.state.refs.has(name)) {
      const resolved = this.target(name)
      const element = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(resolved)
      if (element && index === undefined) {
        name = element[1]
        index = element[2]
      } else name = resolved
    }
    const all = name === '@' || name === '*' || index === '@' || index === '*'
    const joined = name === '*' || index === '*'
    let values: string[] | undefined
    const map = this.state.maps.get(name)
    if (map) {
      if (index === '@' || index === '*') values = [...map.values()]
      else {
        const value = map.get(index ?? '0')
        values = value === undefined ? undefined : [value]
      }
    } else if (name === '@' || name === '*') values = this.state.positional
    else if (index === '@' || index === '*') values = this.state.vars.get(name)?.filter(() => true)
    else if (index !== undefined) {
      const array = this.state.vars.get(name)
      if (array) {
        let position = Number(await this.arith([{ type: 'text', value: index, quoted: true }], io))
        if (position < 0) position += array.length
        values = array[position] === undefined ? undefined : [array[position]]
      }
    } else {
      const value = this.special(name)
      values = value === undefined ? undefined : [value[0] ?? '']
    }
    if (part.op === 'length') {
      if (all) return { values: [String(values?.length ?? 0)], list: false, joined: false }
      return { values: [String([...(values?.[0] ?? '')].length)], list: false, joined: false }
    }
    const unset = values === undefined
    const empty = unset || (all ? values!.length === 0 : values![0] === '')
    const op = part.op
    if (['-', ':-', '=', ':=', '+', ':+', '?', ':?'].includes(op)) {
      const test = op.startsWith(':') ? empty : unset
      const kind = op.replace(':', '')
      if (kind === '+')
        return test
          ? { values: [''], list: false, joined: false }
          : { values: [await this.string(part.arg ?? [], io)], list: false, joined: false }
      if (!test) return { values: values!, list: all, joined }
      const value = await this.string(part.arg ?? [], io)
      if (kind === '=') this.set(name, value)
      if (kind === '?')
        throw new FatalError(name + ': ' + (value || 'parameter null or not set'), 127)
      return { values: [value], list: false, joined: false }
    }
    if (unset) {
      if (this.state.options.nounset && !all && !/^[@*#?$!-]$/.test(name))
        throw new FatalError(name + ': unbound variable', 127)
      return { values: all ? [] : [''], list: all, joined }
    }
    let result = values!
    if (op === '#' || op === '##' || op === '%' || op === '%%') {
      const pattern = await this.pattern(part.arg ?? [], io)
      if (!hasGlob(pattern)) {
        const literal = pattern.includes('\\') ? pattern.replace(/\\([\s\S])/g, '$1') : pattern
        result = result.map((value) =>
          op[0] === '#'
            ? value.startsWith(literal)
              ? value.slice(literal.length)
              : value
            : value.endsWith(literal)
              ? value.slice(0, value.length - literal.length)
              : value,
        )
        return { values: result, list: all, joined }
      }
      const source = globbed(pattern)
      const greedy = op.length === 2
      const whole = compiled('^(?:' + source + ')$')
      result = result.map((value) => {
        if (op[0] === '#') {
          for (
            let n = greedy ? value.length : 0;
            greedy ? n >= 0 : n <= value.length;
            n += greedy ? -1 : 1
          ) {
            if (whole.test(value.slice(0, n))) return value.slice(n)
          }
          return value
        }
        for (
          let n = greedy ? 0 : value.length;
          greedy ? n <= value.length : n >= 0;
          n += greedy ? 1 : -1
        ) {
          if (whole.test(value.slice(n))) return value.slice(0, n)
        }
        return value
      })
    } else if (op.startsWith('/')) {
      const pattern = await this.pattern(part.arg ?? [], io)
      const replacement = part.arg2 ? await this.string(part.arg2, io) : ''
      if (pattern !== '' && !hasGlob(pattern)) {
        const literal = pattern.includes('\\') ? pattern.replace(/\\([\s\S])/g, '$1') : pattern
        result = result.map((value) => {
          if (op === '//') return value.split(literal).join(replacement)
          if (op === '/#')
            return value.startsWith(literal) ? replacement + value.slice(literal.length) : value
          if (op === '/%')
            return value.endsWith(literal)
              ? value.slice(0, value.length - literal.length) + replacement
              : value
          const at = value.indexOf(literal)
          return at < 0
            ? value
            : value.slice(0, at) + replacement + value.slice(at + literal.length)
        })
        return { values: result, list: all, joined }
      }
      const source = globbed(pattern)
      const anchored =
        op === '/#' ? '^(?:' + source + ')' : op === '/%' ? '(?:' + source + ')$' : source
      if (source === '' && (op === '/#' || op === '/%'))
        result = result.map((value) => (op === '/#' ? replacement + value : value + replacement))
      else if (source !== '') {
        const regex = compiled(anchored, op === '//' ? 'g' : '')
        result = result.map((value) => value.replace(regex, () => replacement))
      }
    } else if (op === ':') {
      const offset = Number(await this.arith(part.arg ?? [], io))
      const length = part.arg2 ? Number(await this.arith(part.arg2, io)) : undefined
      const slice = <T>(items: T[]): T[] => {
        const start = offset < 0 ? Math.max(0, items.length + offset) : offset
        const end =
          length === undefined ? items.length : length < 0 ? items.length + length : start + length
        return items.slice(start, Math.max(start, end))
      }
      if (all) {
        const source = name === '@' || name === '*' ? ['bash', ...result] : result
        result = slice(source)
      } else result = [slice([...result[0]]).join('')]
    } else if (op === '^^' || op === ',,' || op === '^' || op === ',') {
      const source = part.arg?.length ? globSource(await this.pattern(part.arg, io)) : ''
      const allowed = source ? new RegExp('^(?:' + source + ')$') : undefined
      const convert = (c: string) =>
        allowed && !allowed.test(c) ? c : op[0] === '^' ? c.toUpperCase() : c.toLowerCase()
      result = result.map((value) =>
        op.length === 2
          ? [...value].map(convert).join('')
          : value
            ? convert(value.charAt(0)) + value.slice(1)
            : value,
      )
    } else if (op === '@Q' || op === '@K') result = result.map(shellQuote)
    else if (op === '@U') result = result.map((value) => value.toUpperCase())
    else if (op === '@u')
      result = result.map((value) => value.charAt(0).toUpperCase() + value.slice(1))
    else if (op === '@L') result = result.map((value) => value.toLowerCase())
    else if (op === '@A') result = [name + '=' + shellQuote(result[0] ?? '')]
    else if (op === '@a')
      result = [
        (map ? 'A' : (this.state.vars.get(name)?.length ?? 0) > 1 ? 'a' : '') +
          (this.state.integers.has(name) ? 'i' : '') +
          (this.state.readonly.has(name) ? 'r' : '') +
          (this.state.exported.has(name) ? 'x' : ''),
      ]
    else if (op === '@E')
      result = result.map((value) => {
        let out = ''
        for (let i = 0; i < value.length; i++) {
          if (value[i] !== '\\') out += value[i]
          else {
            const [text, length] = ansiEscape(value, i + 1)
            out += text
            i += length
          }
        }
        return out
      })
    return { values: result, list: all, joined }
  }

  async pieces(word: Word, io: IO): Promise<Piece[]> {
    const pieces: Piece[] = []
    for (const part of word) {
      switch (part.type) {
        case 'text':
          pieces.push({ text: part.value, quoted: part.quoted, split: false })
          break
        case 'tilde':
          pieces.push({
            text: part.user ? '/home/' + part.user : (this.get('HOME') ?? '/'),
            quoted: true,
            split: false,
          })
          break
        case 'param': {
          const { values, list, joined } =
            (part.op === '' &&
              part.index === undefined &&
              !part.indirect &&
              this.quick(part.name)) ||
            (await this.param(part, io))
          if (list && part.quoted && !joined) {
            values.forEach((value, index) => {
              if (index) pieces.push({ split: 'break' })
              pieces.push({ text: value, quoted: true, split: false })
            })
          } else {
            const separator = joined && part.quoted ? (this.get('IFS') ?? ' ').slice(0, 1) : ' '
            pieces.push({ text: values.join(separator), quoted: part.quoted, split: !part.quoted })
          }
          break
        }
        case 'command': {
          const text = await this.substitute(part.body, io)
          pieces.push({ text, quoted: part.quoted, split: !part.quoted })
          break
        }
        case 'arith': {
          const value = await this.arith(part.expr, io)
          pieces.push({ text: String(value), quoted: part.quoted, split: !part.quoted })
          break
        }
        case 'process':
          pieces.push({ text: await this.processPath(part, io), quoted: true, split: false })
          break
      }
    }
    return pieces
  }

  async string(word: Word, io: IO): Promise<string> {
    if (word.length === 1 && word[0].type === 'text') return word[0].value
    return joinPieces(await this.pieces(word, io), 'text')
  }

  async pattern(word: Word, io: IO): Promise<string> {
    return joinPieces(await this.pieces(word, io), 'pattern')
  }

  async fields(word: Word, io: IO): Promise<string[]> {
    if (word.length === 1) {
      const part = word[0]
      if (
        part.type === 'text' &&
        (part.quoted || (!part.value.includes('{') && !hasGlob(part.value)))
      )
        return part.quoted || part.value ? [part.value] : []
    }
    const out: string[] = []
    for (const expanded of braceExpand(word)) {
      const pieces = await this.pieces(expanded, io)
      const fields: { text: string; pattern: string; glob: boolean }[] = []
      let current = { text: '', pattern: '', glob: false, content: false }
      const flush = () => {
        if (current.content) fields.push(current)
        current = { text: '', pattern: '', glob: false, content: false }
      }
      const ifs = this.state.vars.get('IFS')?.[0] ?? ' \t\n'
      const other = splitter(ifs).other
      const split = splitter(ifs).regex
      for (const piece of pieces) {
        if (piece.split === 'break') {
          current.content = true
          flush()
          continue
        }
        if (piece.quoted) {
          current.text += piece.text
          current.pattern += escapeGlob(piece.text)
          current.content = true
        } else if (!piece.split || !split) {
          current.text += piece.text
          current.pattern += piece.text
          current.glob ||= hasGlob(piece.text)
          current.content ||= piece.text !== ''
        } else {
          const segments = piece.text.split(split)
          segments.forEach((segment, index) => {
            if (index > 0) {
              if (other && index < segments.length) current.content = true
              flush()
            }
            if (segment !== '') {
              current.text += segment
              current.pattern += segment
              current.glob ||= hasGlob(segment)
              current.content = true
            }
          })
          if (segments.length > 1 && segments[segments.length - 1] === '') current.content = false
        }
      }
      flush()
      for (const field of fields) {
        if (field.glob && !this.state.options.noglob) {
          const matches = await this.glob(field.pattern)
          if (matches.length) {
            append(out, matches)
            continue
          }
          if (this.state.shopt.has('nullglob')) continue
          if (this.state.shopt.has('failglob')) throw new CommandError('no match: ' + field.text)
        }
        out.push(field.text)
      }
    }
    return out
  }

  async glob(pattern: string): Promise<string[]> {
    const absolute = pattern.startsWith('/')
    const segments = pattern.split('/').filter(Boolean)
    const dot = this.state.shopt.has('dotglob')
    const star = this.state.shopt.has('globstar')
    const join = (base: string, name: string) =>
      base === '' ? name : base === '/' ? '/' + name : base + '/' + name
    let paths: string[] = [absolute ? '/' : '']
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const last = i === segments.length - 1
      const next: string[] = []
      if (star && segment === '**') {
        const walk = async (base: string) => {
          const dir = this.resolve(base || '.')
          if ((await this.host.fs.stat(dir))?.kind !== 'directory') return
          for (const name of (await this.host.fs.list(dir)).sort()) {
            if (name.startsWith('.') && !dot) continue
            const path = join(base, name)
            if ((await this.host.fs.stat(this.resolve(path)))?.kind === 'directory') {
              next.push(path)
              await walk(path)
            } else if (last) next.push(path)
          }
        }
        for (const base of paths) {
          if (!last) next.push(base)
          await walk(base)
        }
        paths = next
        if (!paths.length) break
        continue
      }
      for (const base of paths) {
        const dir = this.resolve(base || '.')
        if (!hasGlob(segment)) {
          const literal = segment.replace(/\\([\s\S])/g, '$1')
          const path = join(base, literal)
          if (
            last
              ? await this.host.fs.stat(this.resolve(path))
              : (await this.host.fs.stat(this.resolve(path)))?.kind === 'directory'
          )
            next.push(path)
          continue
        }
        const stat = await this.host.fs.stat(dir)
        if (stat?.kind !== 'directory') continue
        const regex = new RegExp('^' + globSource(segment, true) + '$')
        const hidden = segment.startsWith('.') || segment.startsWith('\\.')
        for (const name of await this.host.fs.list(dir)) {
          if (name.startsWith('.') && !hidden && !dot) continue
          if (!regex.test(name)) continue
          const path = join(base, name)
          if (!last && (await this.host.fs.stat(this.resolve(path)))?.kind !== 'directory') continue
          next.push(path)
        }
      }
      paths = next
      if (!paths.length) break
    }
    paths = paths.filter((path) => path !== '' && path !== '/')
    if (pattern.endsWith('/')) {
      const directories: string[] = []
      for (const path of paths)
        if ((await this.host.fs.stat(this.resolve(path)))?.kind === 'directory')
          directories.push(path + '/')
      paths = directories
    }
    return [...new Set(paths)].sort()
  }
}

const REGEXPS = new Map<string, RegExp>()

function compiled(source: string, flags = ''): RegExp {
  const key = flags + '/' + source
  let regex = REGEXPS.get(key)
  if (regex) return regex
  regex = new RegExp(source, flags)
  if (REGEXPS.size > 1024) REGEXPS.clear()
  REGEXPS.set(key, regex)
  return regex
}

const GLOBS = new Map<string, string>()

function globbed(pattern: string): string {
  let source = GLOBS.get(pattern)
  if (source !== undefined) return source
  source = globSource(pattern)
  if (GLOBS.size > 1024) GLOBS.clear()
  GLOBS.set(pattern, source)
  return source
}

const SPLITTERS = new Map<string, { regex: RegExp | undefined; other: string }>()

function splitter(ifs: string): { regex: RegExp | undefined; other: string } {
  let cached = SPLITTERS.get(ifs)
  if (cached) return cached
  const white = [...ifs].filter((c) => ' \t\n'.includes(c)).join('')
  const other = [...ifs].filter((c) => !' \t\n'.includes(c)).join('')
  const regex =
    ifs === ''
      ? undefined
      : new RegExp(
          other
            ? '[' +
                escapeRegExp(white) +
                ']*[' +
                escapeRegExp(other) +
                '][' +
                escapeRegExp(white) +
                ']*|[' +
                escapeRegExp(white || ' ') +
                ']+'
            : '[' + escapeRegExp(white) + ']+',
        )
  cached = { regex, other }
  if (SPLITTERS.size > 64) SPLITTERS.clear()
  SPLITTERS.set(ifs, cached)
  return cached
}

function shellQuote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value))
    return (
      "$'" +
      value
        .replace(/[\\']/g, '\\$&')
        .replace(
          /[\x00-\x1f\x7f]/g,
          (c) =>
            ({ '\n': '\\n', '\t': '\\t', '\r': '\\r' })[c] ??
            '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'),
        ) +
      "'"
    )
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function joinPieces(pieces: Piece[], mode: 'text' | 'pattern' | 'regex'): string {
  let out = ''
  for (const piece of pieces) {
    if (piece.split === 'break') out += ' '
    else if (mode === 'text' || !piece.quoted) out += piece.text
    else out += mode === 'pattern' ? escapeGlob(piece.text) : escapeRegExp(piece.text)
  }
  return out
}

type Builtin = (this: Runner, args: string[], io: IO) => Promise<number>

function count(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback
  if (!/^-?\d+$/.test(text)) throw new CommandError(text + ': numeric argument required', 2)
  return Number(text)
}

function readFields(text: string, names: number, ifs: string): string[] {
  const white = ifs.replace(/[^ \t\n]/g, '')
  const isWhite = (c: string) => white.includes(c)
  const isSep = (c: string) => ifs.includes(c)
  let pos = 0
  while (pos < text.length && isWhite(text[pos])) pos++
  const fields: string[] = []
  while (fields.length < names - 1 && pos < text.length) {
    let end = pos
    while (end < text.length && !isSep(text[end])) end++
    fields.push(text.slice(pos, end))
    pos = end
    while (pos < text.length && isWhite(text[pos])) pos++
    if (pos < text.length && isSep(text[pos]) && !isWhite(text[pos])) {
      pos++
      while (pos < text.length && isWhite(text[pos])) pos++
    }
  }
  let rest = text.slice(pos)
  let end = rest.length
  while (end > 0 && isWhite(rest[end - 1])) end--
  rest = rest.slice(0, end)
  if (pos < text.length || fields.length < names) fields.push(rest)
  return fields
}

const noop: Builtin = async () => 0

async function physical(fs: FileSystem, path: string): Promise<string> {
  if (!fs.readlink) return path
  const pending = path.split('/').filter(Boolean)
  const parts: string[] = []
  let hops = 0
  while (pending.length) {
    const part = pending.shift()!
    if (part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    const target = await fs.readlink('/' + [...parts, part].join('/'))
    if (target !== null && ++hops <= 40) {
      if (target.startsWith('/')) parts.length = 0
      pending.unshift(...target.split('/').filter(Boolean))
      continue
    }
    parts.push(part)
  }
  return '/' + parts.join('/')
}

const SIGNAL_NUMBERS: Record<string, number> = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  ILL: 4,
  TRAP: 5,
  ABRT: 6,
  BUS: 7,
  FPE: 8,
  KILL: 9,
  USR1: 10,
  SEGV: 11,
  USR2: 12,
  PIPE: 13,
  ALRM: 14,
  TERM: 15,
  CHLD: 17,
  CONT: 18,
  STOP: 19,
  TSTP: 20,
  WINCH: 28,
}

const SIGNAL_NAMES: Record<number, string> = {
  1: 'Hangup',
  2: 'Interrupt',
  3: 'Quit',
  6: 'Aborted',
  9: 'Killed',
  10: 'User defined signal 1',
  12: 'User defined signal 2',
  13: 'Broken pipe',
  14: 'Alarm clock',
  15: 'Terminated',
}

const SHELL_BUILTINS = new Set([
  'echo',
  'printf',
  'kill',
  'test',
  '[',
  'pwd',
  'read',
  'true',
  'false',
  'type',
  'command',
  'ulimit',
  'umask',
  'wait',
  'jobs',
  'fg',
  'bg',
  'help',
  'history',
  'times',
])

const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  'time',
  '{',
  '}',
  '!',
  '[[',
  ']]',
  'coproc',
])

export const BUILTINS: Record<string, Builtin> = {
  ':': noop,
  true: noop,
  false: async () => 1,
  async wait(args, io) {
    const ids = args.filter((arg) => !arg.startsWith('-'))
    if (args.includes('-n')) {
      const pending = (
        ids.length ? ids.map((id) => this.job(id)) : [...this.state.jobs.values()]
      ).filter((job): job is Job => job !== undefined && job.status === undefined)
      if (!pending.length) return 127
      const [job, status] = await Promise.race(
        pending.map((job) => job.promise.then((status) => [job, status] as const)),
      )
      this.reap(job, io)
      return status
    }
    if (!ids.length) {
      for (const job of [...this.state.jobs.values()]) {
        await job.promise
        this.reap(job, io)
      }
      return 0
    }
    let status = 0
    for (const id of ids) {
      const job = this.job(id)
      if (!job) {
        io.stderr.write(
          'bash: wait: ' +
            (id.startsWith('%')
              ? id + ': no such job'
              : 'pid ' + id + ' is not a child of this shell') +
            '\n',
        )
        status = 127
        continue
      }
      status = await job.promise
      this.reap(job, io)
    }
    return status
  },
  async jobs(args, io) {
    const pids = args.includes('-p')
    const long = args.includes('-l')
    const running = args.includes('-r')
    const stopped = args.includes('-s')
    const jobs = [...this.state.jobs.values()].sort((a, b) => a.id - b.id)
    jobs.forEach((job, index) => {
      if (
        stopped ||
        (running && job.status !== undefined) ||
        (job.status !== undefined && (job.signal === 2 || job.signal === 13 || job.signal === 15))
      )
        return
      if (pids) {
        io.stdout.write(job.pid + '\n')
        return
      }
      const mark = index === jobs.length - 1 ? '+' : index === jobs.length - 2 ? '-' : ' '
      const state =
        job.status === undefined
          ? 'Running'
          : job.signal
            ? (SIGNAL_NAMES[job.signal] ?? 'Killed')
            : job.status
              ? 'Exit ' + job.status
              : 'Done'
      io.stdout.write(
        '[' +
          job.id +
          ']' +
          mark +
          '  ' +
          (long ? job.pid + ' ' : '') +
          state.padEnd(24) +
          job.source +
          (job.status === undefined ? ' &' : '') +
          '\n',
      )
    })
    for (const job of jobs) if (job.status !== undefined && !pids) this.state.jobs.delete(job.pid)
    return 0
  },
  async kill(args, io) {
    if (args[0] === '-l' || args[0] === '-L') {
      const handler = this.host.commands.get('kill')
      return handler ? this.external('kill', handler, args, io) : 0
    }
    let signal = 15
    let i = 0
    const parse = (name: string): number => {
      if (/^\d+$/.test(name)) return Number(name)
      const upper = name.toUpperCase().replace(/^SIG/, '')
      const number = Object.entries(SIGNAL_NUMBERS).find(([key]) => key === upper)?.[1]
      if (number === undefined) throw new CommandError(name + ': invalid signal specification')
      return number
    }
    if (args[0] === '-s' || args[0] === '-n') {
      signal = parse(args[1] ?? '')
      i = 2
    } else if (args[0]?.startsWith('-') && args[0] !== '--' && args[0] !== '-') {
      signal = parse(args[0].slice(1))
      i = 1
    }
    if (args[i] === '--') i++
    const targets = args.slice(i)
    if (!targets.length)
      throw new CommandError(
        'usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]',
        2,
      )
    let status = 0
    for (const target of targets) {
      const job = this.job(target)
      if (job) {
        if (job.status !== undefined) {
          if (target.startsWith('%')) {
            io.stderr.write('bash: kill: ' + target + ': no such job\n')
            status = 1
          }
          continue
        }
        if (signal === 0 || signal === 18 || signal === 19 || signal === 20) continue
        job.signal = signal
        job.controller.abort(new KillSignal(128 + signal))
        continue
      }
      if (target === '1' || target === '$$') {
        if (
          signal === 0 ||
          signal === 18 ||
          signal === 19 ||
          signal === 20 ||
          signal === 13 ||
          signal === 17 ||
          signal === 28
        )
          continue
        throw new ExitSignal(128 + signal)
      }
      if (!/^-?\d+$/.test(target) && !target.startsWith('%')) {
        io.stderr.write('bash: kill: ' + target + ': arguments must be process or job IDs\n')
        status = 1
        continue
      }
      io.stderr.write(
        'bash: kill: ' +
          (target.startsWith('%')
            ? target + ': no such job'
            : '(' + target + ') - No such process') +
          '\n',
      )
      status = 1
    }
    return status
  },
  alias: noop,
  unalias: noop,
  hash: noop,
  ulimit: noop,
  async disown(args) {
    const ids = args.filter((arg) => !arg.startsWith('-') || /^-\d/.test(arg))
    const jobs = args.includes('-a')
      ? [...this.state.jobs.values()]
      : ids.length
        ? ids.map((id) => this.job(id))
        : [this.job('%%')]
    let status = 0
    for (const job of jobs) {
      if (job) this.state.jobs.delete(job.pid)
      else status = 1
    }
    return status
  },
  async cd(args, io) {
    const target = args.filter((arg) => arg !== '-P' && arg !== '-L')[0] ?? this.get('HOME') ?? '/'
    const destination = target === '-' ? (this.get('OLDPWD') ?? this.state.cwd) : target
    const logical = this.resolve(destination)
    const stat = await this.host.fs.stat(logical)
    if (!stat) throw new CommandError(target + ': No such file or directory')
    const path = args.includes('-P') ? await physical(this.host.fs, logical) : logical
    if (stat.kind !== 'directory') throw new CommandError(target + ': Not a directory')
    this.set('OLDPWD', this.state.cwd)
    this.state.cwd = path
    this.set('PWD', path)
    if (target === '-') io.stdout.write(path + '\n')
    return 0
  },
  async trap(args, io) {
    if (!args.length || args[0] === '-p') {
      for (const [signal, action] of this.state.traps)
        if (args.length < 2 || args.includes(signal))
          io.stdout.write('trap -- ' + shellQuote(action) + ' ' + signal + '\n')
      return 0
    }
    if (args[0] === '-l') return 0
    const rest = args[0] === '--' ? args.slice(1) : args
    const reset = rest.length === 1 || (/^(-|\d+)$/.test(rest[0]) && rest[0] !== '0')
    const action = reset ? '-' : rest[0]
    for (const raw of reset && rest[0] !== '-' ? rest : rest.slice(1)) {
      let signal = raw.toUpperCase().replace(/^SIG/, '')
      if (signal === '0') signal = 'EXIT'
      if (action === '-') this.state.traps.delete(signal)
      else this.state.traps.set(signal, action)
    }
    return 0
  },
  async shopt(args, io) {
    let mode = ''
    const names: string[] = []
    for (const arg of args) {
      if (/^-[supqo]+$/.test(arg)) mode = arg.replace(/[op-]/g, '').slice(-1) || mode
      else names.push(arg)
    }
    if (mode === 's' || mode === 'u') {
      for (const name of names) {
        if (mode === 's') this.state.shopt.add(name)
        else this.state.shopt.delete(name)
      }
      return 0
    }
    let status = 0
    for (const name of names.length
      ? names
      : ['dotglob', 'extglob', 'failglob', 'globstar', 'nocaseglob', 'nocasematch', 'nullglob']) {
      const on = this.state.shopt.has(name)
      if (!on) status = 1
      if (mode !== 'q') io.stdout.write(name.padEnd(15) + '\t' + (on ? 'on' : 'off') + '\n')
    }
    return status
  },
  async getopts(args, io) {
    const [spec, name, ...rest] = args
    if (spec === undefined || name === undefined)
      throw new CommandError('usage: getopts optstring name [arg ...]', 2)
    const argv = rest.length ? rest : this.state.positional
    const silent = spec.startsWith(':')
    const letters = silent ? spec.slice(1) : spec
    let index = Number(this.get('OPTIND') ?? '1') || 1
    if (index !== this.state.optind) this.state.optpos = 1
    const arg = argv[index - 1]
    this.state.vars.delete('OPTARG')
    if (arg === undefined || arg === '-' || !arg.startsWith('-') || arg === '--') {
      if (arg === '--') index++
      this.state.optind = index
      this.state.optpos = 1
      this.set('OPTIND', String(index))
      this.set(name, '?')
      return 1
    }
    const letter = arg[this.state.optpos] ?? ''
    let next = this.state.optpos + 1
    const position = letter === ':' ? -1 : letters.indexOf(letter)
    if (position < 0) {
      this.set(name, '?')
      if (silent) this.set('OPTARG', letter)
      else io.stderr.write('bash: illegal option -- ' + letter + '\n')
    } else if (letters[position + 1] === ':') {
      if (next < arg.length) {
        this.set('OPTARG', arg.slice(next))
        this.set(name, letter)
      } else if (argv[index] !== undefined) {
        this.set('OPTARG', argv[index])
        this.set(name, letter)
        index++
      } else if (silent) {
        this.set(name, ':')
        this.set('OPTARG', letter)
      } else {
        io.stderr.write('bash: option requires an argument -- ' + letter + '\n')
        this.set(name, '?')
      }
      next = arg.length
    } else this.set(name, letter)
    if (next >= arg.length) {
      index++
      next = 1
    }
    this.state.optpos = next
    this.state.optind = index
    this.set('OPTIND', String(index))
    return 0
  },
  async pushd(args, io) {
    const target = args.find((arg) => !arg.startsWith('-') || arg === '-')
    const previous = this.state.cwd
    if (target === undefined) {
      const top = this.state.stack.shift()
      if (top === undefined) throw new CommandError('no other directory')
      await BUILTINS.cd.call(this, [top], { ...io, stdout: this.buffer() })
    } else {
      const status = await BUILTINS.cd.call(this, [target], { ...io, stdout: this.buffer() })
      if (status) return status
    }
    this.state.stack.unshift(previous)
    io.stdout.write([this.state.cwd, ...this.state.stack].join(' ') + '\n')
    return 0
  },
  async popd(_args, io) {
    const top = this.state.stack.shift()
    if (top === undefined) throw new CommandError('directory stack empty')
    await BUILTINS.cd.call(this, [top], { ...io, stdout: this.buffer() })
    io.stdout.write([this.state.cwd, ...this.state.stack].join(' ') + '\n')
    return 0
  },
  async dirs(_args, io) {
    io.stdout.write([this.state.cwd, ...this.state.stack].join(' ') + '\n')
    return 0
  },
  async pwd(args, io) {
    io.stdout.write(
      (args.includes('-P') ? await physical(this.host.fs, this.state.cwd) : this.state.cwd) + '\n',
    )
    return 0
  },
  async umask(args, io) {
    const symbolic = args.includes('-S')
    const value = args.find((arg) => !arg.startsWith('-'))
    if (value === undefined) {
      const mask = this.state.umask
      if (!symbolic) io.stdout.write(mask.toString(8).padStart(4, '0') + '\n')
      else
        io.stdout.write(
          ['u', 'g', 'o']
            .map(
              (who, index) =>
                who +
                '=' +
                ['r', 'w', 'x']
                  .filter((_, bit) => !((mask >> ((2 - index) * 3)) & (4 >> bit)))
                  .join(''),
            )
            .join(',') + '\n',
        )
      return 0
    }
    if (/^[0-7]{1,4}$/.test(value)) {
      this.state.umask = parseInt(value, 8)
      return 0
    }
    if (/^\d+$/.test(value)) throw new CommandError(value + ': octal number out of range')
    let allowed = 0o777 & ~this.state.umask
    for (const clause of value.split(',')) {
      const match = clause.match(/^([ugoa]*)([-+=])([rwx]*)$/)
      if (!match)
        throw new CommandError('`' + clause.slice(-1) + "': invalid symbolic mode operator")
      const who =
        match[1] === '' || match[1].includes('a')
          ? 0o777
          : (match[1].includes('u') ? 0o700 : 0) |
            (match[1].includes('g') ? 0o070 : 0) |
            (match[1].includes('o') ? 0o007 : 0)
      const perm =
        (match[3].includes('r') ? 0o444 : 0) |
        (match[3].includes('w') ? 0o222 : 0) |
        (match[3].includes('x') ? 0o111 : 0)
      if (match[2] === '+') allowed |= perm & who
      else if (match[2] === '-') allowed &= ~(perm & who)
      else allowed = (allowed & ~who) | (perm & who)
    }
    this.state.umask = 0o777 & ~allowed
    if (symbolic)
      io.stdout.write(
        ['u', 'g', 'o']
          .map(
            (who, index) =>
              who +
              '=' +
              ['r', 'w', 'x']
                .filter((_, bit) => (allowed >> ((2 - index) * 3)) & (4 >> bit))
                .join(''),
          )
          .join(',') + '\n',
      )
    return 0
  },
  async unset(args) {
    let functions = false
    let refs = false
    for (let arg of args) {
      if (arg === '-f') functions = true
      else if (arg === '-v') functions = false
      else if (arg === '-n') refs = true
      else if (functions) this.state.functions.delete(arg)
      else if (refs && this.state.refs.has(arg)) this.state.refs.delete(arg)
      else {
        arg = this.target(arg)
        const element = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/)
        if (element) {
          const map = this.state.maps.get(element[1])
          if (map) {
            map.delete(element[2])
            continue
          }
          const array = this.state.vars.get(element[1])?.slice()
          if (array) {
            const index = Number(
              evaluateArith(element[2], { get: (n) => this.get(n) ?? '', set: () => undefined }),
            )
            delete array[index < 0 ? array.length + index : index]
            this.state.vars.set(element[1], array)
          }
          continue
        }
        if (this.state.readonly.has(arg))
          throw new CommandError(arg + ': cannot unset: readonly variable')
        this.state.maps.delete(arg)
        this.state.vars.delete(arg)
        this.state.exported.delete(arg)
      }
    }
    return 0
  },
  async set(args, io) {
    if (!args.length) {
      for (const [name, value] of [...this.state.vars].sort(([a], [b]) => (a < b ? -1 : 1)))
        io.stdout.write(name + '=' + (value[0] ?? '') + '\n')
      return 0
    }
    const options: Record<string, keyof State['options']> = {
      e: 'errexit',
      u: 'nounset',
      x: 'xtrace',
      f: 'noglob',
      C: 'noclobber',
      errexit: 'errexit',
      nounset: 'nounset',
      xtrace: 'xtrace',
      pipefail: 'pipefail',
      noglob: 'noglob',
      noclobber: 'noclobber',
    }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--' || arg === '-') {
        this.state.positional = args.slice(i + 1)
        return 0
      }
      if (!/^[-+]/.test(arg)) {
        this.state.positional = args.slice(i)
        return 0
      }
      const enable = arg[0] === '-'
      for (const flag of arg.slice(1)) {
        if (flag === 'o') {
          const name = args[++i]
          if (name === undefined) {
            for (const [key, value] of Object.entries(this.state.options))
              io.stdout.write(key.padEnd(15) + (value ? 'on' : 'off') + '\n')
            continue
          }
          if (options[name]) this.state.options[options[name]] = enable
          else if (
            ![
              'posix',
              'vi',
              'emacs',
              'monitor',
              'notify',
              'allexport',
              'hashall',
              'braceexpand',
              'history',
              'ignoreeof',
              'verbose',
              'nolog',
              'physical',
              'functrace',
              'errtrace',
              'noexec',
              'keyword',
              'onecmd',
              'privileged',
              'interactive-comments',
            ].includes(name)
          )
            throw new CommandError(name + ': invalid option name', 2)
        } else if (options[flag]) this.state.options[options[flag]] = enable
      }
    }
    return 0
  },
  async shift(args) {
    const n = count(args[0], 1)
    if (n > this.state.positional.length || n < 0) return 1
    this.state.positional = this.state.positional.slice(n)
    return 0
  },
  async read(args, io) {
    let source = io.stdin
    let raw = false
    let delimiter = '\n'
    let array: string | undefined
    let chars: number | undefined
    const names: string[] = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (/^-[a-zA-Z]/.test(arg) && !names.length) {
        for (let j = 1; j < arg.length; j++) {
          const flag = arg[j]
          const value = () => (j + 1 < arg.length ? arg.slice(j + 1) : args[++i])
          if (flag === 'r') raw = true
          else if (flag === 's') continue
          else if (flag === 'a') {
            array = value()
            break
          } else if (flag === 'd') {
            delimiter = value() ?? ''
            break
          } else if (flag === 'n' || flag === 'N') {
            chars = Number(value())
            break
          } else if (flag === 'u') {
            const fd = Number(value())
            const found = fd === 0 ? io.stdin : io.fds?.get(fd)?.input
            if (!found) {
              io.stderr.write(
                'bash: read: ' + fd + ': invalid file descriptor: Bad file descriptor\n',
              )
              return 1
            }
            source = found
            break
          } else if (flag === 'p' || flag === 't') {
            value()
            break
          }
        }
      } else names.push(arg)
    }
    let line: { text: string; complete: boolean } | null
    if (chars !== undefined) {
      const text = await source.readChars(chars)
      line = text ? { text, complete: true } : null
    } else line = await source.readLine(delimiter)
    const targets = names.length ? names : array ? [] : ['REPLY']
    if (!line) {
      for (const name of targets) this.set(name, '')
      if (array) this.set(array, [])
      return 1
    }
    let text = line.text
    if (!raw && text.includes('\\')) text = text.replace(/\\([\s\S])/g, '$1')
    const ifs = this.state.vars.has('IFS') ? this.get('IFS')! : ' \t\n'
    if (array)
      this.set(
        array,
        readFields(text, Number.MAX_SAFE_INTEGER, ifs).filter(
          (field, index, all) => field !== '' || index < all.length - 1,
        ),
      )
    if (targets.length === 1 && !names.length) this.set('REPLY', line.text)
    else {
      const fields = readFields(text, targets.length, ifs)
      targets.forEach((name, index) => this.set(name, fields[index] ?? ''))
    }
    return line.complete ? 0 : 1
  },
  async mapfile(args, io) {
    let strip = false
    let delimiter = '\n'
    let name = 'MAPFILE'
    let callback: string | undefined
    let quantum = 5000
    let skip = 0
    let limit = 0
    let origin: number | undefined
    let source = io.stdin
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '-t') strip = true
      else if (arg === '-d') delimiter = args[++i] ?? '\n'
      else if (arg === '-C') callback = args[++i]
      else if (arg === '-c') quantum = Number(args[++i] ?? 5000) || 5000
      else if (arg === '-s') skip = Number(args[++i] ?? 0)
      else if (arg === '-n') limit = Number(args[++i] ?? 0)
      else if (arg === '-O') origin = Number(args[++i] ?? 0)
      else if (arg === '-u') {
        const fd = Number(args[++i])
        const found = fd === 0 ? io.stdin : io.fds?.get(fd)?.input
        if (!found) {
          io.stderr.write(
            'bash: mapfile: ' + fd + ': invalid file descriptor: Bad file descriptor\n',
          )
          return 1
        }
        source = found
      } else if (arg.startsWith('-')) i++
      else name = arg
    }
    if (delimiter === '') delimiter = '\0'
    const existing = origin !== undefined ? (this.state.vars.get(name)?.slice() ?? []) : []
    const values: string[] = existing
    let index = origin ?? 0
    let read = 0
    for (
      let line = await source.readLine(delimiter);
      line;
      line = limit && read >= limit ? null : await source.readLine(delimiter)
    ) {
      if (skip > 0) {
        skip--
        continue
      }
      const value = strip || !line.complete ? line.text : line.text + delimiter
      if (callback !== undefined && read % quantum === quantum - 1) {
        const status = await BUILTINS.eval.call(
          this,
          [callback, String(index), shellQuote(value)],
          io,
        )
        if (status === 2) return 1
      }
      values[index++] = value
      read++
      if (limit && read >= limit) break
    }
    this.set(
      name,
      Array.from(values, (value) => value ?? ''),
    )
    return 0
  },
  async eval(args, io) {
    const source = args.join(' ')
    let script: Script
    try {
      script = parse(source)
    } catch (error) {
      if (!(error instanceof ParseError)) throw error
      io.stderr.write('bash: eval: ' + error.message + '\n')
      return 2
    }
    this.enter()
    try {
      return await this.script(script, io)
    } finally {
      this.leave()
    }
  },
  async source(args, io) {
    if (!args.length) throw new CommandError('filename argument required', 2)
    return this.source(this.resolve(args[0]), args.slice(1), io, false, undefined, args[0])
  },
  async exit(args) {
    throw new ExitSignal(args.length ? count(args[0], 0) & 255 : this.state.status)
  },
  async return(args) {
    throw new ReturnSignal(args.length ? count(args[0], 0) & 255 : this.state.status)
  },
  async break(args) {
    throw new LoopSignal('break', count(args[0], 1))
  },
  async continue(args) {
    throw new LoopSignal('continue', count(args[0], 1))
  },
  async let(args) {
    let value: ArithValue = 0
    for (const arg of args)
      value = await this.arith([{ type: 'text', value: arg, quoted: true }], {
        stdin: new Input(),
        stdout: this.buffer(),
        stderr: this.buffer(),
      })
    return value === 0 ? 1 : 0
  },
  async test(args, io) {
    return this.test(
      args.map((text) => ({ text })),
      false,
      io,
    )
  },
  async '['(args, io) {
    if (args[args.length - 1] !== ']') {
      io.stderr.write("bash: [: missing `]'\n")
      return 2
    }
    return this.test(
      args.slice(0, -1).map((text) => ({ text })),
      false,
      io,
    )
  },
  async type(args, io) {
    let status = 0
    const flags = args.filter((arg) => /^-[atpPf]+$/.test(arg)).join('')
    const terse = flags.includes('t')
    const every = flags.includes('a')
    const forced = flags.includes('P')
    const paths = flags.includes('p') || forced
    for (const name of args.filter((arg) => !arg.startsWith('-'))) {
      const kinds: string[] = []
      if (forced) {
        if (
          this.host.commands.has(name) ||
          ['[', 'echo', 'false', 'kill', 'printf', 'pwd', 'test', 'true'].includes(name)
        )
          io.stdout.write('/usr/bin/' + name + '\n')
        else status = 1
        continue
      }
      if (KEYWORDS.has(name)) kinds.push('keyword')
      if (this.state.functions.has(name)) kinds.push('function')
      if (BUILTINS[name] || SHELL_BUILTINS.has(name) || DECLARATIONS.has(name))
        kinds.push('builtin')
      if (
        this.host.commands.has(name) ||
        (every && ['[', 'echo', 'false', 'kill', 'printf', 'pwd', 'test', 'true'].includes(name))
      )
        kinds.push('file')
      if (!kinds.length) {
        if (!terse) io.stderr.write('bash: type: ' + name + ': not found\n')
        status = 1
        continue
      }
      for (const kind of every ? kinds : kinds.slice(0, 1)) {
        if (paths) {
          if (kind === 'file') io.stdout.write('/usr/bin/' + name + '\n')
          continue
        }
        if (terse) io.stdout.write(kind + '\n')
        else if (kind === 'file')
          for (const dir of every ? ['/usr/bin/', '/bin/'] : ['/usr/bin/'])
            io.stdout.write(name + ' is ' + dir + name + '\n')
        else
          io.stdout.write(
            kind === 'function'
              ? name +
                  ' is a function\n' +
                  functionText(name, this.state.functions.get(name)!) +
                  '\n'
              : kind === 'builtin'
                ? name + ' is a shell builtin\n'
                : name + ' is a shell keyword\n',
          )
      }
    }
    return status
  },
  async command(args, io) {
    if (args[0] === '-V') return BUILTINS.type.call(this, args.slice(1), io)
    if (args[0] === '-v') {
      let status = 0
      for (const name of args.slice(1)) {
        if (
          this.state.functions.has(name) ||
          BUILTINS[name] ||
          SHELL_BUILTINS.has(name) ||
          DECLARATIONS.has(name) ||
          KEYWORDS.has(name)
        )
          io.stdout.write(name + '\n')
        else if (this.host.commands.has(name)) io.stdout.write('/usr/bin/' + name + '\n')
        else status = 1
      }
      return status
    }
    if (!args.length) return 0
    return this.dispatch(args, io, false)
  },
  async builtin(args, io) {
    const builtin = args.length ? BUILTINS[args[0]] : undefined
    if (!builtin) throw new CommandError((args[0] ?? '') + ': not a shell builtin')
    return builtin.call(this, args.slice(1), io)
  },
  async which(args, io) {
    let status = 0
    for (const name of args.filter((arg) => !arg.startsWith('-'))) {
      if (this.host.commands.has(name) || BUILTINS[name]) io.stdout.write('/usr/bin/' + name + '\n')
      else status = 1
    }
    return status
  },
  async exec(args, io) {
    if (!args.length) return 0
    throw new ExitSignal(await this.dispatch(args, io))
  },
  async env(args, io) {
    const assigns: [string, string][] = []
    let clear = false
    let i = 0
    for (; i < args.length; i++) {
      if (args[i] === '-i' || args[i] === '-') clear = true
      else if (args[i] === '-u') {
        assigns.push([args[++i], '\0'])
      } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i])) {
        const eq = args[i].indexOf('=')
        assigns.push([args[i].slice(0, eq), args[i].slice(eq + 1)])
      } else break
    }
    const command = args.slice(i)
    return this.subshell(async () => {
      if (clear) {
        for (const name of this.state.exported) this.state.vars.delete(name)
        this.state.exported.clear()
      }
      for (const [name, value] of assigns) {
        if (value === '\0') {
          this.state.vars.delete(name)
          this.state.exported.delete(name)
        } else {
          this.set(name, value)
          this.state.exported.add(name)
        }
      }
      if (!command.length) {
        for (const [name, value] of Object.entries(this.environment()))
          io.stdout.write(name + '=' + value + '\n')
        return 0
      }
      return this.dispatch(command, io, false)
    })
  },
  async printenv(args, io) {
    const env = this.environment()
    if (!args.length) {
      for (const [name, value] of Object.entries(env)) io.stdout.write(name + '=' + value + '\n')
      return 0
    }
    let status = 0
    for (const name of args) {
      if (name in env) io.stdout.write(env[name] + '\n')
      else status = 1
    }
    return status
  },
  async printf(args, io) {
    if (args[0] === '-v' && args.length >= 2) {
      const handler = this.host.commands.get('printf')
      if (!handler) return 1
      const out = this.buffer()
      const status = await this.external('printf', handler, args.slice(2), { ...io, stdout: out })
      const element = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(args[1])
      if (element)
        await this.assign(
          {
            name: element[1],
            index: [{ type: 'text', value: element[2], quoted: true }],
            value: [{ type: 'text', value: out.text(), quoted: true }],
            append: false,
          },
          io,
        )
      else this.set(args[1], out.text())
      return status
    }
    const handler = this.host.commands.get('printf')
    return handler ? this.external('printf', handler, args, io) : 127
  },
  async bash(args, io) {
    const options: string[] = []
    let i = 0
    for (; i < args.length && /^[-+][a-zA-Z]+$/.test(args[i]); i++) options.push(args[i])
    const command = options.some((option) => option.includes('c'))
    const flags = options
      .map((option) => option.replace(/[cl]/g, ''))
      .filter((option) => option.length > 1)
    return this.subshell(async () => {
      if (flags.length) await BUILTINS.set.call(this, flags, io)
      if (command) {
        const source = args[i] ?? ''
        let script: Script
        try {
          script = parse(source)
        } catch (error) {
          if (!(error instanceof ParseError)) throw error
          io.stderr.write('bash: -c: ' + error.message + '\n')
          return 2
        }
        if (args[i + 1] !== undefined) this.state.arg0 = args[i + 1]
        this.state.positional = args.slice(i + 2)
        this.enter()
        try {
          return await this.script(script, io)
        } finally {
          this.leave()
        }
      }
      if (i >= args.length) {
        const source = await io.stdin.text()
        this.enter()
        try {
          return await this.script(parse(source), io)
        } finally {
          this.leave()
        }
      }
      return this.source(this.resolve(args[i]), args.slice(i + 1), io, false, args[i])
    }, io)
  },
  async timeout(args, io) {
    let i = 0
    let preserve = false
    while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
      if (args[i] === '--preserve-status') preserve = true
      i += args[i] === '-s' || args[i] === '-k' ? 2 : 1
    }
    const match = /^(\d*\.?\d+)([smhd]?)$/.exec(args[i] ?? '')
    const command = args.slice(i + 1)
    if (!match || !command.length)
      throw new CommandError(
        match ? 'missing operand' : "invalid time interval '" + (args[i] ?? '') + "'",
        125,
      )
    const ms = Number(match[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]!]! * 1000
    if (ms === 0) return this.dispatch(command, io)
    const controller = new AbortController()
    const runner = this.fork(this.state, AbortSignal.any([this.signal, controller.signal]))
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        controller.abort('timed out')
        resolve(preserve ? 143 : 124)
      }, ms)
    })
    try {
      const ran = runner.dispatch(command, io).catch((error) => {
        if (controller.signal.aborted && !this.signal.aborted) return preserve ? 143 : 124
        throw error
      })
      return await Promise.race([ran, expired])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.check()
    }
  },
  async time(args, io) {
    const start = Date.now()
    const status = args.length ? await this.dispatch(args, io) : 0
    io.stderr.write(
      '\nreal\t' + ((Date.now() - start) / 1000).toFixed(3) + 's\nuser\t0.000s\nsys\t0.000s\n',
    )
    return status
  },
}

BUILTINS['.'] = BUILTINS.source
BUILTINS.readarray = BUILTINS.mapfile
BUILTINS.sh = BUILTINS.bash

export async function run(runner: Runner, source: string, io: IO): Promise<number> {
  let status = await guard(runner, io, () => runner.script(parse(source), io))
  if (runner.state.traps.has('EXIT'))
    status = await guard(runner, io, () => runner.exitTrap(io, status))
  await runner.jobs()
  try {
    await runner.cleanup()
  } catch (error) {
    io.stderr.write('bash: ' + message(error) + '\n')
  }
  return status
}

async function guard(runner: Runner, io: IO, body: () => Promise<number>): Promise<number> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof ExitSignal || error instanceof ReturnSignal || error instanceof KillSignal)
      return error.status
    if (error instanceof PipeError) return 141
    if (error instanceof LoopSignal) return 0
    if (error instanceof ParseError) {
      runner.failure = 'syntax'
      io.stderr.write('bash: ' + error.message + '\n')
      return 2
    }
    if (error instanceof LimitError) {
      runner.failure = 'limit'
      io.stderr.write('bash: ' + error.message + '\n')
      return error.status
    }
    if (
      error instanceof FatalError ||
      error instanceof ArithError ||
      error instanceof CommandError
    ) {
      if (!(error instanceof FatalError && error.reported))
        io.stderr.write('bash: ' + error.message + '\n')
      return error instanceof FatalError || error instanceof CommandError ? error.status : 1
    }
    throw error
  }
}

function missing(name: string): string {
  if (/^(node|nodejs|npm|npx|pnpm|yarn|bun|bunx|deno|tsc|tsx|ts-node)$/.test(name))
    return ' (this simulated shell has no JavaScript runtime or package manager)'
  if (/^(python[23]?(\.\d+)?|pip3?|pytest|ipython)$/.test(name))
    return ' (Python is not available on this host)'
  if (
    /^(sqlite3|psql|mysql|gcc|cc|clang|g\+\+|cargo|rustc|go|java|javac|ruby|perl|php|docker|sudo|apt|apt-get|brew)$/.test(
      name,
    )
  )
    return ' (this simulated shell has no ' + name + ')'
  return ''
}

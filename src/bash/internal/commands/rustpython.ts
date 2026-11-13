import { FsError, type FileStat, type SyncFileSystem } from '../../FileSystem.ts'
import { decode, encode } from '../Fs.ts'
import { CommandError, type CommandContext } from '../Shell.ts'

type Exports = {
  memory: WebAssembly.Memory
  python_input(len: number): number
  python_output(): number
  python_reply(len: number): number
  python_run(): number
}

type Instance = {
  exports: Exports
  files: SyncFileSystem | undefined
  panic: string | undefined
  running: boolean
  stopped: () => boolean
}

export type Missing = { module: string; package: boolean; text: string }

export type Ran =
  | { kind: 'exited'; status: number; stderr: Uint8Array; stdout: Uint8Array }
  | { kind: 'needs'; missing: readonly Missing[] }
  | { kind: 'refused'; limit: number; stderr: Uint8Array; stdout: Uint8Array }
  | { kind: 'cancelled'; stderr: Uint8Array; stdout: Uint8Array }

export type Request = {
  argv: readonly string[]
  cwd: string
  depth: number
  env: Record<string, string>
  file: number
  memory: number
  output: number
  stdin: Uint8Array
  steps: number
  timeMs: number
}

const errno: Record<string, number> = {
  EACCES: 13,
  EEXIST: 17,
  EFBIG: 27,
  EINVAL: 22,
  EIO: 5,
  EISDIR: 21,
  ENOENT: 2,
  ENOTDIR: 20,
  ENOTEMPTY: 39,
  ENOTSUP: 95,
  EROFS: 30,
}

const instances = new WeakMap<WebAssembly.Module, Instance>()

const randomBytes = 65536

const text = new TextDecoder()

const limits = ['output', 'sleep', 'steps', 'time', 'memory'] as const

function instantiate(module: WebAssembly.Module): Instance {
  const state: Instance = {
    exports: undefined as unknown as Exports,
    files: undefined,
    panic: undefined,
    running: false,
    stopped: () => false,
  }
  const view = (ptr: number, len: number) =>
    new Uint8Array(state.exports.memory.buffer, ptr >>> 0, len >>> 0)
  const reply = (data: Uint8Array) => {
    view(state.exports.python_reply(data.length), data.length).set(data)
    return BigInt(data.length)
  }
  const stat = new Uint8Array(24)
  const stats = new DataView(stat.buffer)
  const found = (files: SyncFileSystem, path: string): FileStat => {
    const entry = files.stat(path)
    if (!entry) throw new FsError('ENOENT', path)
    return entry
  }
  const ops: ((files: SyncFileSystem, path: string, data: Uint8Array, arg: bigint) => bigint)[] = [
    (files, path) => {
      const entry = found(files, path)
      stats.setUint32(0, entry.kind === 'directory' ? 1 : 0, true)
      stats.setUint32(4, entry.mode, true)
      stats.setBigUint64(8, BigInt(entry.size), true)
      stats.setBigInt64(16, BigInt(Math.trunc(entry.mtime)) * 1_000_000n, true)
      return reply(stat)
    },
    (files, path) => reply(files.read(path)),
    (files, path, data, how) => {
      if (how === 2n && files.stat(path)) throw new FsError('EEXIST', path)
      files.write(path, data.slice(), how === 1n)
      return 0n
    },
    (files, path) =>
      reply(
        encode(
          files
            .list(path)
            .map((name) => name + '\0')
            .join(''),
        ),
      ),
    (files, path) => {
      if (files.stat(path)) throw new FsError('EEXIST', path)
      files.mkdir(path)
      return 0n
    },
    (files, path, _data, what) => {
      const entry = found(files, path)
      if (what === 0n && entry.kind === 'directory') throw new FsError('EISDIR', path)
      if (what === 1n && entry.kind !== 'directory') throw new FsError('ENOTDIR', path)
      if (what === 1n && files.list(path).length) throw new FsError('ENOTEMPTY', path)
      files.remove(path)
      return 0n
    },
    (files, path, data) => {
      files.rename(path, decode(data))
      return 0n
    },
  ]
  const imports = {
    python: {
      host_fs(
        op: number,
        path: number,
        pathLen: number,
        data: number,
        dataLen: number,
        arg: bigint,
      ) {
        const files = state.files
        const handler = ops[op]
        if (!files || !handler) return -BigInt(errno['ENOTSUP'] ?? 0)
        try {
          return handler(files, decode(view(path, pathLen)), view(data, dataLen), arg)
        } catch (error) {
          const code = error instanceof FsError ? errno[error.code] : undefined
          if (code === undefined) throw error
          return -BigInt(code)
        }
      },
      host_now: () => performance.now(),
      host_panic(ptr: number, len: number) {
        state.panic = decode(view(ptr, len))
      },
      host_random(ptr: number, len: number) {
        for (let at = 0; at < len; at += randomBytes)
          crypto.getRandomValues(view(ptr + at, Math.min(randomBytes, len - at)))
      },
      host_stopped: () => (state.stopped() ? 1 : 0),
      host_time: () => Date.now(),
    },
  }
  state.exports = new WebAssembly.Instance(module, imports).exports as unknown as Exports
  return state
}

function encodeRequest(request: Request): Uint8Array {
  const parts: Uint8Array[] = []
  const u32 = (value: number) => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value, true)
    parts.push(bytes)
  }
  const u64 = (value: bigint) => {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, value, true)
    parts.push(bytes)
  }
  const field = (value: string | Uint8Array) => {
    const bytes = typeof value === 'string' ? encode(value) : value
    u32(bytes.length)
    parts.push(bytes)
  }
  u32(request.argv.length)
  for (const arg of request.argv) field(arg)
  field(request.cwd)
  const env = Object.entries(request.env)
  u32(env.length)
  for (const [name, value] of env) {
    field(name)
    field(value)
  }
  field(request.stdin)
  u64(BigInt(request.output))
  u64(BigInt(request.file))
  u64(BigInt(request.steps))
  u64(BigInt(Math.max(0, Math.ceil(request.timeMs))))
  u64(BigInt(request.depth))
  u64(BigInt(request.memory))
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return joined
}

function decodeRan(bytes: Uint8Array): Ran {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const u32 = () => {
    const value = data.getUint32(at, true)
    at += 4
    return value
  }
  const field = () => {
    const len = u32()
    const value = bytes.subarray(at, at + len)
    at += len
    return value
  }
  const tag = u32()
  const value = u32()
  const stdout = field()
  const stderr = field()
  at += 8
  const missing: Missing[] = []
  for (let count = u32(); count > 0; count--) {
    const module = text.decode(field())
    const why = u32()
    missing.push({ module, package: why === 0, text: text.decode(field()) })
  }
  if (tag === 0) return { kind: 'exited', status: value | 0, stderr, stdout }
  if (tag === 1) return { kind: 'needs', missing }
  if (tag === 2) return { kind: 'refused', limit: value, stderr, stdout }
  return { kind: 'cancelled', stderr, stdout }
}

export function prepare(module: WebAssembly.Module): void {
  if (!instances.has(module)) instances.set(module, instantiate(module))
}

export function run(
  module: WebAssembly.Module,
  options: { files: SyncFileSystem; request: Request; stopped: () => boolean },
): Ran {
  if (instances.get(module)?.running) instances.delete(module)
  prepare(module)
  const instance = instances.get(module)!
  instance.files = options.files
  instance.stopped = options.stopped
  try {
    const input = encodeRequest(options.request)
    const ptr = instance.exports.python_input(input.length)
    new Uint8Array(instance.exports.memory.buffer, ptr, input.length).set(input)
    instance.running = true
    const len = instance.exports.python_run()
    instance.running = false
    return decodeRan(
      new Uint8Array(instance.exports.memory.buffer, instance.exports.python_output(), len).slice(),
    )
  } catch (error) {
    instances.delete(module)
    throw new CommandError(
      'the Python interpreter failed and restarts on the next run: ' +
        (instance.panic ?? (error instanceof Error ? error.message : String(error))),
      1,
    )
  } finally {
    instance.files = undefined
    instance.stopped = () => false
  }
}

export function report(ctx: CommandContext, ran: Exclude<Ran, { kind: 'needs' }>): number {
  ctx.stdout.write(decode(ran.stdout))
  ctx.stderr.write(decode(ran.stderr))
  if (ran.kind === 'exited') return ran.status
  if (ran.kind === 'cancelled') throw new CommandError('interrupted', 130)
  const limit = limits[ran.limit]
  if (limit === 'time')
    throw new CommandError('timed out after ' + ctx.limits.timeoutMs + ' ms', 124)
  if (limit === 'output') throw new CommandError('it printed more than this shell keeps', 126)
  if (limit === 'memory') throw new CommandError('it held more memory than this shell allows', 126)
  if (limit === 'sleep') throw new CommandError('it cannot wait in this shell', 126)
  throw new CommandError('it ran more steps than this shell allows', 126)
}

import * as FileSystem from '../FileSystem.ts'
import { breathe, decode, encode } from './Fs.ts'
import * as Shell from './Shell.ts'

export type Ended = 'cancelled' | 'exited' | 'fuel' | 'missing' | 'operations'

export type Instance = {
  current: Host | undefined
  exports: Exports
  failure: string | undefined
  module: WebAssembly.Module
  nextRequest: number
  procs: Map<number, Proc>
  requests: Map<number, (reply: Reply) => void>
  shells: Map<number, Host>
}

export type Limits = {
  depth: number
  file: number
  fuel: number
  operations: number
  output: number
}

export type Ran = {
  ended: Ended
  fuel: number
  halted: string | undefined
  missing: readonly string[]
  operations: number
  status: number
  stderr: Uint8Array
  stdout: Uint8Array
  truncated: boolean
}

type Exports = {
  memory: WebAssembly.Memory
  psh_abi_version(): number
  psh_complete(op: number, err: number, len: number): void
  psh_in(len: number): number
  psh_init(): void
  psh_out_len(): number
  psh_out_ptr(): number
  psh_proc_exit(pid: number, status: number): void
  psh_proc_read(pid: number, req: number, max: number): void
  psh_proc_write(pid: number, req: number, fd: number, len: number): void
  psh_shell_cancel(id: number): void
  psh_shell_free(id: number): void
  psh_shell_new(len: number): number
  psh_shell_result(id: number): number
  psh_shell_start(id: number, len: number): number
  psh_shell_step(id: number, budget: number): number
}

type Host = {
  cancel(): void
  failure: unknown
  halted: string | undefined
  id: number
  options: run.Options
  waiting: (() => void) | undefined
  woken: boolean
}

type Proc = {
  controller: AbortController
  host: Host
  live: boolean
  pending: Set<number>
}

type Reply = {
  data: Uint8Array
  err: number
}

const abiVersion = 4

const budget = 10_000

const readBytes = 65_536

const kind = {
  done: 8,
  fs: 1,
  has: 5,
  kill: 7,
  now: 3,
  panic: 10,
  random: 4,
  sleep: 2,
  spawn: 6,
  utcOffset: 11,
  wake: 9,
} as const

const fsOp = {
  list: 6,
  lstat: 1,
  mkdir: 7,
  read: 2,
  readLink: 12,
  removeDir: 9,
  removeFile: 8,
  rename: 10,
  setMode: 13,
  setMtime: 14,
  stat: 0,
  symlink: 11,
  writeAppend: 4,
  writeNew: 5,
  writeReplace: 3,
} as const

const errno: Record<string, number> = {
  EBUSY: 16,
  EEXIST: 17,
  EFBIG: 27,
  EINVAL: 22,
  EIO: 5,
  EISDIR: 21,
  ELOOP: 40,
  ENOENT: 2,
  ENOTDIR: 20,
  ENOTEMPTY: 39,
  ENOTSUP: 95,
  EPIPE: 32,
  EROFS: 30,
  EXDEV: 18,
}

const ended: readonly Ended[] = ['exited', 'cancelled', 'fuel', 'missing', 'operations']

const empty = new Uint8Array(0)

const utf8 = new TextEncoder()

const text = new TextDecoder()

const instances = new WeakMap<WebAssembly.Module, Promise<Instance>>()

export class EngineError extends Error {
  override readonly name = 'Psh.EngineError'
}

export function load(module: WebAssembly.Module): Promise<Instance> {
  const loaded = instances.get(module)
  if (loaded) return loaded

  const instance = {
    current: undefined,
    failure: undefined,
    module,
    nextRequest: 1,
    procs: new Map(),
    requests: new Map(),
    shells: new Map(),
  } as unknown as Instance
  const created = WebAssembly.instantiate(module, {
    psh: {
      host_call: (kindOf: number, op: number, arg: number, ptr: number, len: number) =>
        hostCall(instance, {
          arg: arg >>> 0,
          kind: kindOf,
          len: len >>> 0,
          op: op >>> 0,
          ptr: ptr >>> 0,
        }),
    },
  }).then((made) => {
    instance.exports = made.exports as unknown as Exports
    const version = instance.exports.psh_abi_version()
    if (version !== abiVersion)
      throw new EngineError('psh module has ABI ' + version + ', this glue ' + abiVersion)
    instance.exports.psh_init()
    return instance
  })
  instances.set(module, created)
  created.catch(() => instances.delete(module))
  return created
}

export async function run(module: WebAssembly.Module, options: run.Options): Promise<Ran> {
  const instance = await load(module)
  if (instance.failure !== undefined) {
    instances.delete(module)
    return run(module, options)
  }

  const x = instance.exports
  const host: Host = {
    cancel: () => {
      if (instance.current === host) {
        queueMicrotask(host.cancel)
        return
      }
      if (instance.failure !== undefined || !instance.shells.has(host.id)) return
      for (const proc of instance.procs.values()) if (proc.host === host) proc.controller.abort()
      x.psh_shell_cancel(host.id)
      wake(host)
    },
    failure: undefined,
    halted: undefined,
    id: 0,
    options,
    waiting: undefined,
    woken: false,
  }

  try {
    host.id = enter(instance, host, () => x.psh_shell_new(input(instance, config(options))))
    if (host.id === 0) throw new EngineError('psh refused the shell configuration')
    instance.shells.set(host.id, host)

    const started = x.psh_shell_start(host.id, input(instance, start(options)))
    if (started !== 0) throw new EngineError('psh refused the script (' + started + ')')
  } catch (error) {
    if (host.id) release(instance, host)
    throw broken(module, instance, error)
  }

  if (options.signal.aborted) host.cancel()
  options.signal.addEventListener('abort', host.cancel, { once: true })

  try {
    for (;;) {
      host.woken = false
      const step = enter(instance, host, () => x.psh_shell_step(host.id, budget))
      if (instance.failure !== undefined) throw new EngineError(instance.failure)
      if (step === 0) break

      if (step === -1) {
        if (!host.woken) await new Promise<void>((resolve) => (host.waiting = resolve))
        if (instance.failure !== undefined) throw new EngineError(instance.failure)
        continue
      }

      if (step !== -2) throw new EngineError('psh step answered ' + step)
      const pause = breathe()
      if (pause) await pause
    }

    if (x.psh_shell_result(host.id) !== 1) throw new EngineError('psh kept no result')
    const ran = result(instance, host)
    if (host.failure !== undefined) throw host.failure
    return ran
  } catch (error) {
    throw broken(module, instance, error)
  } finally {
    options.signal.removeEventListener('abort', host.cancel)
    release(instance, host)
  }
}

export declare namespace run {
  type Options = {
    commands: ReadonlyMap<string, Shell.CommandHandler>
    commandFs: FileSystem.FileSystem
    cwd: string
    env: Record<string, string>
    fetch: typeof fetch | undefined
    fs: FileSystem.FileSystem
    identity: Identity
    limits: Limits
    shellLimits: Shell.Limits
    script: string
    signal: AbortSignal
    stdin: Uint8Array | undefined
    strict: boolean
    without: readonly string[]
  }

  type Identity = {
    group: string
    home: string
    hostname: string
    hosttype: string
    machtype: string
    ostype: string
    pid: number
    uid: number
    user: string
  }
}

function enter<T>(instance: Instance, host: Host, body: () => T): T {
  const outer = instance.current
  instance.current = host
  try {
    return body()
  } finally {
    instance.current = outer
  }
}

function broken(module: WebAssembly.Module, instance: Instance, error: unknown): unknown {
  if (error instanceof EngineError || !(error instanceof Error)) return error
  if (!(error instanceof WebAssembly.RuntimeError) && !(error instanceof RangeError)) return error

  const message = 'psh stopped: ' + (instance.failure ?? error.message)
  instance.failure = message
  instances.delete(module)
  for (const other of instance.shells.values()) wake(other)
  return new EngineError(message)
}

function release(instance: Instance, host: Host): void {
  instance.shells.delete(host.id)
  if (instance.failure !== undefined) return
  try {
    instance.exports.psh_shell_free(host.id)
  } catch (error) {
    instance.failure = 'psh stopped: ' + (error instanceof Error ? error.message : String(error))
  }
}

function wake(host: Host): void {
  host.woken = true
  const waiting = host.waiting
  host.waiting = undefined
  waiting?.()
}

function memory(instance: Instance): Uint8Array {
  return new Uint8Array(instance.exports.memory.buffer)
}

function input(instance: Instance, data: Uint8Array): number {
  const ptr = instance.exports.psh_in(data.length) >>> 0
  memory(instance).set(data, ptr)
  return data.length
}

function answer(instance: Instance, op: number, reply: Reply): void {
  if (instance.failure !== undefined) return
  try {
    instance.exports.psh_complete(op, reply.err, input(instance, reply.data))
  } catch (error) {
    instance.failure = 'psh stopped: ' + (error instanceof Error ? error.message : String(error))
    for (const host of instance.shells.values()) wake(host)
  }
}

type Call = {
  arg: number
  kind: number
  len: number
  op: number
  ptr: number
}

function hostCall(instance: Instance, call: Call): number {
  const payload = () => memory(instance).slice(call.ptr, call.ptr + call.len)

  switch (call.kind) {
    case kind.fs: {
      const host = instance.current
      if (!host) throw new EngineError('psh asked for a file outside a step')
      const asked = operation({ operation: call.arg, payload: payload() })
      const sync = host.options.fs.sync
      if (sync) {
        const reply = ((): Reply => {
          try {
            return { data: performNow(host, { fs: sync, operation: asked }) ?? empty, err: 0 }
          } catch (error) {
            return { data: empty, err: code(host, error) }
          }
        })()
        answer(instance, call.op, reply)
        return 0
      }

      perform(host, asked).then(
        (data) => answer(instance, call.op, { data: data ?? empty, err: 0 }),
        (error) => answer(instance, call.op, { data: empty, err: code(host, error) }),
      )
      return 0
    }

    case kind.sleep:
      setTimeout(() => answer(instance, call.op, { data: empty, err: 0 }), call.arg)
      return 0

    case kind.now: {
      const now = new Uint8Array(8)
      new DataView(now.buffer).setFloat64(0, Date.now(), true)
      return input(instance, now)
    }

    case kind.random: {
      const bytes = new Uint8Array(call.len)
      for (let at = 0; at < bytes.length; at += 65_536)
        crypto.getRandomValues(bytes.subarray(at, at + 65_536))
      return input(instance, bytes)
    }

    case kind.has: {
      const host = instance.current
      if (!host) return 0
      return has(host, text.decode(payload())) ? 1 : 0
    }

    case kind.spawn: {
      const host = instance.current
      if (!host) throw new EngineError('psh started a command outside a step')
      spawn(instance, { host, payload: payload(), pid: call.arg })
      return 0
    }

    case kind.kill: {
      const proc = instance.procs.get(call.arg)
      if (proc) stop(instance, { pid: call.arg, proc })
      return 0
    }

    case kind.done: {
      const resolve = instance.requests.get(call.op)
      instance.requests.delete(call.op)
      resolve?.({ data: payload(), err: call.arg })
      return 0
    }

    case kind.wake: {
      const host = instance.shells.get(call.arg)
      if (host) wake(host)
      return 0
    }

    case kind.panic:
      instance.failure = 'psh stopped: ' + text.decode(payload())
      return 0

    case kind.utcOffset:
      return 0

    default:
      throw new EngineError('psh asked for an unknown operation ' + call.kind)
  }
}

function code(host: Host, error: unknown): number {
  if (error instanceof FileSystem.FsError) return errno[error.code] ?? errno.EIO!
  host.failure ??= error
  host.cancel()
  return errno.EIO!
}

function reader(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let at = 0
  const u32 = () => {
    const value = view.getUint32(at, true)
    at += 4
    return value
  }
  return {
    bytes: () => {
      const length = u32()
      at += length
      return data.subarray(at - length, at)
    },
    f64: () => {
      const value = view.getFloat64(at, true)
      at += 8
      return value
    },
    rest: () => data.subarray(at),
    u32,
  }
}

function writer() {
  const parts: Uint8Array[] = []
  let size = 0
  const push = (part: Uint8Array) => {
    parts.push(part)
    size += part.length
  }
  const u32 = (value: number) => {
    const part = new Uint8Array(4)
    new DataView(part.buffer).setUint32(0, value, true)
    push(part)
  }
  const bytes = (value: Uint8Array) => {
    u32(value.length)
    push(value)
  }
  return {
    bytes,
    done: () => {
      const out = new Uint8Array(size)
      let at = 0
      for (const part of parts) {
        out.set(part, at)
        at += part.length
      }
      return out
    },
    f64: (value: number) => {
      const part = new Uint8Array(8)
      new DataView(part.buffer).setFloat64(0, value, true)
      push(part)
    },
    string: (value: string) => bytes(utf8.encode(value)),
    u32,
  }
}

function config(options: run.Options): Uint8Array {
  const out = writer()
  out.string(options.cwd)
  const env = Object.entries(options.env)
  out.u32(env.length)
  for (const [name, value] of env) {
    out.string(name)
    out.bytes(encode(value))
  }

  out.f64(options.limits.fuel)
  out.f64(options.limits.output)
  out.f64(options.limits.file)
  out.f64(options.limits.operations)
  out.u32(options.limits.depth)
  out.u32(options.strict ? 1 : 0)

  const identity = options.identity
  out.u32(identity.uid)
  out.u32(identity.pid)
  for (const value of [
    identity.user,
    identity.group,
    identity.home,
    identity.hostname,
    identity.ostype,
    identity.machtype,
    identity.hosttype,
  ])
    out.string(value)

  out.u32(options.without.length)
  for (const name of options.without) out.string(name)
  return out.done()
}

function start(options: run.Options): Uint8Array {
  const out = writer()
  out.bytes(encode(options.script))
  out.string('/bin/bash')
  out.u32(0)
  out.u32(0)
  out.u32(options.stdin ? 1 : 0)
  if (options.stdin) out.bytes(options.stdin)
  return out.done()
}

function result(instance: Instance, host: Host): Ran {
  const x = instance.exports
  const ptr = x.psh_out_ptr() >>> 0
  const data = reader(memory(instance).slice(ptr, ptr + (x.psh_out_len() >>> 0)))
  const how = ended[data.u32()]
  if (!how) throw new EngineError('psh ended a run in an unknown way')

  const status = data.u32() | 0
  const truncated = data.u32() !== 0
  const fuel = data.f64()
  const operations = data.f64()
  const stdout = data.bytes()
  const stderr = data.bytes()
  const missing: string[] = []
  for (let left = data.u32(); left > 0; left--) missing.push(text.decode(data.bytes()))
  return {
    ended: how,
    fuel,
    halted: host.halted,
    missing,
    operations,
    status,
    stderr,
    stdout,
    truncated,
  }
}

type Operation = {
  data: Uint8Array
  mode: number
  mtime: number
  operation: number
  other: string
  path: string
}

function operation(call: operation.Call): Operation {
  const out: Operation = {
    data: empty,
    mode: 0,
    mtime: 0,
    operation: call.operation,
    other: '',
    path: '',
  }

  switch (call.operation) {
    case fsOp.writeReplace:
    case fsOp.writeAppend:
    case fsOp.writeNew: {
      const fields = reader(call.payload)
      out.path = text.decode(fields.bytes())
      out.data = fields.rest()
      return out
    }

    case fsOp.mkdir:
    case fsOp.setMode: {
      const fields = reader(call.payload)
      out.mode = fields.u32()
      out.path = text.decode(fields.rest())
      return out
    }

    case fsOp.rename:
    case fsOp.symlink: {
      const fields = reader(call.payload)
      out.other = text.decode(fields.bytes())
      out.path = text.decode(fields.rest())
      return out
    }

    case fsOp.setMtime: {
      const fields = reader(call.payload)
      out.mtime = fields.f64()
      out.path = text.decode(fields.rest())
      return out
    }

    default:
      out.path = text.decode(call.payload)
      return out
  }
}

declare namespace operation {
  type Call = {
    operation: number
    payload: Uint8Array
  }
}

function refuse(name: string, path: string): never {
  throw new FileSystem.FsError(name, path)
}

function statBytes(stat: FileSystem.FileStat | FileSystem.LinkStat | null, path: string) {
  if (!stat) return refuse('ENOENT', path)

  const out = new Uint8Array(24)
  const view = new DataView(out.buffer)
  view.setFloat64(0, stat.size, true)
  view.setFloat64(8, stat.mtime, true)
  view.setUint32(16, stat.mode, true)
  view.setUint32(20, stat.kind === 'file' ? 0 : stat.kind === 'directory' ? 1 : 2, true)
  return out
}

function removable(stat: FileSystem.FileStat | FileSystem.LinkStat | null, call: Operation): void {
  if (!stat) return refuse('ENOENT', call.path)
  const directory = stat.kind === 'directory'
  if (call.operation === fsOp.removeFile && directory) return refuse('EISDIR', call.path)
  if (call.operation === fsOp.removeDir && !directory) return refuse('ENOTDIR', call.path)
}

async function perform(host: Host, call: Operation): Promise<Uint8Array | undefined> {
  const fs = host.options.fs
  const path = call.path

  switch (call.operation) {
    case fsOp.stat:
      return statBytes(await fs.stat(path), path)

    case fsOp.lstat:
      return statBytes(fs.lstat ? await fs.lstat(path) : await fs.stat(path), path)

    case fsOp.read: {
      const data = await fs.read(path)
      if (data.length > host.options.limits.file) return refuse('EFBIG', path)
      return data
    }

    case fsOp.writeNew:
      if (await fs.stat(path)) return refuse('EEXIST', path)
      await fs.write(path, call.data)
      return undefined

    case fsOp.writeReplace:
    case fsOp.writeAppend:
      await fs.write(path, call.data, call.operation === fsOp.writeAppend)
      return undefined

    case fsOp.list:
      return utf8.encode((await fs.list(path)).join('\0'))

    case fsOp.mkdir:
      await fs.mkdir(path)
      if (call.mode !== 0o755 && fs.chmod) await fs.chmod(path, call.mode)
      return undefined

    case fsOp.removeFile:
    case fsOp.removeDir:
      removable(fs.lstat ? await fs.lstat(path) : await fs.stat(path), call)
      await fs.remove(path)
      return undefined

    case fsOp.rename:
      await fs.rename(call.other, path)
      return undefined

    case fsOp.symlink:
      if (!fs.symlink) return refuse('ENOTSUP', path)
      await fs.symlink(call.other, path)
      return undefined

    case fsOp.readLink: {
      if (!fs.readlink) return refuse('ENOTSUP', path)
      const target = await fs.readlink(path)
      if (target === null) return refuse('EINVAL', path)
      return utf8.encode(target)
    }

    case fsOp.setMode:
      if (!fs.chmod) return refuse('ENOTSUP', path)
      await fs.chmod(path, call.mode)
      return undefined

    case fsOp.setMtime:
      if (!fs.utimes) return refuse('ENOTSUP', path)
      await fs.utimes(path, call.mtime)
      return undefined

    default:
      throw new EngineError('psh asked for an unknown file operation ' + call.operation)
  }
}

function performNow(host: Host, call: performNow.Call): Uint8Array | undefined {
  const fs = call.fs
  const op = call.operation
  const path = op.path

  switch (op.operation) {
    case fsOp.stat:
      return statBytes(fs.stat(path), path)

    case fsOp.lstat:
      return statBytes(fs.lstat ? fs.lstat(path) : fs.stat(path), path)

    case fsOp.read: {
      const data = fs.read(path)
      if (data.length > host.options.limits.file) return refuse('EFBIG', path)
      return data
    }

    case fsOp.writeNew:
      if (fs.stat(path)) return refuse('EEXIST', path)
      fs.write(path, op.data)
      return undefined

    case fsOp.writeReplace:
    case fsOp.writeAppend:
      fs.write(path, op.data, op.operation === fsOp.writeAppend)
      return undefined

    case fsOp.list:
      return utf8.encode(fs.list(path).join('\0'))

    case fsOp.mkdir:
      fs.mkdir(path)
      if (op.mode !== 0o755 && fs.chmod) fs.chmod(path, op.mode)
      return undefined

    case fsOp.removeFile:
    case fsOp.removeDir:
      removable(fs.lstat ? fs.lstat(path) : fs.stat(path), op)
      fs.remove(path)
      return undefined

    case fsOp.rename:
      fs.rename(op.other, path)
      return undefined

    case fsOp.symlink:
      if (!fs.symlink) return refuse('ENOTSUP', path)
      fs.symlink(op.other, path)
      return undefined

    case fsOp.readLink: {
      if (!fs.readlink) return refuse('ENOTSUP', path)
      const target = fs.readlink(path)
      if (target === null) return refuse('EINVAL', path)
      return utf8.encode(target)
    }

    case fsOp.setMode:
      if (!fs.chmod) return refuse('ENOTSUP', path)
      fs.chmod(path, op.mode)
      return undefined

    case fsOp.setMtime:
      if (!fs.utimes) return refuse('ENOTSUP', path)
      fs.utimes(path, op.mtime)
      return undefined

    default:
      throw new EngineError('psh asked for an unknown file operation ' + op.operation)
  }
}

declare namespace performNow {
  type Call = {
    fs: FileSystem.SyncFileSystem
    operation: Operation
  }
}

function has(host: Host, name: string): boolean {
  if (name.includes('/')) return name.endsWith('.wasm') && host.options.commands.has('wasm')
  return host.options.commands.has(name)
}

function stop(instance: Instance, entry: stop.Entry): void {
  const proc = entry.proc
  proc.live = false
  instance.procs.delete(entry.pid)
  proc.controller.abort()
  for (const request of proc.pending) {
    const resolve = instance.requests.get(request)
    instance.requests.delete(request)
    resolve?.({ data: empty, err: errno.EPIPE! })
  }
  proc.pending.clear()
}

declare namespace stop {
  type Entry = {
    pid: number
    proc: Proc
  }
}

function spawn(instance: Instance, options: spawn.Options): void {
  const fields = reader(options.payload)
  const argv: string[] = []
  for (let left = fields.u32(); left > 0; left--) argv.push(decode(fields.bytes()))
  const env: Record<string, string> = {}
  for (let left = fields.u32(); left > 0; left--) {
    const name = text.decode(fields.bytes())
    env[name] = decode(fields.bytes())
  }
  const cwd = text.decode(fields.bytes())
  const captured = fields.u32()

  const proc: Proc = {
    controller: new AbortController(),
    host: options.host,
    live: true,
    pending: new Set(),
  }
  instance.procs.set(options.pid, proc)

  void Promise.resolve()
    .then(() => command(instance, { argv, captured, cwd, env, pid: options.pid, proc }))
    .catch((error: unknown) => {
      if (proc.controller.signal.aborted) return 143
      options.host.failure ??= error
      options.host.cancel()
      return 1
    })
    .then((status) => {
      if (!proc.live || instance.failure !== undefined) return
      proc.live = false
      instance.procs.delete(options.pid)
      try {
        instance.exports.psh_proc_exit(options.pid, status)
      } catch (error) {
        instance.failure =
          'psh stopped: ' + (error instanceof Error ? error.message : String(error))
        for (const host of instance.shells.values()) wake(host)
      }
    })
}

declare namespace spawn {
  type Options = {
    host: Host
    payload: Uint8Array
    pid: number
  }
}

function ask(instance: Instance, options: ask.Options): Promise<Reply> {
  if (!options.proc.live || instance.failure !== undefined)
    return Promise.resolve({ data: empty, err: errno.EPIPE! })

  return new Promise<Reply>((resolve) => {
    const request = instance.nextRequest++
    instance.requests.set(request, (reply) => {
      options.proc.pending.delete(request)
      resolve(reply)
    })
    options.proc.pending.add(request)
    try {
      options.send(request)
    } catch (error) {
      instance.failure = 'psh stopped: ' + (error instanceof Error ? error.message : String(error))
      for (const host of instance.shells.values()) wake(host)
      instance.requests.delete(request)
      resolve({ data: empty, err: errno.EPIPE! })
    }
  })
}

declare namespace ask {
  type Options = {
    proc: Proc
    send(request: number): void
  }
}

function halt(host: Host, message: string): number {
  host.halted ??= message
  host.cancel()
  return 127
}

function quote(word: string): string {
  return "'" + word.replaceAll("'", "'\\''") + "'"
}

async function command(instance: Instance, call: command.Call): Promise<number> {
  const proc = call.proc
  const host = proc.host
  const options = host.options
  const x = instance.exports
  const first = call.argv[0] ?? ''
  const path = first.includes('/')
  const name = path ? 'wasm' : first
  const handler = options.commands.get(name)
  if (!handler) return 127

  if (options.strict && !options.fetch && (name === 'curl' || name === 'wget'))
    return halt(host, name + ': network access is not available in this shell')
  if (options.strict && name === 'file')
    return halt(host, 'file: (this simulated shell has no libmagic database of file types)')

  const write = async (fd: number, chunk: string) => {
    const reply = await ask(instance, {
      proc,
      send: (request) => x.psh_proc_write(call.pid, request, fd, input(instance, encode(chunk))),
    })
    if (reply.err) throw new Shell.PipeError()
  }
  const limits = options.shellLimits
  const feed: Shell.Pipe = new Shell.Pipe(
    limits.maxBufferLength,
    proc.controller.signal,
    limits.maxMemoryBytes,
    async () => {
      const reply = await ask(instance, {
        proc,
        send: (request) => x.psh_proc_read(call.pid, request, readBytes),
      })
      if (reply.err || !reply.data.length) feed.end()
      else feed.push(decode(reply.data))
    },
  )
  const stdin = Shell.Input.pipe(feed)
  const pumps: Promise<void>[] = []
  const closers: (() => void)[] = []
  const output = (fd: number): Shell.Output => {
    if (call.captured & fd)
      return Shell.Output.spill(limits.maxBufferLength, (chunk) => write(fd, chunk))

    const pipe = new Shell.Pipe(limits.maxBufferLength, proc.controller.signal)
    closers.push(() => pipe.end())
    pumps.push(
      (async () => {
        try {
          for (let chunk = await pipe.take(); chunk !== null; chunk = await pipe.take())
            await write(fd, chunk)
        } catch {
          pipe.close()
        }
      })(),
    )
    return Shell.Output.pipe(pipe)
  }
  const stdout = output(1)
  const stderr = output(2)

  const nested = async (script: string, given: string | undefined) => {
    await stdout.settle()
    await stderr.settle()
    return run(instance.module, {
      ...options,
      cwd: call.cwd,
      env: call.env,
      script,
      signal: proc.controller.signal,
      stdin: given === undefined ? undefined : encode(given),
    })
  }

  const context: Shell.CommandContext = {
    args: path ? call.argv : call.argv.slice(1),
    cwd: call.cwd,
    env: call.env,
    exec: async (script, given) => {
      const ran = await nested(script, given)
      if (ran.stderr.length) stderr.write(decode(ran.stderr))
      return { status: ran.status, stdout: decode(ran.stdout) }
    },
    fetch: options.fetch,
    fs: options.commandFs,
    limits,
    name,
    resolve: (target) => FileSystem.resolvePath(call.cwd, target),
    run: async (argv, given) => {
      const ran = await nested(argv.map(quote).join(' '), given)
      if (ran.stdout.length) stdout.write(decode(ran.stdout))
      if (ran.stderr.length) stderr.write(decode(ran.stderr))
      return ran.status
    },
    signal: proc.controller.signal,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        proc.controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      }),
    stderr,
    stdin,
    stdout,
    umask: 0o022,
  }

  let status: number
  try {
    if (Shell.buffered(name, { commands: options.commands, handler })) await stdin.fill()
    status = (await handler(context)) ?? 0
  } catch (error) {
    status = await (async () => {
      if (error instanceof Shell.PipeError) return 141
      if (error instanceof Shell.ExitSignal) return error.status
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof Shell.LimitError) {
        stderr.write('bash: ' + message + '\n')
        return error.status
      }
      if (options.strict && Shell.UNSUPPORTED.test(message))
        return halt(host, name + ': ' + message + ' (this simulated shell has no support for this)')
      stderr.write(name + ': ' + message + '\n')
      return error instanceof Shell.CommandError ? error.status : 1
    })()
  }

  try {
    await stdout.settle()
    await stderr.settle()
  } catch (error) {
    if (!(error instanceof Shell.PipeError)) throw error
    status = 141
  }
  for (const close of closers) close()
  await Promise.all(pumps)
  return status
}

declare namespace command {
  type Call = {
    argv: string[]
    captured: number
    cwd: string
    env: Record<string, string>
    pid: number
    proc: Proc
  }
}

import { CommandError, LimitError, type CommandContext, type CommandHandler } from '../Shell.ts'
import { FsError, normalize, type FileSystem } from '../../FileSystem.ts'
import { decode, encode, parentOf } from '../Fs.ts'
import { mkdirs } from './files.ts'
import { load, Refused, Trap, type HostFunction, type Live, type Loaded } from './engine.ts'
import type * as Wasm from '../../Wasm.ts'

const SNAPSHOT_BYTES = 64 * 1024 * 1024

const SNAPSHOT_ENTRIES = 20_000

const MODULES = new Map<string, { loaded: Loaded; interpreter: Wasm.Options['interpreter'] }>()

const INTERPRETED_CACHE_BYTES = 4 * 1024 * 1024

const E = {
  SUCCESS: 0,
  ACCES: 2,
  BADF: 8,
  EXIST: 20,
  FBIG: 22,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  NOENT: 44,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTSUP: 58,
  PERM: 63,
  SPIPE: 70,
  NOTCAPABLE: 76,
  NAMETOOLONG: 37,
  NOTSOCK: 57,
} as const

const FILETYPE = { CHAR: 2, DIRECTORY: 3, FILE: 4 } as const

const FILE_RIGHTS =
  0x1 |
  0x2 |
  0x4 |
  0x8 |
  0x10 |
  0x20 |
  0x40 |
  0x80 |
  0x100 |
  0x200000 |
  0x400000 |
  0x800000 |
  0x8000000

const DIR_RIGHTS =
  0x1 |
  0x8 |
  0x10 |
  0x200 |
  0x400 |
  0x800 |
  0x1000 |
  0x2000 |
  0x4000 |
  0x8000 |
  0x10000 |
  0x20000 |
  0x40000 |
  0x80000 |
  0x100000 |
  0x200000 |
  0x800000 |
  0x1000000 |
  0x2000000 |
  0x4000000

const READ = 0x2n

const WRITE = 0x40n

const now = () => BigInt(Date.now()) * 1_000_000n

type FileNode = {
  kind: 'file'
  id: number
  data: Uint8Array
  size: number
  owned: boolean
  dirty: boolean
  loaded: boolean
  mtime: bigint
  atime: bigint
}

type DirNode = {
  kind: 'dir'
  id: number
  children: Map<string, Node>
  partial: boolean
  mtime: bigint
  atime: bigint
}

type Node = FileNode | DirNode

type Handle =
  | { kind: 'stdin'; rights: bigint; flags: number }
  | { kind: 'stdout' | 'stderr'; rights: bigint; flags: number }
  | { kind: 'file'; node: FileNode; path: string; position: number; rights: bigint; flags: number }
  | {
      kind: 'dir'
      node: DirNode
      path: string
      root: string
      preopen: string | null
      rights: bigint
      inheriting: bigint
      flags: number
    }

class Exit {
  readonly code: number
  constructor(code: number) {
    this.code = code
  }
}

class Tree {
  readonly root: DirNode
  readonly original = new Map<string, Node>()
  #ids = 1
  bytes = 0
  entries = 0
  limit = SNAPSHOT_BYTES

  constructor() {
    this.root = this.dir(true)
  }

  dir(partial: boolean): DirNode {
    return {
      kind: 'dir',
      id: this.#ids++,
      children: new Map(),
      partial,
      mtime: now(),
      atime: now(),
    }
  }

  file(data: Uint8Array, loaded: boolean, mtime = now()): FileNode {
    return {
      kind: 'file',
      id: this.#ids++,
      data,
      size: data.length,
      owned: false,
      dirty: false,
      loaded,
      mtime,
      atime: mtime,
    }
  }

  find(path: string): Node | undefined {
    let node: Node | undefined = this.root
    for (const part of path.split('/').filter(Boolean)) {
      if (!node || node.kind !== 'dir') return undefined
      node = node.children.get(part)
    }
    return node
  }

  ensure(path: string): DirNode {
    let node: DirNode = this.root
    let current = ''
    for (const part of path.split('/').filter(Boolean)) {
      current += '/' + part
      let next = node.children.get(part)
      if (!next || next.kind !== 'dir') {
        next = this.dir(true)
        node.children.set(part, next)
        this.original.set(current, next)
      }
      node = next
    }
    return node
  }

  async load(fs: FileSystem, path: string, depth: number, explicit: boolean): Promise<void> {
    if (this.entries++ > SNAPSHOT_ENTRIES) {
      if (explicit)
        throw new CommandError(
          'too many files to load under ' +
            path +
            ' (more than ' +
            SNAPSHOT_ENTRIES +
            '); run it from a smaller directory',
          1,
        )
      return
    }
    const stat = await readable(explicit, () => fs.stat(path))
    if (!stat) return
    const name = path.split('/').filter(Boolean).pop()
    if (stat.kind === 'file') {
      const parent = this.ensure(parentOf(path))
      if (name === undefined || parent.children.get(name)?.kind === 'file') return
      let node: FileNode
      if (this.bytes + stat.size <= this.limit) {
        const data = await readable(explicit, () => fs.read(path))
        if (!data) return
        this.bytes += data.length
        node = this.file(data, true, BigInt(Math.floor(stat.mtime)) * 1_000_000n)
      } else {
        if (explicit)
          throw new CommandError(
            path +
              ' does not fit in the ' +
              Math.floor(this.limit / 1048576) +
              ' MiB of files a program can load',
            1,
          )
        node = this.file(new Uint8Array(), false, BigInt(Math.floor(stat.mtime)) * 1_000_000n)
        node.size = stat.size
      }
      parent.children.set(name, node)
      this.original.set(path, node)
      return
    }
    const dir = name === undefined ? this.root : this.ensure(path)
    if (!dir.partial || depth < 0) return
    const children = await readable(explicit, () => fs.list(path))
    if (!children) return
    dir.partial = false
    for (const child of children) {
      if (this.entries > SNAPSHOT_ENTRIES) {
        dir.partial = true
        break
      }
      await this.load(fs, (path === '/' ? '' : path) + '/' + child, depth - 1, false)
    }
  }
}

async function readable<T>(explicit: boolean, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    if (explicit || !(error instanceof FsError)) throw error
    return undefined
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function compile(bytes: Uint8Array, options: Wasm.Options = {}): Promise<Loaded> {
  const key = (await sha256(bytes)) + (options.force ? ':interpreter' : '')
  const cached = MODULES.get(key)
  if (cached && cached.interpreter === options.interpreter) return cached.loaded
  let loaded: Loaded
  try {
    loaded = await load(bytes, options)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (error instanceof Refused) throw new CommandError(text, 126)
    throw new CommandError('invalid WebAssembly module: ' + text, 126)
  }
  if (cached) cached.loaded.dispose()
  if (MODULES.size >= 16) {
    const oldest = MODULES.keys().next().value!
    MODULES.get(oldest)?.loaded.dispose()
    MODULES.delete(oldest)
  }
  if (loaded.engine === 'interpreter' && bytes.length > INTERPRETED_CACHE_BYTES) return loaded
  MODULES.set(key, { loaded, interpreter: options.interpreter })
  return loaded
}

export function release(loaded: Loaded): void {
  for (const entry of MODULES.values()) if (entry.loaded === loaded) return
  loaded.dispose()
}

export function isWasm(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d
  )
}

type Run = {
  file: string
  args: string[]
  env: Record<string, string>
  invoke: string | undefined
  dirs: { host: string; guest: string }[]
}

function parse(ctx: CommandContext): Run {
  const args = ctx.args.slice()
  const run: Run = {
    file: '',
    args: [],
    env: ctx.name === 'wasmtime' ? {} : { ...ctx.env },
    invoke: undefined,
    dirs: [],
  }
  if (ctx.name === 'wasmtime' && args[0] === 'run') args.shift()
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      i++
      break
    }
    if (!arg.startsWith('-') || arg === '-') break
    const value = () => {
      const eq = arg.indexOf('=')
      if (eq > 0 && arg.startsWith('--')) return arg.slice(eq + 1)
      const next = args[++i]
      if (next === undefined) throw new CommandError('option ' + arg + ' requires a value', 2)
      return next
    }
    const name = arg.replace(/=.*$/, '')
    if (name === '--env' || name === '-e') {
      const pair = value()
      const eq = pair.indexOf('=')
      if (eq > 0) run.env[pair.slice(0, eq)] = pair.slice(eq + 1)
    } else if (name === '--dir' || name === '--mapdir') {
      const spec = value()
      const cut = spec.indexOf('::')
      const [first, second] = cut < 0 ? [spec, spec] : [spec.slice(0, cut), spec.slice(cut + 2)]
      run.dirs.push(
        name === '--dir' ? { host: first, guest: second } : { host: second, guest: first },
      )
    } else if (name === '--invoke') run.invoke = value()
    else if (['-W', '-S', '-O', '-C', '--wasm', '--wasi', '--optimize', '--codegen'].includes(name))
      value()
    else throw new CommandError('unsupported option ' + arg, 2)
  }
  const file = args[i]
  if (file === undefined)
    throw new CommandError(
      'usage: ' +
        ctx.name +
        (ctx.name === 'wasmtime' ? ' [run]' : '') +
        ' [--env K=V] [--invoke FUNC] FILE.wasm [ARGS...]',
      2,
    )
  run.file = file
  run.args = args.slice(i + 1)
  return run
}

const handler =
  (options: Wasm.Options): CommandHandler =>
  async (ctx) => {
    const run = parse(ctx)
    const path = ctx.resolve(run.file)
    const stat = await ctx.fs.stat(path)
    if (!stat) throw new CommandError(run.file + ': No such file or directory', 127)
    if (stat.kind !== 'file') throw new CommandError(run.file + ': Is a directory', 126)
    const bytes = await ctx.fs.read(path)
    if (!isWasm(bytes))
      throw new CommandError(run.file + ': not a WebAssembly module (no \\0asm header)', 126)
    const module = await compile(bytes, options)
    const tree = new Tree()
    tree.limit = Math.min(SNAPSHOT_BYTES, Math.floor(ctx.limits.maxMemoryBytes / 2))
    for (const arg of [...run.dirs.map((dir) => dir.host), ...run.args]) {
      if (!arg || arg.startsWith('-') || arg.length > 4096) continue
      const target = ctx.resolve(arg.replace(/^[A-Za-z_-]+=/, ''))
      if (target === '/') continue
      const found = await ctx.fs.stat(target).catch(() => null)
      if (found) await tree.load(ctx.fs, target, 64, true)
    }
    await tree.load(ctx.fs, ctx.cwd, ctx.cwd === '/' ? 0 : 64, false)
    await tree.load(ctx.fs, '/', options.rootDepth ?? 2, false)
    const result = execute(ctx, module, tree, run)
    release(module)
    await writeBack(ctx.fs, tree)
    if (result.error !== undefined) throw result.error
    return result.code
  }

type Result = { code: number; error?: unknown }

function execute(ctx: CommandContext, module: Loaded, tree: Tree, run: Run): Result {
  const deadline = Date.now() + ctx.limits.timeoutMs
  let live: Live | undefined
  let stdin: Uint8Array | null = null
  let stdinPosition = 0
  const warned = new Set<string>()
  const fds = new Map<number, Handle>()
  fds.set(0, { kind: 'stdin', rights: BigInt(FILE_RIGHTS) & ~WRITE, flags: 0 })
  fds.set(1, { kind: 'stdout', rights: BigInt(FILE_RIGHTS) & ~READ, flags: 0 })
  fds.set(2, { kind: 'stderr', rights: BigInt(FILE_RIGHTS) & ~READ, flags: 0 })
  const preopens = run.dirs.length
    ? run.dirs.map((dir) => ({
        path: normalize(dir.host.startsWith('/') ? dir.host : ctx.cwd + '/' + dir.host),
        guest: dir.guest,
      }))
    : [
        { path: '/', guest: '/' },
        { path: ctx.cwd, guest: '.' },
      ]
  let nextFd = 3
  for (const preopen of preopens) {
    const node = tree.find(preopen.path)
    if (node?.kind !== 'dir')
      return { code: 126, error: new CommandError(preopen.path + ': not a directory', 126) }
    fds.set(nextFd++, {
      kind: 'dir',
      node,
      path: preopen.path,
      root: run.dirs.length ? preopen.path : '/',
      preopen: preopen.guest,
      rights: BigInt(DIR_RIGHTS),
      inheriting: BigInt(DIR_RIGHTS | FILE_RIGHTS),
      flags: 0,
    })
  }
  const argv = [run.file, ...run.args].map((arg) => encode(arg + '\0'))
  const environ = Object.entries(run.env).map(([key, value]) => encode(key + '=' + value + '\0'))

  const view = () => live!.view()
  const bytes = () => live!.bytes()
  const text = (pointer: number, length: number) =>
    new TextDecoder().decode(bytes().subarray(pointer, pointer + length))
  const check = () => {
    if (ctx.signal.aborted || Date.now() > deadline)
      throw new LimitError('wasm: execution timed out after ' + ctx.limits.timeoutMs + ' ms', 124)
  }

  const resolveAt = (fd: number, raw: string): { path: string; slash: boolean } | number => {
    const handle = fds.get(fd)
    if (!handle) return E.BADF
    if (handle.kind !== 'dir') return E.NOTDIR
    const slash = /[^/]\/+$/.test(raw)
    if (raw.includes('\0')) return E.INVAL
    if (raw.startsWith('/')) return E.PERM
    const local = normalize(handle.path + '/' + raw)
    if (local !== handle.root && !local.startsWith(handle.root === '/' ? '/' : handle.root + '/'))
      return E.PERM
    if (handle.preopen === '.' && !tree.find(local)) {
      const absolute = normalize('/' + raw)
      if (tree.find(absolute) || (!tree.find(parentOf(local)) && tree.find(parentOf(absolute))))
        return { path: absolute, slash }
    }
    return { path: local, slash }
  }

  const lookup = (
    path: string,
  ): { parent: DirNode | undefined; name: string; node: Node | undefined } => {
    const name = path.split('/').filter(Boolean).pop() ?? ''
    const parent = tree.find(parentOf(path))
    const node =
      name === '' ? tree.root : parent?.kind === 'dir' ? parent.children.get(name) : undefined
    return { parent: parent?.kind === 'dir' ? parent : undefined, name, node }
  }

  const loadedOrFail = (node: FileNode, path: string): number => {
    if (node.loaded) return E.SUCCESS
    if (!warned.has(path)) {
      warned.add(path)
      ctx.stderr.write(
        'wasm: ' +
          path +
          ' was not loaded for this program (' +
          Math.floor(tree.limit / 1048576) +
          ' MiB limit); pass it as an argument or run from its directory\n',
      )
    }
    return E.FBIG
  }

  const own = (node: FileNode, capacity: number) => {
    if (node.owned && node.data.length >= capacity) return
    const data = new Uint8Array(
      Math.max(capacity, node.owned ? node.data.length * 2 : node.size, 64),
    )
    data.set(node.data.subarray(0, Math.min(node.size, data.length)))
    node.data = data
    node.owned = true
  }

  const writeFile = (node: FileNode, position: number, chunk: Uint8Array) => {
    const end = position + chunk.length
    if (end > ctx.limits.maxBufferLength * 4)
      throw new LimitError('wasm: a file grew beyond ' + ctx.limits.maxBufferLength * 4 + ' bytes')
    own(node, end)
    if (position > node.size) node.data.fill(0, node.size, position)
    node.data.set(chunk, position)
    if (end > node.size) node.size = end
    node.dirty = true
    node.mtime = now()
  }

  const gather = (iovs: number, count: number): Uint8Array => {
    const dv = view()
    const parts: Uint8Array[] = []
    let total = 0
    for (let i = 0; i < count; i++) {
      const pointer = dv.getUint32(iovs + i * 8, true)
      const length = dv.getUint32(iovs + i * 8 + 4, true)
      parts.push(bytes().slice(pointer, pointer + length))
      total += length
    }
    if (parts.length === 1) return parts[0]
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }

  const scatter = (iovs: number, count: number, source: Uint8Array): number => {
    const dv = view()
    let offset = 0
    for (let i = 0; i < count && offset < source.length; i++) {
      const pointer = dv.getUint32(iovs + i * 8, true)
      const length = dv.getUint32(iovs + i * 8 + 4, true)
      const take = Math.min(length, source.length - offset)
      bytes().set(source.subarray(offset, offset + take), pointer)
      offset += take
    }
    return offset
  }

  const filestat = (pointer: number, node: Node | 'char') => {
    const dv = view()
    for (let i = 0; i < 64; i += 8) dv.setBigUint64(pointer + i, 0n, true)
    if (node === 'char') {
      dv.setUint8(pointer + 16, FILETYPE.CHAR)
      dv.setBigUint64(pointer + 24, 1n, true)
      return
    }
    const time = node.mtime
    dv.setBigUint64(pointer + 8, BigInt(node.id), true)
    dv.setUint8(pointer + 16, node.kind === 'dir' ? FILETYPE.DIRECTORY : FILETYPE.FILE)
    dv.setBigUint64(pointer + 24, 1n, true)
    dv.setBigUint64(pointer + 32, BigInt(node.kind === 'file' ? node.size : 4096), true)
    dv.setBigUint64(pointer + 40, node.atime, true)
    dv.setBigUint64(pointer + 48, time, true)
    dv.setBigUint64(pointer + 56, time, true)
  }

  const sizes = (list: Uint8Array[], countPointer: number, sizePointer: number) => {
    view().setUint32(countPointer, list.length, true)
    view().setUint32(
      sizePointer,
      list.reduce((sum, item) => sum + item.length, 0),
      true,
    )
    return E.SUCCESS
  }

  const strings = (list: Uint8Array[], pointers: number, buffer: number) => {
    let offset = buffer
    list.forEach((item, index) => {
      view().setUint32(pointers + index * 4, offset, true)
      bytes().set(item, offset)
      offset += item.length
    })
    return E.SUCCESS
  }

  const emit = (kind: 'stdout' | 'stderr', chunk: Uint8Array) => {
    const out = kind === 'stdout' ? ctx.stdout : ctx.stderr
    out.write(decode(chunk))
  }

  const removeNode = (path: string, directory: boolean): number => {
    const found = lookup(path)
    if (!found.parent || !found.node) return E.NOENT
    if (directory) {
      if (found.node.kind !== 'dir') return E.NOTDIR
      if (found.node.children.size || found.node.partial) return E.NOTEMPTY
    } else if (found.node.kind === 'dir') return E.ISDIR
    found.parent.children.delete(found.name)
    return E.SUCCESS
  }

  const times = (node: Node, atim: bigint, mtim: bigint, flags: number): number => {
    if ((flags & 3) === 3 || (flags & 12) === 12 || flags > 15) return E.INVAL
    if (flags & 1) node.atime = atim
    else if (flags & 2) node.atime = now()
    if (flags & 4) node.mtime = mtim
    else if (flags & 8) node.mtime = now()
    return E.SUCCESS
  }

  const file = (fd: number): Extract<Handle, { kind: 'file' }> | number => {
    const handle = fds.get(fd)
    if (!handle) return E.BADF
    if (handle.kind !== 'file') return handle.kind === 'dir' ? E.ISDIR : E.SPIPE
    return handle
  }

  let skew = 0n
  const clock = (id: number) =>
    (id === 0
      ? BigInt(Date.now()) * 1_000_000n
      : BigInt(Math.round(performance.now() * 1_000_000))) + skew

  const wasi: Record<string, (...args: never[]) => number> = {
    args_get: (pointers: number, buffer: number) => strings(argv, pointers, buffer),
    args_sizes_get: (count: number, size: number) => sizes(argv, count, size),
    environ_get: (pointers: number, buffer: number) => strings(environ, pointers, buffer),
    environ_sizes_get: (count: number, size: number) => sizes(environ, count, size),
    clock_res_get: (_id: number, pointer: number) => {
      view().setBigUint64(pointer, 1000n, true)
      return E.SUCCESS
    },
    clock_time_get: (id: number, _precision: bigint, pointer: number) => {
      check()
      view().setBigUint64(pointer, clock(id), true)
      return E.SUCCESS
    },
    random_get: (pointer: number, length: number) => {
      for (let offset = 0; offset < length; offset += 65536)
        crypto.getRandomValues(
          bytes().subarray(pointer + offset, pointer + Math.min(length, offset + 65536)),
        )
      return E.SUCCESS
    },
    proc_raise: (signal: number) => {
      throw new Exit(128 + signal)
    },
    proc_exit: (code: number) => {
      throw new Exit(code)
    },
    sched_yield: () => {
      check()
      return E.SUCCESS
    },
    poll_oneoff: (input: number, output: number, count: number, eventsPointer: number) => {
      check()
      const dv = view()
      const subs = Array.from({ length: count }, (_, i) => input + i * 48)
      const io = subs.filter((sub) => dv.getUint8(sub + 8) !== 0)
      if (!io.length && subs.length) {
        const waits = subs.map((sub) => {
          const timeout = dv.getBigUint64(sub + 24, true)
          return dv.getUint16(sub + 40, true) & 1
            ? timeout - clock(dv.getUint32(sub + 16, true))
            : timeout
        })
        const wait = waits.reduce((a, b) => (b < a ? b : a))
        if (wait > 0n) skew += wait
      }
      let events = 0
      for (const sub of io.length ? io : subs) {
        const event = output + events++ * 32
        const tag = dv.getUint8(sub + 8)
        const handle = tag === 0 ? undefined : fds.get(dv.getUint32(sub + 16, true))
        dv.setBigUint64(event, dv.getBigUint64(sub, true), true)
        dv.setUint16(event + 8, tag !== 0 && !handle ? E.BADF : E.SUCCESS, true)
        dv.setUint8(event + 10, tag)
        dv.setBigUint64(
          event + 16,
          handle?.kind === 'file' ? BigInt(Math.max(0, handle.node.size - handle.position)) : 0n,
          true,
        )
        dv.setUint16(event + 24, 0, true)
      }
      dv.setUint32(eventsPointer, events, true)
      return E.SUCCESS
    },
    fd_write: (fd: number, iovs: number, count: number, written: number) => {
      check()
      const handle = fds.get(fd)
      if (!handle) return E.BADF
      const chunk = gather(iovs, count)
      if (handle.kind === 'stdout' || handle.kind === 'stderr') emit(handle.kind, chunk)
      else if (handle.kind === 'file' && handle.rights & WRITE) {
        if (handle.flags & 1) handle.position = handle.node.size
        writeFile(handle.node, handle.position, chunk)
        handle.position += chunk.length
      } else return E.BADF
      view().setUint32(written, chunk.length, true)
      return E.SUCCESS
    },
    fd_pwrite: (fd: number, iovs: number, count: number, offset: bigint, written: number) => {
      const handle = file(fd)
      if (typeof handle === 'number') return handle
      if (!(handle.rights & WRITE)) return E.BADF
      const chunk = gather(iovs, count)
      writeFile(handle.node, Number(offset), chunk)
      view().setUint32(written, chunk.length, true)
      return E.SUCCESS
    },
    fd_read: (fd: number, iovs: number, count: number, read: number) => {
      check()
      const handle = fds.get(fd)
      if (!handle) return E.BADF
      if (handle.kind === 'stdin') {
        stdin ??= encode(ctx.stdin.read())
        const n = scatter(iovs, count, stdin.subarray(stdinPosition))
        stdinPosition += n
        view().setUint32(read, n, true)
        return E.SUCCESS
      }
      if (handle.kind === 'dir') return E.ISDIR
      if (handle.kind !== 'file' || !(handle.rights & READ)) return E.BADF
      const n = scatter(
        iovs,
        count,
        handle.node.data.subarray(Math.min(handle.position, handle.node.size), handle.node.size),
      )
      handle.position += n
      view().setUint32(read, n, true)
      return E.SUCCESS
    },
    fd_pread: (fd: number, iovs: number, count: number, offset: bigint, read: number) => {
      const handle = file(fd)
      if (typeof handle === 'number') return handle
      if (!(handle.rights & READ)) return E.BADF
      const start = Math.min(Number(offset), handle.node.size)
      view().setUint32(
        read,
        scatter(iovs, count, handle.node.data.subarray(start, handle.node.size)),
        true,
      )
      return E.SUCCESS
    },
    fd_seek: (fd: number, offset: bigint, whence: number, result: number) => {
      const handle = file(fd)
      if (typeof handle === 'number') return handle === E.ISDIR ? E.BADF : handle
      const base =
        whence === 0 ? 0 : whence === 1 ? handle.position : whence === 2 ? handle.node.size : -1
      if (base < 0) return E.INVAL
      const position = base + Number(offset)
      if (position < 0) return E.INVAL
      handle.position = position
      view().setBigUint64(result, BigInt(position), true)
      return E.SUCCESS
    },
    fd_tell: (fd: number, result: number) => {
      const handle = file(fd)
      if (typeof handle === 'number') return handle === E.ISDIR ? E.BADF : handle
      view().setBigUint64(result, BigInt(handle.position), true)
      return E.SUCCESS
    },
    fd_close: (fd: number) => (fds.delete(fd) ? E.SUCCESS : E.BADF),
    fd_renumber: (from: number, to: number) => {
      const handle = fds.get(from)
      if (!handle || !fds.has(to)) return E.BADF
      fds.set(to, handle)
      fds.delete(from)
      return E.SUCCESS
    },
    fd_fdstat_get: (fd: number, pointer: number) => {
      const handle = fds.get(fd)
      if (!handle) return E.BADF
      const dv = view()
      dv.setUint8(
        pointer,
        handle.kind === 'dir'
          ? FILETYPE.DIRECTORY
          : handle.kind === 'file'
            ? FILETYPE.FILE
            : FILETYPE.CHAR,
      )
      dv.setUint16(pointer + 2, handle.flags, true)
      dv.setBigUint64(pointer + 8, handle.rights, true)
      dv.setBigUint64(pointer + 16, handle.kind === 'dir' ? handle.inheriting : 0n, true)
      return E.SUCCESS
    },
    fd_fdstat_set_flags: (fd: number, flags: number) => {
      const handle = fds.get(fd)
      if (!handle) return E.BADF
      handle.flags = flags
      return E.SUCCESS
    },
    fd_fdstat_set_rights: (fd: number, base: bigint, inheriting: bigint) => {
      const handle = fds.get(fd)
      if (!handle) return E.BADF
      if ((base & ~handle.rights) !== 0n) return E.NOTCAPABLE
      handle.rights = base
      if (handle.kind === 'dir') {
        if ((inheriting & ~handle.inheriting) !== 0n) return E.NOTCAPABLE
        handle.inheriting = inheriting
      }
      return E.SUCCESS
    },
    fd_prestat_get: (fd: number, pointer: number) => {
      const handle = fds.get(fd)
      if (!handle || handle.kind !== 'dir' || handle.preopen === null) return E.BADF
      view().setUint8(pointer, 0)
      view().setUint32(pointer + 4, encode(handle.preopen).length, true)
      return E.SUCCESS
    },
    fd_prestat_dir_name: (fd: number, pointer: number, length: number) => {
      const handle = fds.get(fd)
      if (!handle || handle.kind !== 'dir' || handle.preopen === null) return E.BADF
      const name = encode(handle.preopen)
      if (length < name.length) return E.NAMETOOLONG
      bytes().set(name, pointer)
      return E.SUCCESS
    },
    fd_filestat_get: (fd: number, pointer: number) => {
      const handle = fds.get(fd)
      if (!handle) return E.BADF
      filestat(pointer, handle.kind === 'file' || handle.kind === 'dir' ? handle.node : 'char')
      return E.SUCCESS
    },
    fd_filestat_set_size: (fd: number, size: bigint) => {
      const handle = file(fd)
      if (typeof handle === 'number') return handle === E.ISDIR ? E.BADF : handle
      if (!(handle.rights & WRITE)) return E.BADF
      const length = Number(size)
      own(handle.node, length)
      if (length > handle.node.size) handle.node.data.fill(0, handle.node.size, length)
      handle.node.size = length
      handle.node.dirty = true
      return E.SUCCESS
    },
    fd_filestat_set_times: (fd: number, atim: bigint, mtim: bigint, flags: number) => {
      const handle = fds.get(fd)
      if (!handle) return E.BADF
      return handle.kind === 'file' || handle.kind === 'dir'
        ? times(handle.node, atim, mtim, flags)
        : E.SUCCESS
    },
    fd_sync: (fd: number) => (fds.has(fd) ? E.SUCCESS : E.BADF),
    fd_datasync: (fd: number) => (fds.has(fd) ? E.SUCCESS : E.BADF),
    fd_advise: (fd: number) => (fds.has(fd) ? E.SUCCESS : E.BADF),
    fd_allocate: (fd: number, offset: bigint, length: bigint) => {
      const handle = file(fd)
      if (typeof handle === 'number') return handle === E.ISDIR ? E.BADF : handle
      const end = Number(offset + length)
      if (end > handle.node.size) {
        own(handle.node, end)
        handle.node.data.fill(0, handle.node.size, end)
        handle.node.size = end
        handle.node.dirty = true
      }
      return E.SUCCESS
    },
    fd_readdir: (fd: number, buffer: number, length: number, cookie: bigint, used: number) => {
      const handle = fds.get(fd)
      if (!handle) return E.BADF
      if (handle.kind !== 'dir') return E.NOTDIR
      const entries: [string, Node][] = [
        ['.', handle.node],
        ['..', handle.node],
        ...[...handle.node.children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]
      let offset = 0
      for (let index = Number(cookie); index < entries.length && offset < length; index++) {
        const [name, node] = entries[index]
        const encoded = encode(name)
        const record = new Uint8Array(24 + encoded.length)
        const header = new DataView(record.buffer)
        header.setBigUint64(0, BigInt(index + 1), true)
        header.setBigUint64(8, BigInt(node.id), true)
        header.setUint32(16, encoded.length, true)
        header.setUint8(20, node.kind === 'dir' ? FILETYPE.DIRECTORY : FILETYPE.FILE)
        record.set(encoded, 24)
        const take = Math.min(record.length, length - offset)
        bytes().set(record.subarray(0, take), buffer + offset)
        offset += take
      }
      view().setUint32(used, offset, true)
      return E.SUCCESS
    },
    path_open: (
      fd: number,
      _dirflags: number,
      pathPointer: number,
      pathLength: number,
      oflags: number,
      rights: bigint,
      _inheriting: bigint,
      fdflags: number,
      result: number,
    ) => {
      check()
      const resolved = resolveAt(fd, text(pathPointer, pathLength))
      if (typeof resolved === 'number') return resolved
      const found = lookup(resolved.path)
      const creating = (oflags & 1) !== 0
      const directory = (oflags & 2) !== 0
      const truncate = (oflags & 8) !== 0
      let node = found.node
      const dirHandle = fds.get(fd) as Extract<Handle, { kind: 'dir' }>
      if (node && creating && (oflags & 4) !== 0) return E.EXIST
      if (node?.kind === 'file' && (resolved.slash || directory)) return E.NOTDIR
      if (!node) {
        if (!creating || !found.parent || directory) return E.NOENT
        if (resolved.slash) return E.ISDIR
        node = tree.file(new Uint8Array(), true)
        node.dirty = true
        found.parent.children.set(found.name, node)
      }
      if (node.kind === 'dir') {
        if ((rights & (READ | WRITE)) !== 0n && (!directory || (rights & WRITE) !== 0n))
          return E.ISDIR
        if (creating && (oflags & 4) !== 0) return E.EXIST
        if (truncate) return E.ISDIR
        const id = nextFd++
        fds.set(id, {
          kind: 'dir',
          node,
          path: resolved.path,
          root: resolved.path,
          preopen: null,
          rights: rights & BigInt(DIR_RIGHTS) & dirHandle.inheriting,
          inheriting: _inheriting & dirHandle.inheriting,
          flags: fdflags,
        })
        view().setUint32(result, id, true)
        return E.SUCCESS
      }
      if (truncate && (dirHandle.rights & 0x80000n) === 0n) return E.NOTCAPABLE
      const granted = rights & BigInt(FILE_RIGHTS) & dirHandle.inheriting
      if (truncate) {
        node.data = new Uint8Array()
        node.size = 0
        node.owned = false
        node.loaded = true
        node.dirty = true
      } else {
        const status = loadedOrFail(node, resolved.path)
        if (status) return status
      }
      const id = nextFd++
      fds.set(id, {
        kind: 'file',
        node,
        path: resolved.path,
        position: 0,
        rights: granted,
        flags: fdflags,
      })
      view().setUint32(result, id, true)
      return E.SUCCESS
    },
    path_filestat_get: (
      fd: number,
      _flags: number,
      pathPointer: number,
      pathLength: number,
      pointer: number,
    ) => {
      const resolved = resolveAt(fd, text(pathPointer, pathLength))
      if (typeof resolved === 'number') return resolved
      const node = lookup(resolved.path).node
      if (!node) return E.NOENT
      filestat(pointer, node)
      return E.SUCCESS
    },
    path_filestat_set_times: (
      fd: number,
      _flags: number,
      pathPointer: number,
      pathLength: number,
      atim: bigint,
      mtim: bigint,
      flags: number,
    ) => {
      const resolved = resolveAt(fd, text(pathPointer, pathLength))
      if (typeof resolved === 'number') return resolved
      const node = lookup(resolved.path).node
      return node ? times(node, atim, mtim, flags) : E.NOENT
    },
    path_create_directory: (fd: number, pathPointer: number, pathLength: number) => {
      const resolved = resolveAt(fd, text(pathPointer, pathLength))
      if (typeof resolved === 'number') return resolved
      const found = lookup(resolved.path)
      if (found.node) return E.EXIST
      if (!found.parent) return E.NOENT
      found.parent.children.set(found.name, tree.dir(false))
      return E.SUCCESS
    },
    path_unlink_file: (fd: number, pathPointer: number, pathLength: number) => {
      const resolved = resolveAt(fd, text(pathPointer, pathLength))
      if (typeof resolved === 'number') return resolved
      if (resolved.slash)
        return lookup(resolved.path).node?.kind === 'dir'
          ? E.ISDIR
          : lookup(resolved.path).node
            ? E.NOTDIR
            : E.NOENT
      return removeNode(resolved.path, false)
    },
    path_remove_directory: (fd: number, pathPointer: number, pathLength: number) => {
      const resolved = resolveAt(fd, text(pathPointer, pathLength))
      return typeof resolved === 'number' ? resolved : removeNode(resolved.path, true)
    },
    path_rename: (
      fd: number,
      fromPointer: number,
      fromLength: number,
      toFd: number,
      toPointer: number,
      toLength: number,
    ) => {
      const from = resolveAt(fd, text(fromPointer, fromLength))
      if (typeof from === 'number') return from
      const to = resolveAt(toFd, text(toPointer, toLength))
      if (typeof to === 'number') return to
      const source = lookup(from.path)
      const target = lookup(to.path)
      if (!source.node || !source.parent || !target.parent) return E.NOENT
      if (source.node.kind === 'dir' && (to.path + '/').startsWith(from.path + '/')) return E.INVAL
      if (source.node.kind === 'dir' ? !complete(source.node) : !source.node.loaded) return E.NOTSUP
      if (
        target.node?.kind === 'dir' &&
        (source.node.kind !== 'dir' || target.node.children.size || target.node.partial)
      )
        return source.node.kind === 'dir' ? E.NOTEMPTY : E.ISDIR
      if (target.node?.kind === 'file' && source.node.kind === 'dir') return E.NOTDIR
      source.parent.children.delete(source.name)
      target.parent.children.set(target.name, source.node)
      return E.SUCCESS
    },
    path_readlink: (fd: number, pathPointer: number, pathLength: number) => {
      const resolved = resolveAt(fd, text(pathPointer, pathLength))
      if (typeof resolved === 'number') return resolved
      return lookup(resolved.path).node ? E.INVAL : E.NOENT
    },
    sock_shutdown: (fd: number) => (fds.has(fd) ? E.NOTSOCK : E.BADF),
    sock_recv: (fd: number) => (fds.has(fd) ? E.NOTSOCK : E.BADF),
    sock_send: (fd: number) => (fds.has(fd) ? E.NOTSOCK : E.BADF),
    sock_accept: (fd: number) => (fds.has(fd) ? E.NOTSOCK : E.BADF),
    path_symlink: () => E.NOTSUP,
    path_link: () => E.NOTSUP,
  }

  const imports: HostFunction[] = []
  for (const entry of module.imports) {
    if (entry.kind !== 'function')
      return {
        code: 126,
        error: new CommandError(
          run.file +
            ' imports the ' +
            entry.kind +
            ' ' +
            entry.module +
            '.' +
            entry.name +
            ', which this host does not provide (only WASI preview1 functions)',
          126,
        ),
      }
    if (entry.module === 'wasi_snapshot_preview1' || entry.module === 'wasi_unstable')
      imports.push(wasi[entry.name] ?? (() => E.NOSYS))
    else
      imports.push(() => {
        throw new CommandError(
          run.file +
            ' called ' +
            entry.module +
            '.' +
            entry.name +
            ', which this host does not provide (only WASI preview1)',
          126,
        )
      })
  }

  let code = 0
  let error: unknown
  try {
    live = module.instantiate(imports, { check })
    const exported = (name: string) =>
      module.exports.some((entry) => entry.name === name && entry.kind === 'function')
    const initialize = exported('_initialize')
    const start = exported('_start')
    if (initialize && (!start || run.invoke !== undefined)) live.call('_initialize', [], { check })
    if (run.invoke !== undefined) {
      if (!exported(run.invoke))
        throw new CommandError(run.file + ' does not export a function named ' + run.invoke, 1)
      const value = live.call(run.invoke, run.args, { check })
      if (value !== undefined)
        ctx.stdout.write((Array.isArray(value) ? value.join(' ') : String(value)) + '\n')
    } else if (start) live.call('_start', [], { check })
    else if (!initialize)
      throw new CommandError(
        run.file +
          ' exports neither _start nor _initialize; call one of its functions with --invoke NAME',
        1,
      )
  } catch (failure) {
    if (failure instanceof Exit) code = failure.code
    else if (failure instanceof WebAssembly.RuntimeError || failure instanceof Trap) {
      ctx.stderr.write(run.file + ': wasm trap: ' + failure.message + '\n')
      code = 134
    } else if (failure instanceof Error && failure.name === 'LinkError')
      error = new CommandError('cannot instantiate ' + run.file + ': ' + failure.message, 126)
    else if (failure instanceof RangeError && /call stack/i.test(failure.message)) {
      ctx.stderr.write(run.file + ': wasm call stack exhausted\n')
      code = 134
    } else error = failure
  }
  live?.dispose()
  return error === undefined ? { code } : { code, error }
}

function complete(node: DirNode): boolean {
  if (node.partial) return false
  for (const child of node.children.values())
    if (child.kind === 'dir' ? !complete(child) : !child.loaded) return false
  return true
}

async function writeBack(fs: FileSystem, tree: Tree): Promise<void> {
  const final = new Map<string, Node>()
  const visit = (node: DirNode, path: string) => {
    for (const [name, child] of node.children) {
      const childPath = (path === '/' ? '' : path) + '/' + name
      final.set(childPath, child)
      if (child.kind === 'dir') visit(child, childPath)
    }
  }
  visit(tree.root, '/')
  const removals = [...tree.original.entries()]
    .filter(
      ([path, node]) =>
        final.get(path) !== node && !(final.get(path)?.kind === 'dir' && node.kind === 'dir'),
    )
    .map(([path]) => path)
    .sort((a, b) => b.length - a.length)
  for (const path of removals) await removeTree(fs, path)
  for (const [path, node] of final) {
    const before = tree.original.get(path)
    if (node.kind === 'dir') {
      if (before?.kind !== 'dir') await mkdirs(fs, path)
      continue
    }
    if ((before === node && !node.dirty) || !node.loaded) continue
    await mkdirs(fs, parentOf(path))
    await fs.write(path, node.data.slice(0, node.size))
  }
}

async function removeTree(fs: FileSystem, path: string): Promise<void> {
  const stat = await fs.stat(path)
  if (!stat) return
  if (stat.kind === 'directory')
    for (const name of await fs.list(path)) await removeTree(fs, path + '/' + name)
  await fs.remove(path).catch((error) => {
    if (!(error instanceof FsError)) throw error
  })
}

export function wasmCommands(options: Wasm.Options = {}): Record<string, CommandHandler> {
  const wasm = handler(options)
  return { wasm, wasmtime: wasm }
}

type CellShell = {
  fs: FileSystem
  cwd: string
  limits: { timeoutMs: number }
  exec(
    script: string,
    options: { stdin?: string; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

type CellRequest = {
  op?: unknown
  module?: unknown
  module_bytes?: unknown
  path?: unknown
  args?: unknown
  stdin?: unknown
  env?: unknown
  id?: unknown
  name?: unknown
  offset?: unknown
  length?: unknown
  data?: unknown
  pages?: unknown
}

const CELL_INSTANCES = 16

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function shellQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'"
}

function toWire(value: unknown): unknown {
  if (typeof value === 'bigint') return { bigint: String(value) }
  if (Array.isArray(value)) return value.map(toWire)
  return value
}

function fromWire(value: unknown): number | bigint | string {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { bigint?: unknown }).bigint === 'string'
  )
    return BigInt((value as { bigint: string }).bigint)
  if (typeof value === 'string' || typeof value === 'bigint') return value
  return Number(value)
}

export function wasmHost(
  shell: CellShell,
  options: Wasm.Options = {},
): (request: unknown, signal: AbortSignal) => Promise<unknown> {
  const instances = new Map<number, Live>()
  let next = 0
  const source = async (request: CellRequest): Promise<{ bytes: Uint8Array; path?: string }> => {
    if (request.module_bytes instanceof Uint8Array) return { bytes: request.module_bytes }
    if (typeof request.module === 'string') return { bytes: fromBase64(request.module) }
    if (typeof request.path !== 'string')
      throw new Error("wasm expects the module's bytes or a path")
    const path = normalize(
      request.path.startsWith('/') ? request.path : shell.cwd + '/' + request.path,
    )
    const stat = await shell.fs.stat(path)
    if (!stat || stat.kind !== 'file') throw new Error(request.path + ': No such file')
    return { bytes: await shell.fs.read(path), path }
  }
  const checker = (signal: AbortSignal) => {
    const deadline = Date.now() + shell.limits.timeoutMs
    return () => {
      if (signal.aborted || Date.now() > deadline)
        throw new LimitError(
          'wasm: execution timed out after ' + shell.limits.timeoutMs + ' ms',
          124,
        )
    }
  }
  const loaded = async (request: CellRequest) => {
    const found = await source(request)
    if (!isWasm(found.bytes)) throw new Error('not a WebAssembly module (no \\0asm header)')
    return compile(found.bytes, options).catch((error) => {
      throw new Error(error instanceof Error ? error.message : String(error))
    })
  }
  const instance = (request: CellRequest) => {
    const live = instances.get(Number(request.id))
    if (!live)
      throw new Error(
        'no WebAssembly instance ' +
          String(request.id) +
          " (instances last for this session's runtime)",
      )
    return live
  }
  const args = (request: CellRequest) =>
    Array.isArray(request.args) ? request.args.map(fromWire) : []
  return async (input, signal) => {
    const request = (input ?? {}) as CellRequest
    try {
      switch (request.op) {
        case 'run': {
          const found = await source(request)
          let file = found.path
          if (file === undefined) {
            file = '/tmp/.wasm/' + (await sha256(found.bytes)).slice(0, 16) + '.wasm'
            await mkdirs(shell.fs, parentOf(file))
            await shell.fs.write(file, found.bytes)
          }
          const env =
            typeof request.env === 'object' && request.env !== null
              ? Object.entries(request.env as Record<string, unknown>).flatMap(([key, value]) => [
                  '--env',
                  key + '=' + String(value),
                ])
              : []
          const words = [
            'wasm',
            ...env,
            '--',
            file,
            ...(Array.isArray(request.args) ? request.args.map(String) : []),
          ]
          const result = await shell.exec(words.map(shellQuote).join(' '), {
            signal,
            ...(typeof request.stdin === 'string' ? { stdin: request.stdin } : {}),
          })
          return { stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode }
        }
        case 'instantiate': {
          const module = await loaded(request)
          let live: Live
          try {
            live = module.instantiate([], { check: checker(signal) })
          } finally {
            release(module)
          }
          const id = ++next
          instances.set(id, live)
          if (instances.size > CELL_INSTANCES) {
            const oldest = instances.keys().next().value!
            instances.get(oldest)?.dispose()
            instances.delete(oldest)
          }
          return {
            id,
            engine: live.engine,
            exports: module.exports.map((entry) => ({ name: entry.name, kind: entry.kind })),
          }
        }
        case 'invoke': {
          const module = await loaded(request)
          const check = checker(signal)
          let live: Live
          try {
            live = module.instantiate([], { check })
          } finally {
            release(module)
          }
          try {
            return {
              result: toWire(live.call(String(request.name), args(request), { check })) ?? null,
              engine: live.engine,
            }
          } finally {
            live.dispose()
          }
        }
        case 'call':
          return {
            result:
              toWire(
                instance(request).call(String(request.name), args(request), {
                  check: checker(signal),
                }),
              ) ?? null,
          }
        case 'read': {
          const bytes = instance(request).bytes()
          const offset = Number(request.offset ?? 0)
          const length =
            request.length === undefined ? bytes.length - offset : Number(request.length)
          if (offset < 0 || length < 0 || offset + length > bytes.length)
            throw new Error("read outside the instance's memory (" + bytes.length + ' bytes)')
          return { data: toBase64(bytes.slice(offset, offset + length)), size: bytes.length }
        }
        case 'write': {
          const bytes = instance(request).bytes()
          const data = fromBase64(String(request.data ?? ''))
          const offset = Number(request.offset ?? 0)
          if (offset < 0 || offset + data.length > bytes.length)
            throw new Error("write outside the instance's memory (" + bytes.length + ' bytes)')
          bytes.set(data, offset)
          return { size: bytes.length }
        }
        case 'grow':
          return { previous: instance(request).grow(Number(request.pages ?? 0)) }
        case 'drop': {
          instances.get(Number(request.id))?.dispose()
          instances.delete(Number(request.id))
          return {}
        }
        default:
          throw new Error(
            'wasm op must be run, invoke, instantiate, call, read, write, grow or drop',
          )
      }
    } catch (error) {
      if (error instanceof Exit) throw new Error('the module exited with code ' + error.code)
      throw error instanceof Error ? new Error(error.message) : error
    }
  }
}

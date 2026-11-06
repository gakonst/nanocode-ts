import { FsError, normalize, type FileStat, type FileSystem, type LinkStat } from './FileSystem.ts'
import { baseOf, parentOf } from './internal/Fs.ts'
import { MachineError } from './internal/Shell.ts'

export type Entry = {
  kind: 'directory' | 'file'
  mode: number
  mtime: number
  name: string
  size: number
}

export type Request =
  | { op: 'list'; path: string }
  | { op: 'read'; paths: string[] }
  | { op: 'stat'; path: string }

export type Reply = {
  absent?: true | string[] | undefined
  entries?: Entry[] | undefined
  entry?: Entry | null | undefined
  error?: string | undefined
  machine?: string | undefined
  sizes?: number[] | undefined
}

export type Answer = {
  body: Uint8Array
  reply: Reply
}

export type HostFileSystem = FileSystem &
  Required<Pick<FileSystem, 'lstat' | 'readlink'>> & {
    readonly machine: string | undefined
  }

type Listing = {
  absent: true | string[] | undefined
  entries: Map<string, Entry>
}

export function create(options: create.Options): HostFileSystem {
  const batchBytes = options.batchBytes
  const cacheBytes = options.cacheBytes
  const listings = new Map<string, Promise<Listing>>()
  const stats = new Map<string, Entry | null>()
  const bodies = new Map<string, Uint8Array>()
  const inflight = new Map<string, Promise<Uint8Array | null>>()
  const reads = new Map<string, number>()
  let held = 0
  let machine: string | undefined

  const ask = async (path: string, request: Request): Promise<Answer> => {
    const answer = await options.request(request)
    if (answer.reply.machine !== undefined) {
      machine ??= path + ': ' + answer.reply.machine
      throw new MachineError(
        path +
          ': (this simulated shell has no copy of this path on the machine: ' +
          answer.reply.machine +
          ')',
      )
    }
    if (answer.reply.error !== undefined) throw new FsError(answer.reply.error, path)
    return answer
  }

  const listing = (reply: Reply): Listing => ({
    absent: reply.absent,
    entries: new Map((reply.entries ?? []).map((entry) => [entry.name, entry])),
  })

  const list = (dir: string): Promise<Listing> => {
    let found = listings.get(dir)
    if (!found) {
      found = ask(dir, { op: 'list', path: dir }).then((answer) => listing(answer.reply))
      listings.set(dir, found)
      found.catch(() => listings.delete(dir))
    }
    return found
  }

  const entry = async (path: string): Promise<Entry | null> => {
    const target = normalize(path)
    if (target === '/') return { kind: 'directory', mode: 0o755, mtime: 0, name: '', size: 4096 }
    const known = stats.get(target)
    if (known !== undefined) return known
    const dir = parentOf(target)
    const name = baseOf(target)
    const cached = listings.get(dir)
    if (cached) {
      const found = await cached
      const item = found.entries.get(name)
      if (item) return item
      if (found.absent === true || found.absent?.includes(name)) return null
    }
    const answer = await ask(target, { op: 'stat', path: target })
    if (answer.reply.entries && !cached) listings.set(dir, Promise.resolve(listing(answer.reply)))
    const item = answer.reply.entry ?? null
    stats.set(target, item)
    return item
  }

  const keep = (path: string, body: Uint8Array) => {
    if (body.length > cacheBytes / 4 || bodies.has(path)) return
    bodies.set(path, body)
    held += body.length
    for (const [old, kept] of bodies) {
      if (held <= cacheBytes) break
      bodies.delete(old)
      held -= kept.length
    }
  }

  const batch = async (path: string, paths: string[]): Promise<Map<string, Uint8Array>> => {
    const answer = await ask(path, { op: 'read', paths })
    const sizes = answer.reply.sizes ?? []
    const found = new Map<string, Uint8Array>()
    let offset = 0
    paths.forEach((each, index) => {
      const length = sizes[index] ?? -1
      if (length < 0) return
      const body = answer.body.subarray(offset, offset + length)
      offset += length
      found.set(each, body)
      keep(each, body)
    })
    return found
  }

  const fetch = async (path: string): Promise<Uint8Array | null> => {
    const pending = inflight.get(path)
    if (pending) return pending
    const dir = parentOf(path)
    const paths = [path]
    const seen = (reads.get(dir) ?? 0) + 1
    reads.set(dir, seen)
    const cached = listings.get(dir)
    if (seen > 1 && cached) {
      let bytes = 0
      for (const [name, item] of (await cached).entries) {
        const other = dir === '/' ? '/' + name : dir + '/' + name
        if (item.kind !== 'file' || other === path || bodies.has(other) || inflight.has(other))
          continue
        if (item.size > batchBytes / 4 || bytes + item.size > batchBytes) continue
        bytes += item.size
        paths.push(other)
      }
    }
    const request = batch(path, paths)
    for (const each of paths) {
      const one = request.then((found) => found.get(each) ?? null)
      inflight.set(each, one)
      one.then(
        () => inflight.delete(each),
        () => inflight.delete(each),
      )
    }
    return inflight.get(path) ?? request.then((found) => found.get(path) ?? null)
  }

  const refuse = (path: string): Promise<never> => {
    if (options.writes === 'machine') {
      machine ??= path + ': write'
      return Promise.reject(
        new MachineError(
          path + ': (this simulated shell has no copy of this path on the machine: write)',
        ),
      )
    }
    return Promise.reject(new FsError('EROFS', path))
  }

  const stat = async (path: string): Promise<FileStat | null> => {
    const found = await entry(path)
    return found && { kind: found.kind, mode: found.mode, mtime: found.mtime, size: found.size }
  }

  return {
    get machine() {
      return machine
    },
    stat,
    lstat: (path): Promise<LinkStat | null> => stat(path),
    readlink: async () => null,
    read: async (path) => {
      const target = normalize(path)
      const found = await entry(target)
      if (!found) throw new FsError('ENOENT', path)
      if (found.kind !== 'file') throw new FsError('EISDIR', path)
      const body = bodies.get(target) ?? (await fetch(target))
      if (!body) throw new FsError('ENOENT', path)
      return body
    },
    list: async (path) => {
      const target = normalize(path)
      return [...(await list(target)).entries.keys()].sort()
    },
    write: (path) => refuse(path),
    mkdir: (path) => refuse(path),
    remove: (path) => refuse(path),
    rename: (from) => refuse(from),
    chmod: (path) => refuse(path),
    utimes: (path) => refuse(path),
    symlink: (_target, path) => refuse(path),
    writeMany: (dirs, files) => refuse(dirs[0] ?? files[0]?.path ?? '/'),
  }
}

export declare namespace create {
  type Options = {
    batchBytes: number
    cacheBytes: number
    request: (request: Request) => Promise<Answer>
    writes?: 'machine' | 'refuse' | undefined
  }
}

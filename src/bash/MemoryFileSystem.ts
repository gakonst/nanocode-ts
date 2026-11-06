import {
  FsError,
  normalize,
  resolvePath,
  type FileInput,
  type FileStat,
  type FileSystem,
  type LinkStat,
  type NewFile,
} from './FileSystem.ts'
import { baseOf, encode, parentOf } from './internal/Fs.ts'

export type MemoryFileSystem = FileSystem &
  Required<
    Pick<FileSystem, 'chmod' | 'lstat' | 'readlink' | 'symlink' | 'utimes' | 'writeMany'>
  > & {
    changes(): Promise<Changes>
    readonly maxFileBytes: number
  }

export type Changes = {
  empty: string[]
  links: [string, string][]
  modes: [string, number][]
  removed: string[]
  written: [string, Uint8Array][]
}

type Directory = {
  children: Map<string, Node>
  kind: 'directory'
  mode: number
  mtime: number
  origin?: string
  pending?: boolean
}

type File = {
  buffer?: Uint8Array
  data: Uint8Array
  kind: 'file'
  lowerMode?: number
  mode: number
  mtime: number
  origin?: string
  pending?: number
  written?: boolean
}

type Node = File | Directory | { kind: 'link'; target: string; mtime: number; mode: number }

const nothing = new Uint8Array(0)

function join(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir + '/' + name
}

export function create(options: create.Options = {}): MemoryFileSystem {
  const maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024
  const lower = options.lower
  const root: Directory = {
    kind: 'directory',
    children: new Map(),
    mtime: Date.now(),
    mode: 0o755,
    ...(lower ? { origin: '/', pending: true } : {}),
  }
  const fetchedFiles = new Set<string>()
  let links = 0

  const fill = async (node: Directory) => {
    if (!node.pending || !lower || node.origin === undefined) return
    const origin = node.origin
    for (const name of await lower.list(origin)) {
      const path = join(origin, name)
      const stat = await lower.stat(path)
      if (!stat || node.children.has(name)) continue
      if (stat.kind === 'file') fetchedFiles.add(path)
      node.children.set(
        name,
        stat.kind === 'directory'
          ? {
              kind: 'directory',
              children: new Map(),
              mtime: stat.mtime,
              mode: stat.mode,
              origin: path,
              pending: true,
            }
          : {
              kind: 'file',
              data: nothing,
              mtime: stat.mtime,
              mode: stat.mode,
              lowerMode: stat.mode,
              origin: path,
              pending: stat.size,
            },
      )
    }
    delete node.pending
  }

  const fault = async (path: string, follow = true) => {
    if (!lower) return
    let parts = normalize(path).split('/').filter(Boolean)
    let node: Node = root
    let hops = 0
    for (let i = 0; ; i++) {
      if (node.kind === 'directory') await fill(node)
      if (i >= parts.length || node.kind !== 'directory') return
      const next: Node | undefined = node.children.get(parts[i])
      if (!next) return
      if (next.kind === 'link' && (follow || i < parts.length - 1)) {
        if (++hops > 40) return
        parts = [
          ...resolvePath('/' + parts.slice(0, i).join('/'), next.target)
            .split('/')
            .filter(Boolean),
          ...parts.slice(i + 1),
        ]
        node = root
        i = -1
        continue
      }
      node = next
    }
  }

  const load = async (node: File) => {
    if (node.pending === undefined || !lower || node.origin === undefined) return
    node.data = await lower.read(node.origin)
    delete node.pending
  }

  const size = (node: File) => node.pending ?? node.data.length

  const seed = (path: string, data: Uint8Array) => {
    let node: Node = root
    const parts = path.split('/').filter(Boolean)
    for (let i = 0; i < parts.length - 1; i++) {
      if (node.kind !== 'directory') throw new FsError('ENOTDIR', path)
      let next: Node | undefined = node.children.get(parts[i])
      if (!next)
        node.children.set(
          parts[i],
          (next = {
            kind: 'directory',
            children: new Map(),
            mtime: Date.now(),
            mode: 0o755,
            ...(lower ? { origin: '/' + parts.slice(0, i + 1).join('/'), pending: true } : {}),
          }),
        )
      node = next
    }
    if (node.kind !== 'directory') throw new FsError('ENOTDIR', path)
    node.children.set(parts[parts.length - 1], {
      kind: 'file',
      data,
      mtime: Date.now(),
      mode: 0o644,
    })
  }

  const find = (path: string): Node | undefined => {
    let node: Node | undefined = root
    for (const part of normalize(path).split('/').filter(Boolean)) {
      if (!node || node.kind !== 'directory') return undefined
      node = node.children.get(part)
    }
    return node
  }

  const real = (path: string, follow = true): string => {
    if (!links) return normalize(path)
    let parts = normalize(path).split('/').filter(Boolean)
    let hops = 0
    for (let i = 0; i < parts.length; i++) {
      if (!follow && i === parts.length - 1) break
      const node = find('/' + parts.slice(0, i + 1).join('/'))
      if (!node) break
      if (node.kind !== 'link') continue
      if (++hops > 40) throw new FsError('ELOOP', path)
      const target = resolvePath('/' + parts.slice(0, i).join('/'), node.target)
      parts = [...target.split('/').filter(Boolean), ...parts.slice(i + 1)]
      i = -1
    }
    return '/' + parts.join('/')
  }

  const directory = (path: string): Map<string, Node> => {
    const node = find(path)
    if (!node) throw new FsError('ENOENT', path)
    if (node.kind !== 'directory') throw new FsError('ENOTDIR', path)
    return node.children
  }

  for (const [path, content] of Object.entries(options.files ?? {}))
    seed(normalize(path), typeof content === 'string' ? encode(content) : content)

  const fs: MemoryFileSystem = {
    maxFileBytes,

    async stat(path: string): Promise<FileStat | null> {
      await fault(path)
      let target: string
      try {
        target = real(path)
      } catch (error) {
        if (error instanceof FsError && error.code === 'ELOOP') return null
        throw error
      }
      const node = find(target)
      if (!node || node.kind === 'link') return null
      return {
        kind: node.kind,
        size: node.kind === 'file' ? size(node) : 4096,
        mtime: node.mtime,
        mode: node.mode,
      }
    },

    async read(path: string): Promise<Uint8Array> {
      await fault(path)
      const node = find(real(path))
      if (!node || node.kind === 'link') throw new FsError('ENOENT', path)
      if (node.kind !== 'file') throw new FsError('EISDIR', path)
      await load(node)
      return node.data
    },

    async write(path: string, data: Uint8Array, append = false): Promise<void> {
      await fault(path)
      const target = real(path)
      const parent = directory(parentOf(target))
      const name = baseOf(target)
      if (!name) throw new FsError('EISDIR', path)
      const existing = parent.get(name)
      if (existing?.kind === 'directory') throw new FsError('EISDIR', path)
      if (existing?.kind === 'link') throw new FsError('ENOENT', path)
      if (append && existing) await load(existing)
      if (append && existing && data.length) {
        existing.written = true
        const length = existing.data.length + data.length
        if (length > maxFileBytes) throw new FsError('EFBIG', path)
        let buffer = existing.buffer
        if (
          !buffer ||
          buffer.length < length ||
          buffer.subarray(0, existing.data.length).byteOffset !== existing.data.byteOffset ||
          buffer.buffer !== existing.data.buffer
        ) {
          buffer = new Uint8Array(
            Math.min(maxFileBytes, Math.max(length, existing.data.length * 2, 4096)),
          )
          buffer.set(existing.data)
        }
        buffer.set(data, existing.data.length)
        existing.buffer = buffer
        existing.data = buffer.subarray(0, length)
        existing.mtime = Date.now()
        return
      }
      const bytes = append && existing ? existing.data : data
      if (bytes.length > maxFileBytes) throw new FsError('EFBIG', path)
      parent.set(name, {
        kind: 'file',
        data: bytes,
        mtime: Date.now(),
        mode: existing?.mode ?? 0o644,
        ...(existing?.kind === 'file' && existing.lowerMode !== undefined
          ? { lowerMode: existing.lowerMode }
          : {}),
      })
    },

    async writeMany(dirs: string[], files: NewFile[]): Promise<string[]> {
      for (const dir of dirs) {
        await fault(dir)
        if (find(real(dir))?.kind !== 'directory') await fs.mkdir(dir)
      }
      const refused: string[] = []
      for (const file of files) {
        if (file.data.length > maxFileBytes) {
          refused.push(file.path)
          continue
        }
        await fs.write(file.path, file.data)
        const node = find(real(file.path))
        if (node?.kind === 'file') node.mtime = file.mtime
      }
      return refused
    },

    async list(path: string): Promise<string[]> {
      await fault(path)
      return [...directory(real(path)).keys()].sort()
    },

    async mkdir(path: string): Promise<void> {
      await fault(path, false)
      const target = real(path, false)
      const parent = directory(parentOf(target))
      if (parent.has(baseOf(target))) throw new FsError('EEXIST', path)
      parent.set(baseOf(target), {
        kind: 'directory',
        children: new Map(),
        mtime: Date.now(),
        mode: 0o755,
      })
    },

    async remove(path: string): Promise<void> {
      await fault(path, false)
      const target = real(path, false)
      if (target === '/') throw new FsError('EINVAL', path)
      const parent = directory(parentOf(target))
      const node = parent.get(baseOf(target))
      if (!node) throw new FsError('ENOENT', path)
      if (node.kind === 'directory' && node.children.size) throw new FsError('ENOTEMPTY', path)
      parent.delete(baseOf(target))
    },

    async chmod(path: string, mode: number): Promise<void> {
      await fault(path)
      const node = find(real(path))
      if (!node || node.kind === 'link') throw new FsError('ENOENT', path)
      node.mode = mode & 0o7777
    },

    async utimes(path: string, mtime: number): Promise<void> {
      await fault(path)
      const node = find(real(path))
      if (!node || node.kind === 'link') throw new FsError('ENOENT', path)
      node.mtime = mtime
    },

    async symlink(target: string, path: string): Promise<void> {
      await fault(path, false)
      const link = real(path, false)
      const parent = directory(parentOf(link))
      if (link === '/' || parent.has(baseOf(link))) throw new FsError('EEXIST', path)
      parent.set(baseOf(link), { kind: 'link', target, mtime: Date.now(), mode: 0o777 })
      links++
    },

    async readlink(path: string): Promise<string | null> {
      await fault(path, false)
      const node = find(real(path, false))
      return node?.kind === 'link' ? node.target : null
    },

    async lstat(path: string): Promise<LinkStat | null> {
      await fault(path, false)
      let target: string
      try {
        target = real(path, false)
      } catch (error) {
        if (error instanceof FsError && error.code === 'ELOOP') return null
        throw error
      }
      const node = find(target)
      if (!node) return null
      if (node.kind === 'link')
        return {
          kind: 'symlink',
          size: encode(node.target).length,
          mtime: node.mtime,
          mode: 0o777,
          target: node.target,
        }
      return {
        kind: node.kind,
        size: node.kind === 'file' ? size(node) : 4096,
        mtime: node.mtime,
        mode: node.mode,
      }
    },

    async rename(from: string, to: string): Promise<void> {
      await fault(from, false)
      await fault(to, false)
      const source = real(from, false)
      const target = real(to, false)
      if (target === source) return
      if (target.startsWith(source + '/')) throw new FsError('EINVAL', to)
      const sourceParent = directory(parentOf(source))
      const node = sourceParent.get(baseOf(source))
      if (!node) throw new FsError('ENOENT', from)
      const targetParent = directory(parentOf(target))
      const existing = targetParent.get(baseOf(target))
      if (existing?.kind === 'directory') throw new FsError('EISDIR', to)
      sourceParent.delete(baseOf(source))
      targetParent.set(baseOf(target), node)
    },

    async changes(): Promise<Changes> {
      const changes: Changes = { empty: [], links: [], modes: [], removed: [], written: [] }
      const home = new Set<string>()
      const walk = async (node: Directory, path: string) => {
        if (node.origin === path) home.add(path)
        if (node.pending) {
          if (node.origin === path) return
          await fill(node)
        }
        if (!node.children.size && path !== '/') changes.empty.push(path)
        for (const [name, child] of node.children) {
          const at = join(path, name)
          if (child.kind === 'directory') await walk(child, at)
          else if (child.kind === 'link') changes.links.push([at, child.target])
          else {
            if (child.origin === at && !child.written) home.add(at)
            else {
              await load(child)
              changes.written.push([at, child.data])
            }
            if ((child.mode & 0o7777) !== (child.lowerMode ?? 0o644))
              changes.modes.push([at, child.mode & 0o7777])
          }
        }
      }
      await walk(root, '/')
      const written = new Set(changes.written.map((entry) => entry[0]))
      changes.removed = [...fetchedFiles]
        .filter((path) => !home.has(path) && !written.has(path))
        .sort()
      return changes
    },
  }

  return fs
}

export declare namespace create {
  type Options = {
    files?: Record<string, FileInput> | undefined
    lower?: FileSystem | undefined
    maxFileBytes?: number | undefined
  }
}

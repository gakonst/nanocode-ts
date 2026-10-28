/**
 * In-memory file system for the simulated shell. The files live as long as the instance.
 *
 * @module
 */
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

/** In-memory file system that `create` returns. */
export type MemoryFileSystem = FileSystem &
  Required<
    Pick<FileSystem, 'chmod' | 'lstat' | 'readlink' | 'symlink' | 'utimes' | 'writeMany'>
  > & {
    /** Largest file in bytes that a write accepts. */
    readonly maxFileBytes: number
  }

type Node =
  | { kind: 'file'; data: Uint8Array; buffer?: Uint8Array; mtime: number; mode: number }
  | { kind: 'directory'; children: Map<string, Node>; mtime: number; mode: number }
  | { kind: 'link'; target: string; mtime: number; mode: number }

/** Creates an in-memory file system seeded with `files`. */
export function create(options: create.Options = {}): MemoryFileSystem {
  const maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024
  const root: Node = { kind: 'directory', children: new Map(), mtime: Date.now(), mode: 0o755 }
  let links = 0

  const seed = (path: string, data: Uint8Array) => {
    let node: Node = root
    const parts = path.split('/').filter(Boolean)
    for (const part of parts.slice(0, -1)) {
      if (node.kind !== 'directory') throw new FsError('ENOTDIR', path)
      let next = node.children.get(part)
      if (!next)
        node.children.set(
          part,
          (next = { kind: 'directory', children: new Map(), mtime: Date.now(), mode: 0o755 }),
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
        size: node.kind === 'file' ? node.data.length : 4096,
        mtime: node.mtime,
        mode: node.mode,
      }
    },

    async read(path: string): Promise<Uint8Array> {
      const node = find(real(path))
      if (!node || node.kind === 'link') throw new FsError('ENOENT', path)
      if (node.kind !== 'file') throw new FsError('EISDIR', path)
      return node.data
    },

    async write(path: string, data: Uint8Array, append = false): Promise<void> {
      const target = real(path)
      const parent = directory(parentOf(target))
      const name = baseOf(target)
      if (!name) throw new FsError('EISDIR', path)
      const existing = parent.get(name)
      if (existing?.kind === 'directory') throw new FsError('EISDIR', path)
      if (existing?.kind === 'link') throw new FsError('ENOENT', path)
      if (append && existing && data.length) {
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
      })
    },

    async writeMany(dirs: string[], files: NewFile[]): Promise<string[]> {
      for (const dir of dirs) if (find(real(dir))?.kind !== 'directory') await fs.mkdir(dir)
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
      return [...directory(real(path)).keys()].sort()
    },

    async mkdir(path: string): Promise<void> {
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
      const target = real(path, false)
      if (target === '/') throw new FsError('EINVAL', path)
      const parent = directory(parentOf(target))
      const node = parent.get(baseOf(target))
      if (!node) throw new FsError('ENOENT', path)
      if (node.kind === 'directory' && node.children.size) throw new FsError('ENOTEMPTY', path)
      parent.delete(baseOf(target))
    },

    async chmod(path: string, mode: number): Promise<void> {
      const node = find(real(path))
      if (!node || node.kind === 'link') throw new FsError('ENOENT', path)
      node.mode = mode & 0o7777
    },

    async utimes(path: string, mtime: number): Promise<void> {
      const node = find(real(path))
      if (!node || node.kind === 'link') throw new FsError('ENOENT', path)
      node.mtime = mtime
    },

    async symlink(target: string, path: string): Promise<void> {
      const link = real(path, false)
      const parent = directory(parentOf(link))
      if (link === '/' || parent.has(baseOf(link))) throw new FsError('EEXIST', path)
      parent.set(baseOf(link), { kind: 'link', target, mtime: Date.now(), mode: 0o777 })
      links++
    },

    async readlink(path: string): Promise<string | null> {
      const node = find(real(path, false))
      return node?.kind === 'link' ? node.target : null
    },

    async lstat(path: string): Promise<LinkStat | null> {
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
        size: node.kind === 'file' ? node.data.length : 4096,
        mtime: node.mtime,
        mode: node.mode,
      }
    },

    async rename(from: string, to: string): Promise<void> {
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
  }

  return fs
}

export declare namespace create {
  type Options = {
    /** Files to seed, keyed by path. Text is stored as UTF-8. */
    files?: Record<string, FileInput> | undefined
    /** Largest file in bytes that a write accepts. Defaults to 64 MiB. */
    maxFileBytes?: number | undefined
  }
}

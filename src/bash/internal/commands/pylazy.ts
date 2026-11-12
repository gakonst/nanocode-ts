import type { SyncFileSystem } from '../../FileSystem.ts'
import type { Pyodide } from '../../Python.ts'
import type { PythonChanges } from './pyworker.ts'

type Attr = { blksize: number; blocks: number; size: number }

type Node = {
  atime: number
  contents: Record<string, Node> | Uint8Array
  ctime: number
  lazyDir?: string | undefined
  lazyFile?: string | undefined
  lazySize?: number
  mtime: number
  node_ops: unknown
  stream_ops: unknown
  usedBytes: number
}

type DirOps = {
  lookup(parent: Node, name: string): Node
  readdir(node: Node): string[]
  rename(node: Node, dir: Node, name: string): void
  rmdir(parent: Node, name: string): void
}

type FileOps = {
  getattr(node: Node): Attr
  setattr(node: Node, attr: { size?: number }): void
}

type Emscripten = {
  analyzePath(path: string): { exists: boolean }
  chdir(path: string): void
  cwd(): string
  ErrnoError: new (errno: number) => Error
  filesystems: {
    MEMFS: {
      createNode(parent: Node, name: string, mode: number, dev: number): Node
      ops_table: { dir: { node: DirOps }; file: { node: FileOps; stream: object } }
    }
  }
  isDir(mode: number): boolean
  isFile(mode: number): boolean
  mkdirTree(path: string): void
  mount(type: object, options: object, point: string): Node
  readdir(path: string): string[]
  readFile(path: string): Uint8Array
  stat(path: string): { mode: number }
  trackingDelegate: Record<string, ((...args: never[]) => void) | undefined>
  truncate(path: unknown, length: number): void
  unmount(point: string): void
}

export type Lazy = { finish(): PythonChanges }

const S_IFDIR = 0o40000

const S_IFREG = 0o100000

const mounted = new WeakMap<Pyodide, string[]>()

const WRITES = 1 | 2 | 64 | 512 | 1024

function join(base: string, name: string): string {
  return base === '/' ? '/' + name : base + '/' + name
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir === '/' ? '/' : dir + '/')
}

function detach(pyodide: Pyodide): void {
  const fs = pyodide.FS as unknown as Emscripten
  fs.chdir('/')
  for (const root of mounted.get(pyodide) ?? []) fs.unmount(root)
  mounted.delete(pyodide)
}

export function attach(pyodide: Pyodide, files: SyncFileSystem, roots: string[]): Lazy {
  detach(pyodide)
  const fs = pyodide.FS as unknown as Emscripten
  const codes = (pyodide as unknown as { ERRNO_CODES: Record<string, number> }).ERRNO_CODES
  const MEMFS = fs.filesystems.MEMFS

  const fail = (error: unknown) =>
    new fs.ErrnoError(codes[(error as { code?: string }).code ?? 'EIO'] ?? codes['EIO'] ?? 0)

  const fill = (node: Node) => {
    const host = node.lazyDir
    if (host === undefined) return
    node.lazyDir = undefined
    const names = (() => {
      try {
        return files.list(host)
      } catch (error) {
        throw fail(error)
      }
    })()
    const contents = node.contents as Record<string, Node>
    for (const name of names) {
      if (name in contents) continue
      const stat = files.stat(join(host, name))
      if (!stat) continue
      const dir = stat.kind === 'directory'
      const child = MEMFS.createNode(node, name, (dir ? S_IFDIR : S_IFREG) | (stat.mode & 0o777), 0)
      child.atime = child.mtime = child.ctime = stat.mtime
      if (dir) {
        child.lazyDir = join(host, name)
        child.node_ops = ops.dir
        continue
      }
      child.lazyFile = join(host, name)
      child.lazySize = stat.size
      child.node_ops = ops.file
      child.stream_ops = ops.stream
    }
    node.atime = node.mtime = node.ctime = Date.now()
  }

  const materialize = (node: Node) => {
    const host = node.lazyFile
    if (host === undefined) return
    const data = (() => {
      try {
        return files.read(host)
      } catch (error) {
        throw fail(error)
      }
    })()
    node.lazyFile = undefined
    node.contents = data
    node.usedBytes = data.length
  }

  const dir = MEMFS.ops_table.dir.node
  const file = MEMFS.ops_table.file
  const ops = {
    dir: {
      ...dir,
      lookup(parent: Node, name: string) {
        fill(parent)
        const node = (parent.contents as Record<string, Node>)[name]
        if (!node) throw new fs.ErrnoError(codes['ENOENT'] ?? 0)
        return node
      },
      readdir(node: Node) {
        fill(node)
        return dir.readdir(node)
      },
      rename(node: Node, target: Node, name: string) {
        const existing = (target.contents as Record<string, Node>)[name]
        if (existing) fill(existing)
        return dir.rename(node, target, name)
      },
      rmdir(parent: Node, name: string) {
        const existing = (parent.contents as Record<string, Node>)[name]
        if (existing) fill(existing)
        return dir.rmdir(parent, name)
      },
    },
    file: {
      ...file.node,
      getattr(node: Node) {
        const attr = file.node.getattr(node)
        if (node.lazyFile === undefined) return attr
        attr.size = node.lazySize ?? 0
        attr.blocks = Math.ceil(attr.size / attr.blksize)
        return attr
      },
      setattr(node: Node, attr: { size?: number }) {
        if (attr.size === 0) node.lazyFile = undefined
        else if (attr.size !== undefined) materialize(node)
        return file.node.setattr(node, attr)
      },
    },
    stream: {
      ...file.stream,
      open(stream: { node: Node }) {
        materialize(stream.node)
      },
    },
  }

  for (const root of roots) {
    fs.mkdirTree(root)
    const node = fs.mount(MEMFS, {}, root)
    node.lazyDir = root
    node.node_ops = ops.dir
  }
  mounted.set(pyodide, roots)

  const dirty = new Set<string>()
  const gone = new Set<string>()
  const absolute = (path: string) => {
    if (path.startsWith('/')) return path
    const cwd = fs.cwd()
    return (cwd === '/' ? '' : cwd) + '/' + path
  }
  const delegate = fs.trackingDelegate
  const truncate = fs.truncate
  delegate['onOpenFile'] = ((path: string, flags: number) => {
    if (flags & WRITES) dirty.add(absolute(path))
  }) as never
  delegate['onWriteToFile'] = ((path: string) => dirty.add(absolute(path))) as never
  delegate['onMovePath'] = ((from: string, to: string) => {
    gone.add(absolute(from))
    dirty.add(absolute(to))
  }) as never
  delegate['onDeletePath'] = ((path: string) => gone.add(absolute(path))) as never
  delegate['onMakeDirectory'] = ((path: string) => {
    if (!fs.analyzePath(path).exists) dirty.add(absolute(path))
  }) as never
  fs.truncate = (path: unknown, length: number) => {
    if (typeof path === 'string') dirty.add(absolute(path))
    return truncate.call(fs, path, length)
  }

  return {
    finish() {
      const found: PythonChanges = { files: new Map(), dirs: [], deleted: [] }
      const dirs = new Set<string>()
      const deleted = new Set<string>()
      const visit = (path: string) => {
        if (!roots.some((root) => within(path, root))) return
        if (!fs.analyzePath(path).exists) return void deleted.add(path)
        const mode = fs.stat(path).mode
        if (fs.isFile(mode)) return void found.files.set(path, fs.readFile(path))
        if (!fs.isDir(mode) || dirs.has(path)) return
        dirs.add(path)
        for (const name of fs.readdir(path))
          if (name !== '.' && name !== '..') visit(join(path, name))
      }
      for (const path of [...gone, ...dirty]) visit(path)
      for (const key of [
        'onOpenFile',
        'onWriteToFile',
        'onMovePath',
        'onDeletePath',
        'onMakeDirectory',
      ])
        delete delegate[key]
      fs.truncate = truncate
      detach(pyodide)
      found.dirs = [...dirs]
      found.deleted = [...deleted]
      return found
    },
  }
}

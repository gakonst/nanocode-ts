/**
 * Mount table that joins several file systems into one tree.
 *
 * @module
 */
import { FsError, normalize, type FileStat, type FileSystem, type NewFile } from './FileSystem.ts'
import { writeMany } from './internal/Fs.ts'

type Mount = { point: string; fs: FileSystem }

function inside(path: string, point: string): boolean {
  return path === point || path.startsWith(point + '/')
}

/**
 * Returns a file system that serves each mount point from its own file system and every other
 * path from `base`. Without mounts other than `/`, it returns `base`.
 */
export function create(base: FileSystem, options: create.Options): FileSystem {
  const table: Mount[] = Object.entries(options.mounts)
    .map(([point, fs]) => ({ point: normalize(point), fs }))
    .filter((mount) => mount.point !== '/')
    .sort((a, b) => b.point.length - a.point.length)
  if (!table.length) return base
  const route = (path: string): { fs: FileSystem; path: string; point: string } => {
    for (const mount of table)
      if (inside(path, mount.point))
        return { fs: mount.fs, path: path.slice(mount.point.length) || '/', point: mount.point }
    return { fs: base, path, point: '' }
  }
  const full = (point: string, path: string) =>
    point ? (path === '/' ? point : point + path) : path
  const call = async <T>(
    path: string,
    run: (fs: FileSystem, path: string) => Promise<T>,
  ): Promise<T> => {
    const target = route(path)
    try {
      return await run(target.fs, target.path)
    } catch (error) {
      if (error instanceof FsError && target.point)
        throw new FsError(
          error.code,
          full(
            target.point,
            error.message.slice(0, error.message.lastIndexOf(': ')) || target.path,
          ),
        )
      throw error
    }
  }
  const points = (dir: string) =>
    table
      .filter(
        (mount) =>
          mount.point !== dir &&
          inside(mount.point, dir === '/' ? '' : dir) &&
          mount.point.slice(dir === '/' ? 1 : dir.length + 1).indexOf('/') < 0,
      )
      .map((mount) => mount.point.slice(mount.point.lastIndexOf('/') + 1))
  const directory: FileStat = { kind: 'directory', size: 0, mtime: 0, mode: 0o555 }
  const optional = <K extends 'chmod' | 'utimes' | 'readlink' | 'lstat'>(name: K) =>
    (base[name] || table.some((mount) => mount.fs[name])
      ? {
          [name]: (path: string, value?: number) =>
            call(path, (fs, inner) => {
              const method = fs[name] as
                | ((path: string, value?: number) => Promise<unknown>)
                | undefined
              if (method) return method.call(fs, inner, value)
              if (name === 'readlink') return Promise.resolve(null)
              if (name === 'lstat') return fs.stat(inner)
              return Promise.resolve()
            }),
        }
      : {}) as Partial<FileSystem>
  return {
    stat: async (path) =>
      (await call(path, (fs, inner) => fs.stat(inner))) ??
      (table.some((mount) => inside(mount.point, path === '/' ? '' : path)) ? directory : null),
    read: (path) => call(path, (fs, inner) => fs.read(inner)),
    write: (path, data, append) => call(path, (fs, inner) => fs.write(inner, data, append)),
    list: async (path) => {
      const own = await call(path, (fs, inner) => fs.list(inner)).catch((error) => {
        if (error instanceof FsError && error.code === 'ENOENT' && points(path).length) return []
        throw error
      })
      const extra = points(path)
      return extra.length ? [...new Set([...own, ...extra])].sort() : own
    },
    mkdir: (path) => call(path, (fs, inner) => fs.mkdir(inner)),
    writeMany: async (dirs, files) => {
      const groups = new Map<
        FileSystem,
        { point: string; dirs: string[]; files: NewFile[]; outer: NewFile[] }
      >()
      const group = (path: string) => {
        const target = route(path)
        let found = groups.get(target.fs)
        if (!found)
          groups.set(target.fs, (found = { point: target.point, dirs: [], files: [], outer: [] }))
        return { found, inner: target.path }
      }
      for (const dir of dirs) {
        const { found, inner } = group(dir)
        found.dirs.push(inner)
      }
      for (const file of files) {
        const { found, inner } = group(file.path)
        found.files.push({ ...file, path: inner })
        found.outer.push(file)
      }
      const refused: string[] = []
      for (const [fs, found] of groups) {
        for (const path of await writeMany(fs, found.dirs, found.files))
          refused.push(full(found.point, path))
        found.files.forEach((file, index) => {
          found.outer[index]!.mtime = file.mtime
        })
      }
      return refused
    },
    remove: async (path) => {
      if (table.some((mount) => mount.point === path)) throw new FsError('EBUSY', path)
      return call(path, (fs, inner) => fs.remove(inner))
    },
    rename: async (from, to) => {
      const source = route(from)
      const target = route(to)
      if (source.fs !== target.fs) throw new FsError('EXDEV', to)
      return call(from, (fs, inner) => fs.rename(inner, target.path))
    },
    search: async (dir, literals) => {
      const target = route(dir)
      if (!target.point || !target.fs.search) return null
      const found = await target.fs.search(target.path, literals)
      return found && found.map((path) => full(target.point, path))
    },
    excerpt: async (path, literals) => {
      const target = route(path)
      return target.point && target.fs.excerpt ? target.fs.excerpt(target.path, literals) : null
    },
    matches: async (dir, literals, ignoreCase) => {
      const target = route(dir)
      if (!target.point || !target.fs.matches) return null
      const found = await target.fs.matches(target.path, literals, ignoreCase)
      return found && found.map((path) => full(target.point, path))
    },
    ...optional('chmod'),
    ...optional('utimes'),
    ...optional('readlink'),
    ...optional('lstat'),
    ...(base.symlink
      ? {
          symlink: (link: string, path: string) =>
            call(path, (fs, inner) =>
              fs.symlink ? fs.symlink(link, inner) : Promise.reject(new FsError('EROFS', inner)),
            ),
        }
      : {}),
  }
}

export declare namespace create {
  type Options = {
    /** File systems keyed by their mount point. Longer mount points take precedence. */
    mounts: Record<string, FileSystem>
  }
}

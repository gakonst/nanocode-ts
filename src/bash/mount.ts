import {
  FsError,
  normalize,
  writeMany,
  type FileStat,
  type FileSystem,
  type NewFile,
} from './fs.ts'

type Mount = { point: string; fs: FileSystem }

function inside(path: string, point: string): boolean {
  return path === point || path.startsWith(point + '/')
}

export function mounted(base: FileSystem, mounts: Record<string, FileSystem>): FileSystem {
  const table: Mount[] = Object.entries(mounts)
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

export type Pruned = Map<string, Set<string>> & { exact?: boolean }

const AHEAD = 64
const AHEAD_BYTES = 16 << 20

export function ahead<T>(
  items: T[],
  load: (item: T) => Promise<Uint8Array> | null,
): (index: number) => Promise<Uint8Array> | null {
  const slots = new Map<number, Promise<Uint8Array> | null>()
  const sizes = new Map<number, number>()
  let next = 0
  let width = 2
  let held = 0
  const start = (index: number) => {
    const promise = load(items[index])
    if (promise)
      promise.then(
        (bytes) => {
          if (!slots.has(index)) return
          sizes.set(index, bytes.length)
          held += bytes.length
        },
        () => {},
      )
    slots.set(index, promise)
  }
  return (index) => {
    if (index >= next) {
      start(index)
      next = index + 1
    }
    const promise = slots.get(index) ?? null
    slots.delete(index)
    held -= sizes.get(index) ?? 0
    sizes.delete(index)
    for (; next < items.length && next <= index + width && held < AHEAD_BYTES; next++) start(next)
    width = Math.min(width * 2, AHEAD)
    return promise
  }
}

export async function pruned(
  fs: FileSystem,
  root: string,
  literals: string[] | null,
  exact?: { literals: string[]; ignoreCase: boolean } | null,
): Promise<Pruned | null> {
  const matched =
    exact && fs.matches ? await fs.matches(root, exact.literals, exact.ignoreCase) : null
  if (!matched && (!literals || !fs.search)) return null
  const files = matched ?? (await fs.search!(root, literals!))
  if (!files) return null
  const tree: Pruned = new Map([[root, new Set()]])
  if (matched) tree.exact = true
  for (const file of files) {
    if (!inside(file, root === '/' ? '' : root) || file === root) continue
    let child = file
    for (
      let parent = child.slice(0, child.lastIndexOf('/')) || '/';
      ;
      child = parent, parent = parent.slice(0, parent.lastIndexOf('/')) || '/'
    ) {
      let names = tree.get(parent)
      const seen = names !== undefined
      if (!names) tree.set(parent, (names = new Set()))
      names.add(child.slice(child.lastIndexOf('/') + 1))
      if (seen || parent === root) break
    }
  }
  return tree
}

export function prunedList(tree: Pruned, path: string): string[] {
  return [...(tree.get(path) ?? [])].sort()
}

export function prunedStat(tree: Pruned, path: string): FileStat {
  return tree.has(path)
    ? { kind: 'directory', size: 0, mtime: 0, mode: 0o555 }
    : { kind: 'file', size: 0, mtime: 0, mode: 0o444 }
}

export type Syntax = 'fixed' | 'basic' | 'extended' | 'perl'

export function exactLiterals(patterns: string[], syntax: Syntax): string[] | null {
  const out: string[] = []
  const special =
    syntax === 'fixed' ? null : syntax === 'basic' ? /[.[\]*^$\\]/ : /[.[\]*^$\\+?(){}|]/
  for (const pattern of patterns) {
    const branches =
      syntax === 'fixed'
        ? [pattern]
        : syntax === 'basic'
          ? pattern.split('\\|')
          : pattern.split('|')
    for (const branch of branches) {
      if (!branch || branch.includes('\n') || (special && special.test(branch))) return null
      out.push(branch)
    }
  }
  return out.length ? out : null
}

export function literals(patterns: string[], syntax: Syntax): string[] | null {
  const out: string[] = []
  for (const pattern of patterns) {
    const found = syntax === 'fixed' ? (pattern ? [pattern] : null) : branches(pattern, syntax)
    if (!found) return null
    out.push(...found)
  }
  return out.length ? out : null
}

function branches(pattern: string, syntax: Exclude<Syntax, 'fixed'>): string[] | null {
  const basic = syntax === 'basic'
  const out: string[] = []
  let best = ''
  let run = ''
  const cut = () => {
    if (run.length > best.length) best = run
    run = ''
  }
  const end = () => {
    cut()
    if (!best) return false
    out.push(best)
    best = ''
    return true
  }
  const quantified = () => {
    run = run.slice(0, -1)
    cut()
  }
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[i + 1]
      i++
      if (next === undefined) return null
      if (basic && next === '|') {
        if (!end()) return null
        continue
      }
      if (basic && next === '(') {
        i = group(pattern, i + 1, true)
        if (i < 0) return null
        cut()
        continue
      }
      if (basic && (next === '?' || next === '+' || next === '{')) {
        if (next === '{') i = pattern.indexOf('\\}', i) + 1 || pattern.length
        quantified()
        continue
      }
      if (/[A-Za-z0-9]/.test(next)) {
        cut()
        i = escape(pattern, i, next)
        continue
      }
      if (syntax !== 'perl' && "<>'`".includes(next)) {
        cut()
        continue
      }
      run += next
      continue
    }
    if (c === '*') {
      quantified()
      continue
    }
    if (!basic && (c === '?' || c === '+')) {
      quantified()
      continue
    }
    if (!basic && c === '{' && /^\{\d*(,\d*)?\}/.test(pattern.slice(i))) {
      i = pattern.indexOf('}', i)
      quantified()
      continue
    }
    if (!basic && c === '|') {
      if (!end()) return null
      continue
    }
    if (!basic && c === '(') {
      i = group(pattern, i + 1, false, syntax === 'perl')
      if (i < 0) return null
      cut()
      continue
    }
    if (c === '[') {
      i = bracket(pattern, i + 1, syntax === 'perl')
      if (i < 0) return null
      cut()
      continue
    }
    if (c === '.' || c === '^' || c === '$' || (!basic && c === ')')) {
      cut()
      continue
    }
    run += c
  }
  return end() ? out : null
}

function group(pattern: string, start: number, basic: boolean, perl = false): number {
  let depth = 1
  for (let i = start; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '[') {
      i = bracket(pattern, i + 1, perl)
      if (i < 0) return -1
      continue
    }
    if (c === '\\') {
      const next = pattern[++i]
      if (basic && next === '(') depth++
      if (basic && next === ')' && --depth === 0) return quantifier(pattern, i + 1, basic)
      continue
    }
    if (!basic && c === '(') depth++
    if (!basic && c === ')' && --depth === 0) return quantifier(pattern, i + 1, basic)
  }
  return -1
}

function quantifier(pattern: string, i: number, basic: boolean): number {
  const rest = pattern.slice(i)
  const match = basic
    ? /^(\*|\\[?+]|\\\{[^\\]*\\\})/.exec(rest)
    : /^([*?+]|\{\d*(,\d*)?\})\??/.exec(rest)
  return i - 1 + (match ? match[0].length : 0)
}

function bracket(pattern: string, start: number, perl: boolean): number {
  let i = start
  if (pattern[i] === '^') i++
  if (pattern[i] === ']') i++
  for (; i < pattern.length; i++) {
    if (pattern[i] === '[' && /[:.=]/.test(pattern[i + 1] ?? '')) {
      const close = pattern.indexOf(pattern[i + 1] + ']', i + 2)
      if (close < 0) return -1
      i = close + 1
      continue
    }
    if (perl && pattern[i] === '\\' && pattern[i + 1] !== undefined) {
      i++
      continue
    }
    if (pattern[i] === ']') return i
  }
  return -1
}

function escape(pattern: string, i: number, letter: string): number {
  const rest = pattern.slice(i + 1)
  const skip = /[pPxNk]/.test(letter) ? /^(\{[^}]*\}|<[^>]*>)/.exec(rest) : null
  if (skip) return i + skip[0].length
  if (letter === 'x') return i + (/^[0-9a-fA-F]{0,2}/.exec(rest)?.[0].length ?? 0)
  if (letter === 'u') return i + (/^[0-9a-fA-F]{0,4}/.exec(rest)?.[0].length ?? 0)
  if (letter === 'c') return i + Math.min(1, rest.length)
  if (/[0-9]/.test(letter)) return i + (/^[0-9]*/.exec(rest)?.[0].length ?? 0)
  return i
}

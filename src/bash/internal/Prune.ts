import type { Conjunction, FileStat, FileSystem } from '../FileSystem.ts'

function inside(path: string, point: string): boolean {
  return path === point || path.startsWith(point + '/')
}

export type Pruned = Map<string, Set<string>> & { exact?: boolean }

const AHEAD = 64
const AHEAD_BYTES = 16 << 20

export function unindexed(files: number, limit: number): string {
  return (
    'the pattern has no literal of three or more characters for the index of this path, so it would read all ' +
    files +
    ' files (at most ' +
    limit +
    ' without one); add such a literal or search a smaller directory'
  )
}

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

export function listings(fs: Pick<FileSystem, 'list'>): {
  list: (path: string) => Promise<string[]>
  ahead: (paths: string[]) => void
} {
  const started = new Map<string, Promise<string[]>>()
  let pending = 0
  return {
    list: (path) => {
      const promise = started.get(path)
      started.delete(path)
      return promise ?? fs.list(path)
    },
    ahead: (paths) => {
      for (const path of paths) {
        if (pending >= AHEAD) return
        if (started.has(path)) continue
        pending++
        const promise = fs.list(path)
        promise.then(
          () => pending--,
          () => pending--,
        )
        started.set(path, promise)
      }
    },
  }
}

export async function pruned(
  fs: FileSystem,
  root: string,
  literals: string[] | null,
  exact?: { literals: string[]; ignoreCase: boolean } | null,
  every?: Conjunction | null,
): Promise<Pruned | null> {
  const matched =
    exact && fs.matches ? await fs.matches(root, exact.literals, exact.ignoreCase) : null
  if (!matched && (!literals || !fs.search)) return null
  const files = matched ?? (await fs.search!(root, literals!, every ?? undefined))
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

export function conjunction(patterns: string[], syntax: Syntax): Conjunction | null {
  if (syntax === 'fixed' || patterns.length !== 1) return null
  const every: Span[] = []
  if (!branches(patterns[0], syntax, every) || every.length < 2) return null
  return {
    groups: every.map((span) => span.set),
    gaps: every
      .slice(1)
      .map((span, index) =>
        syntax === 'basic' ? null : width(patterns[0].slice(every[index].end, span.start)),
      ),
  }
}

type Span = { set: string[]; start: number; end: number }

function width(source: string): number | null {
  let total = 0
  let i = 0
  while (i < source.length) {
    const c = source[i]
    let atom = 1
    if (c === '\\') {
      const next = source[i + 1]
      if (next === undefined || /[0-9kgpPxuNc]/.test(next)) return null
      if (/[bBAzZG]/.test(next)) atom = 0
      i += 2
    } else if (c === '[') {
      const close = bracket(source, i + 1, true)
      if (close < 0) return null
      i = close + 1
    } else if ('()|^$*+?{'.includes(c)) return null
    else i++
    const repeat = /^(?:([*+])|\?|\{(\d+)\}|\{(\d*),(\d*)\})[?+]?/.exec(source.slice(i))
    if (!repeat || !repeat[0]) {
      total += atom
      continue
    }
    i += repeat[0].length
    if (repeat[1] || repeat[4] === '') return null
    total += atom * Number(repeat[2] ?? repeat[4] ?? 1)
  }
  return total
}

function branches(
  pattern: string,
  syntax: Exclude<Syntax, 'fixed'>,
  every?: Span[],
): string[] | null {
  const basic = syntax === 'basic'
  const out: string[] = []
  let best: string[] = []
  let run = ''
  let runStart = 0
  let atomStart = 0
  let ended = 0
  const shortest = (set: string[]) => Math.min(...set.map((literal) => literal.length))
  const consider = (set: string[], start: number, end: number) => {
    every?.push({ set, start, end })
    if (
      !best.length ||
      shortest(set) > shortest(best) ||
      (shortest(set) === shortest(best) && set.length < best.length)
    )
      best = set
  }
  const cut = (end: number) => {
    if (run) consider([run], runStart, end)
    run = ''
  }
  const append = (text: string, start: number) => {
    if (!run) runStart = start
    atomStart = start
    run += text
  }
  const end = (at: number) => {
    cut(at)
    if (++ended > 1) every?.splice(0)
    if (!best.length) return false
    out.push(...best)
    best = []
    return true
  }
  const nested = (start: number) => {
    const close = closing(pattern, start, basic, syntax === 'perl')
    if (close < 0) return -1
    const last = quantifier(pattern, close + 1, basic)
    const repeat = pattern.slice(close + 1, last + 1)
    const inner = pattern.slice(start, basic ? close - 1 : close)
    const optional = basic
      ? /^(\*|\\\?|\\\{0*[,\\])/.test(repeat)
      : /^(\*|\?|\{0*[,}])/.test(repeat)
    const body = basic
      ? inner
      : /^\?(?::|P?<[A-Za-z_][\w]*>)/.exec(inner)
        ? inner.replace(/^\?(?::|P?<[A-Za-z_][\w]*>)/, '')
        : inner
    const open = start - (basic ? 2 : 1)
    cut(open)
    if (!optional && (basic || !inner.startsWith('?') || body !== inner)) {
      const set = branches(body, syntax)
      if (set) consider(set, open, last + 1)
    }
    return last
  }
  const quantified = () => {
    run = run.slice(0, -1)
    cut(atomStart)
  }
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[i + 1]
      i++
      if (next === undefined) return null
      if (basic && next === '|') {
        if (!end(i - 1)) return null
        continue
      }
      if (basic && next === '(') {
        i = nested(i + 1)
        if (i < 0) return null
        continue
      }
      if (basic && (next === '?' || next === '+' || next === '{')) {
        if (next === '{') i = pattern.indexOf('\\}', i) + 1 || pattern.length
        quantified()
        continue
      }
      if (/[A-Za-z0-9]/.test(next)) {
        cut(i - 1)
        i = escape(pattern, i, next)
        continue
      }
      if (syntax !== 'perl' && "<>'`".includes(next)) {
        cut(i - 1)
        continue
      }
      append(next, i - 1)
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
      if (!end(i)) return null
      continue
    }
    if (!basic && c === '(') {
      i = nested(i + 1)
      if (i < 0) return null
      continue
    }
    if (c === '[') {
      const open = i
      i = bracket(pattern, i + 1, syntax === 'perl')
      if (i < 0) return null
      cut(open)
      continue
    }
    if (c === '.' || c === '^' || c === '$' || (!basic && c === ')')) {
      cut(i)
      continue
    }
    append(c, i)
  }
  return end(pattern.length) ? out : null
}

function closing(pattern: string, start: number, basic: boolean, perl: boolean): number {
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
      if (basic && next === ')' && --depth === 0) return i
      continue
    }
    if (!basic && c === '(') depth++
    if (!basic && c === ')' && --depth === 0) return i
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

import * as Inflate from './Inflate.ts'

const encoder = new TextEncoder()

const decoder = new TextDecoder()

const types = ['', 'commit', 'tree', 'blob', 'tag'] as const

export type Kind = 'blob' | 'commit' | 'tag' | 'tree'

export type Entry = {
  kind: Kind | 'ofs-delta' | 'ref-delta'
  offset: number
  size: number
  start: number
  base?: number | string
}

export type Pack = { parts: readonly Uint8Array[]; size: number; starts: readonly number[] }

export class GitError extends Error {
  override readonly name = 'GitPack.GitError'
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

function line(text: string): Uint8Array {
  const bytes = encoder.encode(text)
  return encoder.encode((bytes.length + 4).toString(16).padStart(4, '0') + text)
}

function request(command: string, args: readonly string[]): Uint8Array {
  const parts = [
    line('command=' + command + '\n'),
    line('agent=nanocode-ts\n'),
    encoder.encode('0001'),
    ...args.map((arg) => line(arg + '\n')),
    encoder.encode('0000'),
  ]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function post(
  fetcher: typeof fetch,
  options: {
    body: Uint8Array
    repository: string
    signal?: AbortSignal | undefined
    url?: string | undefined
  },
): Promise<Response> {
  const { body, repository, signal } = options
  const response = await fetcher(
    options.url ?? 'https://github.com/' + repository + '.git/git-upload-pack',
    {
      body: body as Uint8Array<ArrayBuffer>,
      headers: {
        accept: 'application/x-git-upload-pack-result',
        'content-type': 'application/x-git-upload-pack-request',
        'git-protocol': 'version=2',
        'user-agent': 'git/2.47.0 nanocode-ts',
      },
      method: 'POST',
      ...(signal ? { signal } : {}),
    },
  )
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new GitError(
      'github.com answered HTTP ' + response.status + ' for ' + repository,
      response.status,
    )
  }
  return response
}

async function* packets(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array | 'flush' | 'delim' | 'end'> {
  const reader = body.getReader()
  let buffer = new Uint8Array(0)
  let start = 0
  try {
    for (;;) {
      while (buffer.length - start >= 4) {
        const length = parseInt(decoder.decode(buffer.subarray(start, start + 4)), 16)
        if (Number.isNaN(length)) throw new GitError('github.com sent an invalid pkt-line')
        if (length < 4) {
          start += 4
          yield length === 0 ? 'flush' : length === 1 ? 'delim' : 'end'
          continue
        }
        if (buffer.length - start < length) break
        yield buffer.subarray(start + 4, start + length)
        start += length
      }
      const next = await reader.read()
      if (next.done) break
      const rest = buffer.subarray(start)
      const merged = new Uint8Array(rest.length + next.value.length)
      merged.set(rest)
      merged.set(next.value, rest.length)
      buffer = merged
      start = 0
    }
  } finally {
    reader.releaseLock()
  }
  if (buffer.length - start) throw new GitError('github.com ended the response inside a pkt-line')
}

export async function refs(fetcher: typeof fetch, options: refs.Options): Promise<refs.ReturnType> {
  const { ref, repository } = options
  const prefixes = ref === 'HEAD' ? ['HEAD'] : ['refs/heads/' + ref, 'refs/tags/' + ref]
  const response = await post(fetcher, {
    body: request('ls-refs', [
      'symrefs',
      'peel',
      ...prefixes.map((prefix) => 'ref-prefix ' + prefix),
    ]),
    repository,
    signal: options.signal,
    url: options.url,
  })
  const found = new Map<string, { sha: string; target?: string; peeled?: string }>()
  for await (const packet of packets(response.body!)) {
    if (typeof packet === 'string') continue
    const [sha, name, ...attributes] = decoder.decode(packet).trim().split(' ')
    if (!sha || !name) continue
    const target = attributes.find((attribute) => attribute.startsWith('symref-target:'))?.slice(14)
    const peeled = attributes.find((attribute) => attribute.startsWith('peeled:'))?.slice(7)
    found.set(name, { sha, ...(target ? { target } : {}), ...(peeled ? { peeled } : {}) })
  }
  for (const prefix of prefixes) {
    const entry = found.get(prefix)
    if (!entry) continue
    const branch =
      prefix === 'HEAD'
        ? (entry.target?.replace(/^refs\/heads\//, '') ?? null)
        : prefix.startsWith('refs/heads/')
          ? ref
          : null
    return { branch, commit: entry.peeled ?? entry.sha }
  }
  return undefined
}

export declare namespace refs {
  type Options = {
    ref: string
    repository: string
    signal?: AbortSignal | undefined
    url?: string | undefined
  }
  type ReturnType = { branch: string | null; commit: string } | undefined
}

export async function fetchPack(fetcher: typeof fetch, options: fetchPack.Options): Promise<Pack> {
  const args = [
    'no-progress',
    'ofs-delta',
    'deepen 1',
    ...(options.filterBytes === undefined ? [] : ['filter blob:limit=' + options.filterBytes]),
    'want ' + options.commit,
    'done',
  ]
  const response = await post(fetcher, {
    body: request('fetch', args),
    repository: options.repository,
    signal: options.signal,
    url: options.url,
  })
  const segment = options.segmentBytes
  const parts: Uint8Array[] = []
  const starts: number[] = []
  let current = new Uint8Array(segment)
  let filled = 0
  let total = 0
  let section = ''
  const close = () => {
    if (!filled) return
    starts.push(total - filled)
    parts.push(filled === current.length ? current : current.slice(0, filled))
    current = new Uint8Array(segment)
    filled = 0
  }
  for await (const packet of packets(response.body!)) {
    if (typeof packet === 'string') {
      if (packet === 'flush' && section === 'packfile') break
      continue
    }
    if (section !== 'packfile') {
      section = decoder.decode(packet).trim()
      if (section.startsWith('ERR '))
        throw new GitError('github.com refused the fetch: ' + section.slice(4))
      continue
    }
    const band = packet[0]
    if (band === 1) {
      for (let at = 1; at < packet.length; ) {
        const take = Math.min(packet.length - at, current.length - filled)
        current.set(packet.subarray(at, at + take), filled)
        filled += take
        total += take
        at += take
        if (filled === current.length) close()
      }
      if (options.maxBytes !== undefined && total > options.maxBytes)
        throw new GitError(
          'the pack of ' + options.repository + ' is larger than ' + options.maxBytes + ' bytes',
        )
    } else if (band === 3)
      throw new GitError(
        'github.com failed the fetch: ' + decoder.decode(packet.subarray(1)).trim(),
      )
  }
  close()
  return { parts, size: total, starts }
}

export declare namespace fetchPack {
  type Options = {
    commit: string
    filterBytes?: number | undefined
    maxBytes?: number | undefined
    repository: string
    segmentBytes: number
    signal?: AbortSignal | undefined
    url?: string | undefined
  }
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const value of bytes) out += value.toString(16).padStart(2, '0')
  return out
}

export async function sha(kind: Kind, data: Uint8Array): Promise<string> {
  const header = encoder.encode(kind + ' ' + data.length + '\0')
  const all = new Uint8Array(header.length + data.length)
  all.set(header)
  all.set(data, header.length)
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-1', all)))
}

function apply(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let position = 0
  const varint = () => {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = delta[position++]!
      value += (byte & 127) * 2 ** shift
      shift += 7
      if (!(byte & 128)) return value
    }
  }
  if (varint() !== base.length) throw new GitError('a delta in the pack names another base size')
  const out = new Uint8Array(varint())
  let written = 0
  while (position < delta.length) {
    const op = delta[position++]!
    if (op & 128) {
      let offset = 0
      let size = 0
      for (let bit = 0; bit < 4; bit++)
        if (op & (1 << bit)) offset |= delta[position++]! << (8 * bit)
      for (let bit = 0; bit < 3; bit++)
        if (op & (16 << bit)) size |= delta[position++]! << (8 * bit)
      offset >>>= 0
      if (!size) size = 0x10000
      if (offset + size > base.length || written + size > out.length)
        throw new GitError('a delta in the pack copies past its base')
      out.set(base.subarray(offset, offset + size), written)
      written += size
    } else if (op) {
      if (written + op > out.length || position + op > delta.length)
        throw new GitError('a delta in the pack inserts past its end')
      out.set(delta.subarray(position, position + op), written)
      written += op
      position += op
    } else throw new GitError('a delta in the pack holds a reserved instruction')
  }
  if (written !== out.length) throw new GitError('a delta in the pack ends short of its size')
  return out
}

function locate(pack: Pack, offset: number): number {
  let low = 0
  let high = pack.starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (pack.starts[middle]! <= offset) low = middle
    else high = middle - 1
  }
  return low
}

function byte(pack: Pack, offset: number): number {
  if (offset >= pack.size) throw new GitError('the pack ends inside an object header')
  const at = locate(pack, offset)
  return pack.parts[at]![offset - pack.starts[at]!]!
}

function inflate(pack: Pack, start: number, size: number): { data: Uint8Array; end: number } {
  let at = locate(pack, start)
  let input = pack.parts[at]!
  let base = pack.starts[at]!
  for (;;) {
    try {
      const raw = Inflate.zlib(input, start - base, size)
      return { data: raw.data, end: base + raw.end }
    } catch (error) {
      if (!(error instanceof Inflate.TruncatedError) || at + 1 >= pack.parts.length) throw error
      const rest = input.subarray(start - base)
      const next = pack.parts[++at]!
      const joined = new Uint8Array(rest.length + next.length)
      joined.set(rest)
      joined.set(next, rest.length)
      input = joined
      base = start
    }
  }
}

export async function* objects(
  pack: Pack,
  options: objects.Options = {},
): AsyncGenerator<objects.Item> {
  const head = new Uint8Array(12).map((_, index) => byte(pack, index))
  if (decoder.decode(head.subarray(0, 4)) !== 'PACK') throw new GitError('github.com sent no pack')
  const view = new DataView(head.buffer)
  const version = view.getUint32(4)
  if (version !== 2 && version !== 3) throw new GitError('the pack has version ' + version)
  const count = view.getUint32(8)
  const limit = options.cacheBytes ?? 0
  const entries = new Map<number, Entry>()
  const bySha = new Map<string, number>()
  const cache = new Map<number, { kind: Kind; data: Uint8Array }>()
  let cached = 0

  const keep = (offset: number, value: { kind: Kind; data: Uint8Array }) => {
    if (value.data.length > limit) return
    cache.set(offset, value)
    cached += value.data.length
    for (const [key, old] of cache) {
      if (cached <= limit) break
      cache.delete(key)
      cached -= old.data.length
    }
  }

  const resolve = (entry: Entry, raw?: Uint8Array): { kind: Kind; data: Uint8Array } => {
    const hit = cache.get(entry.offset)
    if (hit) return hit
    const data = raw ?? inflate(pack, entry.start, entry.size).data
    if (entry.kind !== 'ofs-delta' && entry.kind !== 'ref-delta') return { kind: entry.kind, data }
    const at = typeof entry.base === 'number' ? entry.base : bySha.get(String(entry.base))
    const base = at === undefined ? undefined : entries.get(at)
    if (!base) throw new GitError('a delta in the pack names a base the pack does not hold')
    const resolved = resolve(base)
    return { kind: resolved.kind, data: apply(resolved.data, data) }
  }

  const window = options.windowBytes ?? 0
  let pending: { data: Uint8Array; id: Promise<string>; kind: Kind; start: number }[] = []
  let held = 0
  const settle = async () => {
    const ids = await Promise.all(pending.map((item) => item.id))
    const done = pending.map((item, index) => {
      bySha.set(ids[index]!, item.start)
      return { data: item.data, kind: item.kind, sha: ids[index]! }
    })
    pending = []
    held = 0
    return done
  }

  let offset = 12
  for (let n = 0; n < count; n++) {
    const start = offset
    let next = byte(pack, offset++)
    const code = (next >> 4) & 7
    let size = next & 15
    let shift = 4
    while (next & 128) {
      next = byte(pack, offset++)
      size += (next & 127) * 2 ** shift
      shift += 7
    }
    const entry: Entry = (() => {
      if (code === 6) {
        next = byte(pack, offset++)
        let back = next & 127
        while (next & 128) {
          next = byte(pack, offset++)
          back = (back + 1) * 128 + (next & 127)
        }
        return { kind: 'ofs-delta', offset: start, size, start: offset, base: start - back }
      }
      if (code === 7) {
        const base = hex(new Uint8Array(20).map((_, index) => byte(pack, offset + index)))
        offset += 20
        return { kind: 'ref-delta', offset: start, size, start: offset, base }
      }
      const kind = types[code]
      if (!kind) throw new GitError('the pack holds an object of type ' + code)
      return { kind, offset: start, size, start: offset }
    })()
    entry.start = offset
    const raw = inflate(pack, offset, size)
    offset = raw.end
    entries.set(start, entry)
    if (entry.kind === 'ref-delta' && !bySha.has(String(entry.base))) yield* await settle()
    const value = resolve(entry, raw.data)
    keep(start, value)
    pending.push({ data: value.data, id: sha(value.kind, value.data), kind: value.kind, start })
    held += value.data.length
    if (held >= window) yield* await settle()
  }
  yield* await settle()
}

export declare namespace objects {
  type Options = { cacheBytes?: number | undefined; windowBytes?: number | undefined }
  type Item = { data: Uint8Array; kind: Kind; sha: string }
}

export function tree(data: Uint8Array): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = []
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(32, offset)
    const nul = data.indexOf(0, space)
    if (space < 0 || nul < 0 || nul + 21 > data.length)
      throw new GitError('the pack holds a malformed tree')
    out.push({
      mode: decoder.decode(data.subarray(offset, space)),
      name: decoder.decode(data.subarray(space + 1, nul)),
      sha: hex(data.subarray(nul + 1, nul + 21)),
    })
    offset = nul + 21
  }
  return out
}

export function commit(data: Uint8Array): {
  author: string | null
  date: string | null
  message: string
  tree: string
} {
  const text = decoder.decode(data)
  const split = text.indexOf('\n\n')
  const headers = (split < 0 ? text : text.slice(0, split)).split('\n')
  const tree = headers.find((header) => header.startsWith('tree '))?.slice(5)
  if (!tree) throw new GitError('the pack holds a commit without a tree')
  const author = /^author (.*) (\d+) ([+-]\d{4})$/.exec(
    headers.find((header) => header.startsWith('author ')) ?? '',
  )
  return {
    author: author ? author[1]! : null,
    date: author ? new Date(Number(author[2]) * 1000).toISOString().replace('.000Z', 'Z') : null,
    message: split < 0 ? '' : text.slice(split + 2),
    tree,
  }
}

export async function* checkout(
  pack: Pack,
  options: checkout.Options,
): AsyncGenerator<checkout.Item> {
  const structures = new Map<string, Uint8Array>()
  const waiting = new Map<string, Uint8Array>()
  const missing = new Set<string>([options.commit])
  let paths: Map<string, { mode: string; path: string }[]> | undefined

  const plan = () => {
    const head = structures.get(options.commit)
    if (!head) return undefined
    const found = new Map<string, { mode: string; path: string }[]>()
    const walk = (sha: string, prefix: string) => {
      const data = structures.get(sha)
      if (!data) {
        missing.add(sha)
        return
      }
      for (const item of tree(data)) {
        const path = prefix + item.name
        if (item.mode === '40000') walk(item.sha, path + '/')
        else found.set(item.sha, [...(found.get(item.sha) ?? []), { mode: item.mode, path }])
      }
    }
    walk(commit(head).tree, '')
    return missing.size ? undefined : found
  }

  const files = function* (sha: string, data: Uint8Array): Generator<checkout.Item> {
    const list = paths!.get(sha)
    if (!list) return
    paths!.delete(sha)
    for (const item of list)
      if (item.mode.startsWith('100'))
        yield { data, kind: 'file', mode: item.mode, path: item.path, sha }
  }

  const planned = function* (): Generator<checkout.Item> {
    for (const [, list] of paths!)
      for (const entry of list)
        if (!entry.mode.startsWith('100'))
          yield { kind: 'skipped', mode: entry.mode, path: entry.path }
    for (const [sha, data] of waiting) yield* files(sha, data)
    waiting.clear()
  }

  for await (const item of objects(pack, options)) {
    if (item.kind === 'blob') {
      if (paths) yield* files(item.sha, item.data)
      else waiting.set(item.sha, item.data)
      continue
    }
    structures.set(item.sha, item.data)
    if (item.sha === options.commit) yield { info: commit(item.data), kind: 'commit' }
    if (paths || !missing.delete(item.sha) || missing.size) continue
    paths = plan()
    if (paths) yield* planned()
  }

  if (!paths) throw new GitError('the pack lacks a tree of commit ' + options.commit)
  for (const [sha, list] of paths)
    for (const entry of list)
      if (entry.mode.startsWith('100'))
        yield { kind: 'filtered', mode: entry.mode, path: entry.path, sha }
}

export declare namespace checkout {
  type Info = ReturnType<typeof commit>
  type Options = objects.Options & { commit: string }
  type Item =
    | { info: Info; kind: 'commit' }
    | { data: Uint8Array; kind: 'file'; mode: string; path: string; sha: string }
    | { kind: 'filtered'; mode: string; path: string; sha: string }
    | { kind: 'skipped'; mode: string; path: string }
}

/**
 * Tar and gzip encoding and decoding for `tar`, `gzip`, and `git clone`.
 *
 * @module
 */
import { decode, encode } from '../Fs.ts'

export type TarEntry = {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'link' | 'other'
  data: Uint8Array
  mode: number
  mtime: number
  linkname: string
  omitted?: number
}

async function transform(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const output = new Blob([data.slice()]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(output).arrayBuffer())
}

export const gzip = (data: Uint8Array) => transform(data, new CompressionStream('gzip'))

export const gunzip = (data: Uint8Array) => transform(data, new DecompressionStream('gzip'))

export function header(
  name: string,
  size: number,
  mode: number,
  mtime: number,
  type: '0' | '2' | '5',
  linkname = '',
): Uint8Array {
  const block = new Uint8Array(512)
  const put = (offset: number, length: number, text: string) =>
    block.set(encode(text).slice(0, length), offset)
  const octal = (value: number, length: number) =>
    value.toString(8).padStart(length - 1, '0') + '\0'
  let prefix = ''
  let short = name
  if (encode(name).length > 100) {
    const cut = name.lastIndexOf('/', 155)
    prefix = name.slice(0, cut)
    short = name.slice(cut + 1)
  }
  put(0, 100, short)
  put(100, 8, octal(mode & 0o7777, 8))
  put(108, 8, octal(0, 8))
  put(116, 8, octal(0, 8))
  put(124, 12, octal(size, 12))
  put(136, 12, octal(Math.floor(mtime / 1000), 12))
  put(148, 8, '        ')
  put(156, 1, type)
  put(157, 100, linkname)
  put(257, 6, 'ustar\0')
  put(263, 2, '00')
  put(265, 32, 'user')
  put(297, 32, 'user')
  put(345, 155, prefix)
  const sum = block.reduce((total, byte) => total + byte, 0)
  put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
  return block
}

export function pack(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const entry of entries) {
    if (entry.type === 'symlink') {
      parts.push(header(entry.name, 0, 0o777, entry.mtime, '2', entry.linkname))
      continue
    }
    if (entry.type !== 'file' && entry.type !== 'directory') continue
    parts.push(
      header(
        entry.type === 'directory' ? entry.name.replace(/\/?$/, '/') : entry.name,
        entry.type === 'file' ? entry.data.length : 0,
        entry.mode,
        entry.mtime,
        entry.type === 'file' ? '0' : '5',
      ),
    )
    if (entry.type === 'file') {
      parts.push(entry.data)
      const pad = (512 - (entry.data.length % 512)) % 512
      if (pad) parts.push(new Uint8Array(pad))
    }
  }
  parts.push(new Uint8Array(1024))
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function field(block: Uint8Array, offset: number, length: number): string {
  return decode(block.subarray(offset, offset + length)).replace(/\0.*$/s, '')
}

function number(block: Uint8Array, offset: number, length: number, fallback: number): number {
  if (block[offset] === 0x80) {
    let value = 0
    for (let i = offset + 1; i < offset + length; i++) value = value * 256 + block[i]
    return value
  }
  const text = field(block, offset, length).trim()
  return text ? parseInt(text, 8) : fallback
}

function records(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    let space = offset
    while (space < data.length && data[space] !== 0x20) space++
    const length = parseInt(decode(data.subarray(offset, space)), 10)
    if (!(length > 0)) break
    const record = decode(data.subarray(space + 1, offset + length)).replace(/\n$/, '')
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    offset += length
  }
  return out
}

export class TarReader {
  readonly global: Record<string, string> = {}
  done = false
  #block = new Uint8Array(512)
  #filled = 0
  #body: { header: Uint8Array; data: Uint8Array; filled: number } | null = null
  #skip = 0
  #pax: Record<string, string> = {}
  #longName: string | undefined
  #longLink: string | undefined
  readonly #maxEntry: number

  constructor(maxEntry = Number.MAX_SAFE_INTEGER) {
    this.#maxEntry = maxEntry
  }

  push(chunk: Uint8Array): TarEntry[] {
    const out: TarEntry[] = []
    let offset = 0
    while (offset < chunk.length && !this.done) {
      if (this.#skip) {
        const take = Math.min(this.#skip, chunk.length - offset)
        this.#skip -= take
        offset += take
        continue
      }
      if (this.#body) {
        const body = this.#body
        const take = Math.min(body.data.length - body.filled, chunk.length - offset)
        body.data.set(chunk.subarray(offset, offset + take), body.filled)
        body.filled += take
        offset += take
        if (body.filled === body.data.length) {
          this.#body = null
          this.#skip = (512 - (body.data.length % 512)) % 512
          this.#finish(body.header, body.data, out)
        }
        continue
      }
      const take = Math.min(512 - this.#filled, chunk.length - offset)
      this.#block.set(chunk.subarray(offset, offset + take), this.#filled)
      this.#filled += take
      offset += take
      if (this.#filled < 512) continue
      this.#filled = 0
      const block = this.#block.slice()
      if (block.every((byte) => byte === 0)) {
        this.done = true
        break
      }
      const size = number(block, 124, 12, 0)
      const type = field(block, 156, 1)
      const isData =
        type === '0' ||
        type === '' ||
        type === '7' ||
        type === 'x' ||
        type === 'g' ||
        type === 'L' ||
        type === 'K'
      if (!isData || size === 0) {
        this.#skip = isData ? 0 : Math.ceil(size / 512) * 512
        this.#finish(block, new Uint8Array(), out)
        continue
      }
      if (size > this.#maxEntry && (type === '0' || type === '' || type === '7')) {
        this.#skip = Math.ceil(size / 512) * 512
        this.#finish(block, new Uint8Array(), out, size)
        continue
      }
      if (size > this.#maxEntry)
        throw new Error(
          'archive entry of ' + size + ' bytes exceeds the limit of ' + this.#maxEntry + ' bytes',
        )
      this.#body = { header: block, data: new Uint8Array(size), filled: 0 }
    }
    return out
  }

  #finish(block: Uint8Array, data: Uint8Array, out: TarEntry[], omitted?: number) {
    const type = field(block, 156, 1)
    if (type === 'x') {
      Object.assign(this.#pax, records(data))
      return
    }
    if (type === 'g') {
      Object.assign(this.global, records(data))
      return
    }
    if (type === 'L') {
      this.#longName = decode(data).replace(/\0.*$/s, '')
      return
    }
    if (type === 'K') {
      this.#longLink = decode(data).replace(/\0.*$/s, '')
      return
    }
    const prefix = field(block, 345, 155)
    const ustar = field(block, 257, 5) === 'ustar'
    const name =
      this.#pax['path'] ??
      this.#longName ??
      (ustar && prefix ? prefix + '/' : '') + field(block, 0, 100)
    const linkname = this.#pax['linkpath'] ?? this.#longLink ?? field(block, 157, 100)
    const mode = number(block, 100, 8, 0o644)
    const mtime = Math.floor(Number(this.#pax['mtime'] ?? number(block, 136, 12, 0)) * 1000)
    this.#pax = {}
    this.#longName = undefined
    this.#longLink = undefined
    const kind: TarEntry['type'] =
      type === '5' || ((type === '0' || type === '') && name.endsWith('/'))
        ? 'directory'
        : type === '0' || type === '' || type === '7'
          ? 'file'
          : type === '2'
            ? 'symlink'
            : type === '1'
              ? 'link'
              : 'other'
    out.push({
      name: kind === 'directory' ? name.replace(/\/+$/, '') : name,
      type: kind,
      data,
      mode,
      mtime,
      linkname,
      ...(omitted === undefined ? {} : { omitted }),
    })
  }
}

const SLICE_BYTES = 64 * 1024

export async function* untar(archive: Uint8Array, maxEntry?: number): AsyncGenerator<TarEntry> {
  const reader = new TarReader(maxEntry)
  if (archive[0] !== 0x1f || archive[1] !== 0x8b) {
    yield* reader.push(archive)
    return
  }
  let offset = 0
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= archive.length) controller.close()
      else controller.enqueue(archive.slice(offset, (offset += SLICE_BYTES)))
    },
  })
  const stream = source
    .pipeThrough(
      new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    )
    .getReader()
  try {
    while (!reader.done) {
      const next = await stream.read()
      if (next.done) break
      yield* reader.push(next.value)
    }
  } finally {
    stream.cancel().catch(() => {})
  }
}

export function unpack(archive: Uint8Array): TarEntry[] {
  return new TarReader().push(archive)
}

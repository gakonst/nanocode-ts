import type { FileSystem } from '../bash/FileSystem.ts'

export const workspace = '/workspace'

export const uploads = '/workspace/uploads'

export const maxUploadBytes = 5 * 1024 * 1024

export const maxResponseBytes = 8 * 1024 * 1024

export const maxUploads = 64

export const maxPromptImages = 4

export const promptImageTypes: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

export type Attachment = { name: string; path: string; type: string; size: number }

export type Options = { root?: string; maxBytes?: number }

export type UploadOptions = { dir?: string; maxBytes?: number; maxFiles?: number }

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end))

const SIGNATURES: [string, (bytes: Uint8Array) => boolean][] = [
  ['image/png', (bytes) => bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG'],
  ['image/jpeg', (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['image/gif', (bytes) => ascii(bytes, 0, 4) === 'GIF8'],
  ['image/webp', (bytes) => ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP'],
  ['image/avif', (bytes) => ascii(bytes, 4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(bytes, 8, 12))],
  ['image/bmp', (bytes) => ascii(bytes, 0, 2) === 'BM' && bytes.length > 26],
  ['application/pdf', (bytes) => ascii(bytes, 0, 5) === '%PDF-'],
]

const SVG = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i

function textual(bytes: Uint8Array): string | undefined {
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      bytes.length > 8192 ? head.subarray(0, head.length - 4) : head,
    )
  } catch {
    return undefined
  }
}

export function sniff(bytes: Uint8Array): string {
  for (const [type, test] of SIGNATURES) if (test(bytes)) return type
  const text = textual(bytes)
  if (text === undefined) return 'application/octet-stream'
  if (SVG.test(text)) return 'image/svg+xml'
  return 'text/plain; charset=utf-8'
}

export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .normalize('NFKC')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/_+/g, '_')
  const dot = cleaned.lastIndexOf('.')
  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned).slice(0, 80)
  const extension = dot > 0 ? cleaned.slice(dot).slice(0, 12) : ''
  return (stem || 'file') + extension
}

export function resolve(raw: string, root = workspace): string | undefined {
  let value: string
  try {
    value = decodeURIComponent(raw)
  } catch {
    return undefined
  }
  if (value.includes('\0')) return undefined
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return undefined
    parts.push(part)
  }
  const path = '/' + parts.join('/')
  return path === root || path.startsWith(root + '/') ? path : undefined
}

function problem(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })
}

export async function response(
  fs: FileSystem,
  raw: string,
  options: Options = {},
): Promise<Response> {
  const path = resolve(raw, options.root)
  if (!path) return problem('files are read under ' + (options.root ?? workspace), 400)
  const stat = await fs.stat(path).catch(() => null)
  if (!stat) return problem('no such file', 404)
  if (stat.kind !== 'file') return problem('not a file', 400)
  const limit = options.maxBytes ?? maxResponseBytes
  if (stat.size > limit)
    return problem(
      'the file has ' + stat.size + ' bytes; files up to ' + limit + ' bytes are served',
      413,
    )
  const bytes = await fs.read(path)
  const type = sniff(bytes)
  const inline = type.startsWith('image/') || type.startsWith('text/') || type === 'application/pdf'
  const name = path.slice(path.lastIndexOf('/') + 1)
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    headers: {
      'cache-control': 'private, no-cache',
      'content-disposition':
        (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name),
      'content-security-policy':
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      'content-type': type,
      'cross-origin-resource-policy': 'same-origin',
      'last-modified': new Date(stat.mtime || Date.now()).toUTCString(),
      'x-content-type-options': 'nosniff',
    },
  })
}

export async function write(fs: FileSystem, path: string, bytes: Uint8Array): Promise<void> {
  let dir = ''
  for (const part of path.split('/').slice(1, -1)) {
    dir += '/' + part
    const stat = await fs.stat(dir)
    if (!stat) await fs.mkdir(dir)
    else if (stat.kind !== 'directory') throw new Error(dir + ' is not a directory')
  }
  await fs.write(path, bytes)
}

export async function upload(
  fs: FileSystem,
  name: string,
  bytes: Uint8Array,
  options: UploadOptions = {},
): Promise<Attachment | Response> {
  const limit = options.maxBytes ?? maxUploadBytes
  if (bytes.length > limit) return problem('attachments are at most ' + limit + ' bytes', 413)
  const dir = options.dir ?? uploads
  const existing = (await fs.stat(dir).catch(() => null))
    ? await fs.list(dir).catch(() => [] as string[])
    : []
  if (existing.length >= (options.maxFiles ?? maxUploads))
    return problem('this session holds ' + existing.length + ' attachments, the most it takes', 409)
  const safe = safeName(name)
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const extension = dot > 0 ? safe.slice(dot) : ''
  const taken = new Set(existing)
  let chosen = safe
  for (let n = 2; taken.has(chosen); n++) chosen = stem + '-' + n + extension
  const path = dir + '/' + chosen
  await write(fs, path, bytes)
  return { name: chosen, path, type: sniff(bytes).split(';')[0]!, size: bytes.length }
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export function dataUrl(bytes: Uint8Array, type = sniff(bytes)): string {
  return 'data:' + type + ';base64,' + base64(bytes)
}

export async function promptImages(
  fs: FileSystem,
  paths: unknown,
  options: Options & { max?: number } = {},
): Promise<string[]> {
  if (!Array.isArray(paths)) return []
  const images: string[] = []
  for (const raw of paths) {
    if (images.length >= (options.max ?? maxPromptImages)) break
    if (typeof raw !== 'string') continue
    const path = resolve(raw, options.root)
    const stat = path ? await fs.stat(path).catch(() => null) : null
    if (!path || stat?.kind !== 'file' || stat.size > (options.maxBytes ?? maxUploadBytes)) continue
    const bytes = await fs.read(path)
    const type = sniff(bytes)
    if (promptImageTypes.has(type)) images.push(dataUrl(bytes, type))
  }
  return images
}

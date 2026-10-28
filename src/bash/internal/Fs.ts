import { FsError, type FileSystem, type NewFile } from '../FileSystem.ts'

export function writeMany(fs: FileSystem, dirs: string[], files: NewFile[]): Promise<string[]> {
  return fs.writeMany ? fs.writeMany(dirs, files) : writeEach(fs, dirs, files)
}

export async function writeEach(
  fs: FileSystem,
  dirs: string[],
  files: NewFile[],
): Promise<string[]> {
  for (const dir of dirs) if (!(await fs.stat(dir))) await fs.mkdir(dir)
  const refused: string[] = []
  for (const file of files) {
    try {
      await fs.write(file.path, file.data)
    } catch (error) {
      if (!(error instanceof FsError) || error.code !== 'EFBIG') throw error
      refused.push(file.path)
      continue
    }
    if (fs.utimes) await fs.utimes(file.path, file.mtime)
    else file.mtime = (await fs.stat(file.path))?.mtime ?? file.mtime
  }
  return refused
}

export function masked(fs: FileSystem, umask: number): FileSystem {
  const chmod = fs.chmod?.bind(fs)
  if (umask === 0o022 || !chmod) return fs
  return {
    stat: (path) => fs.stat(path),
    read: (path) => fs.read(path),
    write: async (path, data, append) => {
      const existed = await fs.stat(path)
      await fs.write(path, data, append)
      if (!existed) await chmod(path, 0o666 & ~umask)
    },
    list: (path) => fs.list(path),
    mkdir: async (path) => {
      await fs.mkdir(path)
      await chmod(path, 0o777 & ~umask)
    },
    remove: (path) => fs.remove(path),
    rename: (from, to) => fs.rename(from, to),
    chmod,
    ...(fs.utimes ? { utimes: fs.utimes.bind(fs) } : {}),
    ...(fs.symlink ? { symlink: fs.symlink.bind(fs) } : {}),
    ...(fs.readlink ? { readlink: fs.readlink.bind(fs) } : {}),
    ...(fs.lstat ? { lstat: fs.lstat.bind(fs) } : {}),
    ...(fs.search ? { search: fs.search.bind(fs) } : {}),
    ...(fs.excerpt ? { excerpt: fs.excerpt.bind(fs) } : {}),
    ...(fs.matches ? { matches: fs.matches.bind(fs) } : {}),
  }
}

const encoder = new TextEncoder()
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const lossy = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export function byte(value: number): string {
  const b = value & 0xff
  return String.fromCharCode(b < 0x80 ? b : 0xdc00 + b)
}

export function encode(text: string): Uint8Array {
  if (!LONE.test(text)) return encoder.encode(text)
  const out = new Uint8Array(text.length * 3)
  let n = 0
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c < 0x80) {
      out[n++] = c
      continue
    }
    if (c >= 0xdc80 && c <= 0xdcff) {
      out[n++] = c - 0xdc00
      continue
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
        out[n++] = 0xf0 | (c >> 18)
        out[n++] = 0x80 | ((c >> 12) & 0x3f)
        out[n++] = 0x80 | ((c >> 6) & 0x3f)
        out[n++] = 0x80 | (c & 0x3f)
        continue
      }
      c = 0xfffd
    } else if (c >= 0xdc00 && c <= 0xdfff) c = 0xfffd
    if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6)
      out[n++] = 0x80 | (c & 0x3f)
    } else {
      out[n++] = 0xe0 | (c >> 12)
      out[n++] = 0x80 | ((c >> 6) & 0x3f)
      out[n++] = 0x80 | (c & 0x3f)
    }
  }
  return out.slice(0, n)
}

export function decode(bytes: Uint8Array): string {
  try {
    return strict.decode(bytes)
  } catch {
    return escaped(bytes)
  }
}

function escaped(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length)
  const length = bytes.length
  const cont = (i: number) => i < length && (bytes[i] & 0xc0) === 0x80
  let n = 0
  let i = 0
  while (i < length) {
    const b = bytes[i]
    if (b < 0x80) {
      units[n++] = b
      i++
      continue
    }
    const b1 = bytes[i + 1] ?? 0
    if (b >= 0xc2 && b <= 0xdf && cont(i + 1)) {
      units[n++] = ((b & 0x1f) << 6) | (b1 & 0x3f)
      i += 2
      continue
    }
    if (
      b >= 0xe0 &&
      b <= 0xef &&
      b1 >= (b === 0xe0 ? 0xa0 : 0x80) &&
      b1 <= (b === 0xed ? 0x9f : 0xbf) &&
      cont(i + 2)
    ) {
      units[n++] = ((b & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      i += 3
      continue
    }
    if (
      b >= 0xf0 &&
      b <= 0xf4 &&
      b1 >= (b === 0xf0 ? 0x90 : 0x80) &&
      b1 <= (b === 0xf4 ? 0x8f : 0xbf) &&
      cont(i + 2) &&
      cont(i + 3)
    ) {
      const c =
        (((b & 0x07) << 18) |
          ((b1 & 0x3f) << 12) |
          ((bytes[i + 2] & 0x3f) << 6) |
          (bytes[i + 3] & 0x3f)) -
        0x10000
      units[n++] = 0xd800 + (c >> 10)
      units[n++] = 0xdc00 + (c & 0x3ff)
      i += 4
      continue
    }
    units[n++] = 0xdc00 + b
    i++
  }
  let out = ''
  for (let start = 0; start < n; start += 0x8000)
    out += String.fromCharCode(...units.subarray(start, Math.min(n, start + 0x8000)))
  return out
}

export function rejoin(text: string): string {
  return LONE.test(text) ? decode(encode(text)) : text
}

export function display(text: string): string {
  return LONE.test(text) ? lossy.decode(encode(text)) : text
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

let breath = 0

export function breathe(): Promise<void> | undefined {
  const now = Date.now()
  if (!breath) breath = now
  if (now - breath < 40) return undefined
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      breath = Date.now()
      resolve()
    }, 0),
  )
}

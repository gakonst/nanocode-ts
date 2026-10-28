export type FileKind = 'file' | 'directory'

export type FileStat = {
  kind: FileKind
  size: number
  mtime: number
  mode: number
}

export type LinkStat = {
  kind: FileKind | 'symlink'
  size: number
  mtime: number
  mode: number
  target?: string
}

export type FileSystem = {
  stat(path: string): Promise<FileStat | null>
  read(path: string): Promise<Uint8Array>
  write(path: string, data: Uint8Array, append?: boolean): Promise<void>
  list(path: string): Promise<string[]>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  chmod?(path: string, mode: number): Promise<void>
  utimes?(path: string, mtime: number): Promise<void>
  symlink?(target: string, path: string): Promise<void>
  readlink?(path: string): Promise<string | null>
  lstat?(path: string): Promise<LinkStat | null>
  search?(dir: string, literals: string[]): Promise<string[] | null>
  excerpt?(path: string, literals: string[]): Promise<Uint8Array | null>
  matches?(dir: string, literals: string[], ignoreCase: boolean): Promise<string[] | null>
  writeMany?(dirs: string[], files: NewFile[]): Promise<string[]>
}

export type NewFile = {
  path: string
  data: Uint8Array
  mtime: number
}

export type FileInput = string | Uint8Array

const messages: Record<string, string> = {
  ENOENT: 'No such file or directory',
  EEXIST: 'File exists',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  ENOTEMPTY: 'Directory not empty',
  EFBIG: 'File too large',
  EINVAL: 'Invalid argument',
  ELOOP: 'Too many levels of symbolic links',
  EROFS: 'Read-only file system',
  EXDEV: 'Invalid cross-device link',
  EBUSY: 'Device or resource busy',
}

export class FsError extends Error {
  override readonly name = 'FileSystem.FsError'
  readonly code: string
  constructor(code: string, path: string) {
    super(`${path}: ${messages[code] ?? code}`)
    this.code = code
  }
}

export function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

export function resolvePath(cwd: string, path: string): string {
  return normalize(path.startsWith('/') ? path : cwd + '/' + path)
}

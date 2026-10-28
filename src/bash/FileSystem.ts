/**
 * File system contract of the simulated shell, its error type, and its path helpers.
 *
 * @module
 */

/** Kind of a file system entry that `stat` returns. */
export type FileKind = 'file' | 'directory'

/** Metadata of a file or directory, after symbolic links resolve. */
export type FileStat = {
  /** Kind of the entry. */
  kind: FileKind
  /** Size in bytes. Directories report 4096. */
  size: number
  /** Modification time in milliseconds since the epoch. */
  mtime: number
  /** Permission bits, such as `0o644`. */
  mode: number
}

/** Metadata of an entry without symbolic link resolution. */
export type LinkStat = {
  /** Kind of the entry, or `symlink` for a link. */
  kind: FileKind | 'symlink'
  /** Size in bytes. A link reports the byte length of its target. */
  size: number
  /** Modification time in milliseconds since the epoch. */
  mtime: number
  /** Permission bits, such as `0o644`. */
  mode: number
  /** Target of a link. Absent for other kinds. */
  target?: string
}

/**
 * Storage that the shell runs on. Paths are absolute and normalized. Optional operations add
 * permissions, timestamps, symbolic links, indexed search, and batch writes.
 */
export type FileSystem = {
  /** Returns the metadata of `path`, or `null` when it does not exist. */
  stat(path: string): Promise<FileStat | null>
  /** Returns the bytes of the file at `path`. */
  read(path: string): Promise<Uint8Array>
  /** Writes `data` to the file at `path`, after its current bytes when `append` is true. */
  write(path: string, data: Uint8Array, append?: boolean): Promise<void>
  /** Returns the sorted entry names of the directory at `path`. */
  list(path: string): Promise<string[]>
  /** Makes the directory at `path`. The parent must exist. */
  mkdir(path: string): Promise<void>
  /** Removes the file, link, or empty directory at `path`. */
  remove(path: string): Promise<void>
  /** Moves the entry at `from` to `to`. */
  rename(from: string, to: string): Promise<void>
  /** Sets the permission bits of `path`. */
  chmod?(path: string, mode: number): Promise<void>
  /** Sets the modification time of `path` in milliseconds since the epoch. */
  utimes?(path: string, mtime: number): Promise<void>
  /** Makes a symbolic link at `path` that points to `target`. */
  symlink?(target: string, path: string): Promise<void>
  /** Returns the target of the link at `path`, or `null` when it is not a link. */
  readlink?(path: string): Promise<string | null>
  /** Returns the metadata of `path` without link resolution, or `null` when it does not exist. */
  lstat?(path: string): Promise<LinkStat | null>
  /** Returns the files under `dir` that can contain every literal, or `null` without an index. */
  search?(dir: string, literals: string[]): Promise<string[] | null>
  /** Returns the parts of `path` that contain the literals, or `null` without an index. */
  excerpt?(path: string, literals: string[]): Promise<Uint8Array | null>
  /** Returns the files under `dir` that contain a literal, or `null` without an index. */
  matches?(dir: string, literals: string[], ignoreCase: boolean): Promise<string[] | null>
  /** Makes `dirs` and writes `files` in one batch, and returns the paths it refused as too large. */
  writeMany?(dirs: string[], files: NewFile[]): Promise<string[]>
}

/** File that `FileSystem.writeMany` writes. */
export type NewFile = {
  /** Absolute path of the file. */
  path: string
  /** Bytes of the file. */
  data: Uint8Array
  /** Modification time in milliseconds since the epoch. The write updates it to the stored value. */
  mtime: number
}

/** Content of a file as text or bytes. Text is stored as UTF-8. */
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

/** Error of a file system operation, with a POSIX `code` such as `ENOENT` and a `path: reason` message. */
export class FsError extends Error {
  override readonly name = 'FileSystem.FsError'
  /** POSIX error code, such as `ENOENT`. */
  readonly code: string
  constructor(code: string, path: string) {
    super(`${path}: ${messages[code] ?? code}`)
    this.code = code
  }
}

/** Returns `path` as an absolute path without empty, `.`, or `..` segments. */
export function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

/** Returns `path` resolved against the directory `cwd`, normalized. */
export function resolvePath(cwd: string, path: string): string {
  return normalize(path.startsWith('/') ? path : cwd + '/' + path)
}

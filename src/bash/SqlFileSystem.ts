import type * as Contracts from '../Contracts.ts'
import {
  FsError,
  normalize,
  resolvePath,
  type FileStat,
  type FileSystem,
  type LinkStat,
  type NewFile,
} from './FileSystem.ts'
import { baseOf, decode, encode, parentOf, writeEach } from './internal/Fs.ts'

const filesTable = 'nanocode_files'

const chunksTable = 'nanocode_file_chunks'

const filesSchema = `CREATE TABLE IF NOT EXISTS ${filesTable} (scope TEXT NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, kind TEXT NOT NULL, data BLOB, mtime INTEGER NOT NULL, mode INTEGER NOT NULL, PRIMARY KEY (scope, path))`

const parentIndex = `CREATE INDEX IF NOT EXISTS ${filesTable}_parent ON ${filesTable} (scope, parent)`

const chunksSchema = `CREATE TABLE IF NOT EXISTS ${chunksTable} (scope TEXT NOT NULL, path TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (scope, path, seq))`

const defaultChunkBytes = 1 << 20

const defaultMaxFileBytes = 32 * 1024 * 1024

const stagedBytes = 4 * 1024 * 1024

const stagingPrefix = '//staging'

const breathOperations = 64

const listedMs = 1000

const reads = new Set(['stat', 'get', 'links', 'resolve', 'list', 'children', 'tail'])

const breathBytes = 4 * 1024 * 1024

function weight(value: Contracts.SqlValue | undefined): number {
  return value instanceof ArrayBuffer
    ? value.byteLength
    : typeof value === 'string'
      ? value.length
      : 0
}

type Kind = 'file' | 'directory' | 'link'

type Meta = {
  kind: Kind
  size: number
  chunked: boolean
  mtime: number
  mode: number
  inline?: Uint8Array
}

type Row = Meta & { data: Uint8Array }

function kindOf(value: Contracts.SqlValue): Kind {
  return value === 'directory' ? 'directory' : value === 'link' ? 'link' : 'file'
}

function bytes(value: Contracts.SqlValue): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value))
    return new Uint8Array(
      (value as ArrayBufferView).buffer,
      (value as ArrayBufferView).byteOffset,
      (value as ArrayBufferView).byteLength,
    )
  if (typeof value === 'string') return new TextEncoder().encode(value)
  return new Uint8Array()
}

function blob(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer as ArrayBuffer
}

function joined(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0]!
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export type SqlFileSystem = FileSystem &
  Required<
    Pick<FileSystem, 'chmod' | 'lstat' | 'readlink' | 'symlink' | 'utimes' | 'writeMany'>
  > & {
    readonly maxFileBytes: number
    readonly scope: string
  }

export function create(sql: Contracts.SqlHost, options: create.Options = {}): SqlFileSystem {
  const scope = options.scope ?? ''
  const maxFileBytes = options.maxFileBytes ?? defaultMaxFileBytes
  const chunkBytes = Math.min(
    defaultChunkBytes,
    Math.max(4096, Math.floor((sql.value_limit ?? defaultChunkBytes) / 2)),
  )
  let ready: Promise<void> | undefined
  let linked: Promise<boolean> | undefined
  const listed = new Map<string, Meta>()
  let listedAt = 0
  let version = 0
  let operations = 0
  let moved = 0

  async function breathe(
    statements: Contracts.Statement[],
    results: Contracts.SqlValue[][][],
  ): Promise<void> {
    operations++
    for (const statement of statements)
      for (let index = 1; index < statement.length; index++) moved += weight(statement[index])
    for (const rows of results)
      for (const row of rows ?? []) for (const value of row) moved += weight(value)
    if (operations < breathOperations && moved < breathBytes) return
    operations = 0
    moved = 0
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  async function run(
    operation: string,
    statements: Contracts.Statement[],
  ): Promise<Contracts.SqlValue[][][]> {
    ready ??= Promise.resolve(
      sql.transaction('store', 'files.schema', [[filesSchema], [parentIndex], [chunksSchema]]),
    ).then(() => undefined)
    await ready
    if (!reads.has(operation)) {
      version++
      listed.clear()
    }
    const results = await sql.transaction('store', `files.${operation}`, statements)
    await breathe(statements, results)
    return results
  }

  async function metaOf(path: string, inline = false): Promise<Meta | undefined> {
    if (path === '/')
      return { kind: 'directory', size: 4096, chunked: false, mtime: 0, mode: 0o755 }
    if (!inline && listed.size) {
      if (Date.now() - listedAt > listedMs) listed.clear()
      const cached = listed.get(path)
      if (cached) return cached
    }
    const [rows] = await run('stat', [
      [
        `SELECT kind, CASE WHEN data IS NULL AND kind = 'file' THEN (SELECT COALESCE(SUM(length(c.data)), 0) FROM ${chunksTable} c WHERE c.scope = f.scope AND c.path = f.path) ELSE length(data) END, data IS NULL, mtime, mode, CASE WHEN ? THEN data END FROM ${filesTable} f WHERE scope = ? AND path = ?`,
        inline ? 1 : 0,
        scope,
        path,
      ],
    ])
    const row = rows?.[0]
    if (!row) return undefined
    const kind = kindOf(row[0] ?? null)
    const chunked = kind === 'file' && Number(row[2]) === 1
    return {
      kind,
      size: Number(row[1] ?? 0),
      chunked,
      mtime: Number(row[3]),
      mode: Number(row[4]),
      ...(inline && !chunked ? { inline: bytes(row[5] ?? null) } : {}),
    }
  }

  async function rowOf(path: string): Promise<Row | undefined> {
    if (path === '/')
      return {
        kind: 'directory',
        size: 4096,
        chunked: false,
        data: new Uint8Array(),
        mtime: 0,
        mode: 0o755,
      }
    const [rows, chunks] = await run('get', [
      [
        `SELECT kind, data, mtime, mode FROM ${filesTable} WHERE scope = ? AND path = ?`,
        scope,
        path,
      ],
      [`SELECT data FROM ${chunksTable} WHERE scope = ? AND path = ? ORDER BY seq`, scope, path],
    ])
    const row = rows?.[0]
    if (!row) return undefined
    const kind = kindOf(row[0] ?? null)
    const chunked = kind === 'file' && row[1] === null && Boolean(chunks?.length)
    const parts = chunked
      ? chunks!.map((chunk) => bytes(chunk[0] ?? null))
      : [bytes(row[1] ?? null)]
    const size = parts.reduce((total, part) => total + part.length, 0)
    return {
      kind,
      size,
      chunked,
      data: joined(parts, size),
      mtime: Number(row[2]),
      mode: Number(row[3]),
    }
  }

  async function real(path: string, follow = true): Promise<string> {
    const normal = normalize(path)
    linked ??= run('links', [
      [`SELECT 1 FROM ${filesTable} WHERE scope = ? AND kind = 'link' LIMIT 1`, scope],
    ]).then(([rows]) => Boolean(rows?.length))
    if (!(await linked)) return normal
    let parts = normal.split('/').filter(Boolean)
    for (let hops = 0; ; hops++) {
      const prefixes: string[] = []
      for (let i = 1; i <= parts.length - (follow ? 0 : 1); i++)
        prefixes.push('/' + parts.slice(0, i).join('/'))
      if (!prefixes.length) break
      const [rows] = await run('resolve', [
        [
          `SELECT path, data FROM ${filesTable} WHERE scope = ? AND kind = 'link' AND path IN (${prefixes.map(() => '?').join(', ')})`,
          scope,
          ...prefixes,
        ],
      ])
      if (!rows?.length) break
      if (hops >= 40) throw new FsError('ELOOP', path)
      const links = new Map(rows.map((row) => [String(row[0]), decode(bytes(row[1] ?? null))]))
      const index = prefixes.findIndex((prefix) => links.has(prefix))
      const target = resolvePath(
        '/' + parts.slice(0, index).join('/'),
        links.get(prefixes[index]!)!,
      )
      parts = [...target.split('/').filter(Boolean), ...parts.slice(index + 1)]
    }
    return '/' + parts.join('/')
  }

  async function resolved(path: string, follow = true): Promise<string | null> {
    try {
      return await real(path, follow)
    } catch (error) {
      if (error instanceof FsError && error.code === 'ELOOP') return null
      throw error
    }
  }

  async function directory(path: string): Promise<void> {
    const row = await metaOf(await real(path))
    if (!row) throw new FsError('ENOENT', path)
    if (row.kind !== 'directory') throw new FsError('ENOTDIR', path)
  }

  function insert(
    path: string,
    kind: Kind,
    data: Uint8Array | null,
    mode: number,
    mtime = Date.now(),
  ): Contracts.Statement {
    return [
      `INSERT OR REPLACE INTO ${filesTable} (scope, path, parent, kind, data, mtime, mode) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      scope,
      path,
      parentOf(path),
      kind,
      data ? blob(data) : null,
      mtime,
      mode,
    ]
  }

  function drop(path: string): Contracts.Statement {
    return [`DELETE FROM ${chunksTable} WHERE scope = ? AND path = ?`, scope, path]
  }

  function chunkStatements(path: string, data: Uint8Array, first: number): Contracts.Statement[] {
    const statements: Contracts.Statement[] = []
    for (let offset = 0, seq = first; offset < data.length; offset += chunkBytes, seq++)
      statements.push([
        `INSERT OR REPLACE INTO ${chunksTable} (scope, path, seq, data) VALUES (?, ?, ?, ?)`,
        scope,
        path,
        seq,
        blob(data.subarray(offset, offset + chunkBytes)),
      ])
    return statements
  }

  async function staged(target: string, data: Uint8Array, mode: number): Promise<void> {
    const staging = stagingPrefix + target
    await run('write.stage', [drop(staging)])
    try {
      const step = Math.max(1, Math.floor(stagedBytes / chunkBytes)) * chunkBytes
      for (let offset = 0; offset < data.length; offset += step)
        await run(
          'write.chunk',
          chunkStatements(staging, data.subarray(offset, offset + step), offset / chunkBytes),
        )
      await run('write', [
        drop(target),
        insert(target, 'file', null, mode),
        [`UPDATE ${chunksTable} SET path = ? WHERE scope = ? AND path = ?`, target, scope, staging],
      ])
    } catch (error) {
      await run('write.unstage', [drop(staging)]).catch(() => {})
      throw error
    }
  }

  const fs: SqlFileSystem = {
    maxFileBytes,
    scope,

    async stat(path: string): Promise<FileStat | null> {
      const target = await resolved(path)
      const row = target === null ? undefined : await metaOf(target)
      if (!row || row.kind === 'link') return null
      return {
        kind: row.kind,
        size: row.kind === 'file' ? row.size : 4096,
        mtime: row.mtime,
        mode: row.mode,
      }
    },

    async read(path: string): Promise<Uint8Array> {
      const row = await rowOf(await real(path))
      if (!row || row.kind === 'link') throw new FsError('ENOENT', path)
      if (row.kind !== 'file') throw new FsError('EISDIR', path)
      return row.data
    },

    async write(path: string, data: Uint8Array, append = false): Promise<void> {
      const target = await real(path)
      if (target === '/') throw new FsError('EISDIR', path)
      await directory(parentOf(target))
      const existing = await metaOf(target, append)
      if (existing?.kind === 'directory') throw new FsError('EISDIR', path)
      if (existing?.kind === 'link') throw new FsError('ENOENT', path)
      const mode = existing?.mode ?? 0o644
      if (!append || !existing) {
        if (data.length > maxFileBytes) throw new FsError('EFBIG', path)
        if (data.length <= chunkBytes)
          await run('write', [drop(target), insert(target, 'file', data, mode)])
        else if (data.length <= stagedBytes)
          await run('write', [
            drop(target),
            insert(target, 'file', null, mode),
            ...chunkStatements(target, data, 0),
          ])
        else await staged(target, data, mode)
        return
      }
      if (!data.length) return
      if (existing.size + data.length > maxFileBytes) throw new FsError('EFBIG', path)
      if (!existing.chunked) {
        const current = existing.inline ?? new Uint8Array()
        const content = joined([current, data], current.length + data.length)
        if (content.length <= chunkBytes)
          await run('write', [insert(target, 'file', content, mode)])
        else
          await run('append', [
            insert(target, 'file', null, mode),
            ...chunkStatements(target, content, 0),
          ])
        return
      }
      const [last] = await run('tail', [
        [
          `SELECT seq, data FROM ${chunksTable} WHERE scope = ? AND path = ? ORDER BY seq DESC LIMIT 1`,
          scope,
          target,
        ],
      ])
      const seq = last?.[0] ? Number(last[0][0]) : 0
      const tail = last?.[0] ? bytes(last[0][1] ?? null) : new Uint8Array()
      const fill = tail.length < chunkBytes
      await run('append', [
        [
          `UPDATE ${filesTable} SET mtime = ? WHERE scope = ? AND path = ?`,
          Date.now(),
          scope,
          target,
        ],
        ...chunkStatements(
          target,
          fill ? joined([tail, data], tail.length + data.length) : data,
          fill ? seq : seq + 1,
        ),
      ])
    },

    async writeMany(dirs: string[], files: NewFile[]): Promise<string[]> {
      linked ??= run('links', [
        [`SELECT 1 FROM ${filesTable} WHERE scope = ? AND kind = 'link' LIMIT 1`, scope],
      ]).then(([rows]) => Boolean(rows?.length))
      if (await linked) return writeEach(fs, dirs, files)
      const refused: string[] = []
      let batch: Contracts.Statement[] = dirs
        .filter((dir) => dir !== '/')
        .map((dir) => [
          `INSERT OR IGNORE INTO ${filesTable} (scope, path, parent, kind, data, mtime, mode) VALUES (?, ?, ?, 'directory', NULL, ?, ?)`,
          scope,
          dir,
          parentOf(dir),
          Date.now(),
          0o755,
        ])
      let bytes = 0
      const flush = async () => {
        if (batch.length) await run('write.many', batch)
        batch = []
        bytes = 0
      }
      for (const file of files) {
        if (file.data.length > maxFileBytes) {
          refused.push(file.path)
          continue
        }
        if (file.data.length > stagedBytes) {
          await flush()
          await staged(file.path, file.data, 0o644)
          await run('utimes', [
            [
              `UPDATE ${filesTable} SET mtime = ? WHERE scope = ? AND path = ?`,
              file.mtime,
              scope,
              file.path,
            ],
          ])
          continue
        }
        if (bytes + file.data.length > stagedBytes) await flush()
        batch.push(drop(file.path))
        if (file.data.length <= chunkBytes)
          batch.push(insert(file.path, 'file', file.data, 0o644, file.mtime))
        else
          batch.push(
            insert(file.path, 'file', null, 0o644, file.mtime),
            ...chunkStatements(file.path, file.data, 0),
          )
        bytes += file.data.length
      }
      await flush()
      return refused
    },

    async list(path: string): Promise<string[]> {
      const target = await real(path)
      await directory(target)
      const generation = version
      const [rows] = await run('list', [
        [
          `SELECT path, kind, CASE WHEN data IS NULL AND kind = 'file' THEN (SELECT COALESCE(SUM(length(c.data)), 0) FROM ${chunksTable} c WHERE c.scope = f.scope AND c.path = f.path) ELSE length(data) END, data IS NULL, mtime, mode FROM ${filesTable} f WHERE scope = ? AND parent = ?`,
          scope,
          target,
        ],
      ])
      if (Date.now() - listedAt > listedMs) listed.clear()
      listedAt = Date.now()
      if (generation === version)
        for (const row of rows ?? []) {
          const kind = kindOf(row[1] ?? null)
          listed.set(String(row[0]), {
            kind,
            size: Number(row[2] ?? 0),
            chunked: kind === 'file' && Number(row[3]) === 1,
            mtime: Number(row[4]),
            mode: Number(row[5]),
          })
        }
      return (rows ?? [])
        .map((row) => baseOf(String(row[0])))
        .filter(Boolean)
        .sort()
    },

    async mkdir(path: string): Promise<void> {
      const target = await real(path, false)
      await directory(parentOf(target))
      if (await metaOf(target)) throw new FsError('EEXIST', path)
      await run('mkdir', [insert(target, 'directory', null, 0o755)])
    },

    async remove(path: string): Promise<void> {
      const target = await real(path, false)
      if (target === '/') throw new FsError('EINVAL', path)
      const row = await metaOf(target)
      if (!row) throw new FsError('ENOENT', path)
      if (row.kind === 'directory') {
        const [children] = await run('children', [
          [`SELECT 1 FROM ${filesTable} WHERE scope = ? AND parent = ? LIMIT 1`, scope, target],
        ])
        if (children?.length) throw new FsError('ENOTEMPTY', path)
      }
      await run('remove', [
        [`DELETE FROM ${filesTable} WHERE scope = ? AND path = ?`, scope, target],
        drop(target),
      ])
    },

    async chmod(path: string, mode: number): Promise<void> {
      const target = await real(path)
      const row = await metaOf(target)
      if (!row || row.kind === 'link') throw new FsError('ENOENT', path)
      await run('chmod', [
        [
          `UPDATE ${filesTable} SET mode = ? WHERE scope = ? AND path = ?`,
          mode & 0o7777,
          scope,
          target,
        ],
      ])
    },

    async utimes(path: string, mtime: number): Promise<void> {
      const target = await real(path)
      const row = await metaOf(target)
      if (!row || row.kind === 'link') throw new FsError('ENOENT', path)
      await run('utimes', [
        [
          `UPDATE ${filesTable} SET mtime = ? WHERE scope = ? AND path = ?`,
          Math.floor(mtime),
          scope,
          target,
        ],
      ])
    },

    async symlink(target: string, path: string): Promise<void> {
      const link = await real(path, false)
      if (link === '/') throw new FsError('EEXIST', path)
      await directory(parentOf(link))
      if (await metaOf(link)) throw new FsError('EEXIST', path)
      await run('symlink', [insert(link, 'link', encode(target), 0o777)])
      linked = Promise.resolve(true)
    },

    async readlink(path: string): Promise<string | null> {
      const link = await resolved(path, false)
      const row = link === null ? undefined : await rowOf(link)
      return row?.kind === 'link' ? decode(row.data) : null
    },

    async lstat(path: string): Promise<LinkStat | null> {
      const link = await resolved(path, false)
      const meta = link === null ? undefined : await metaOf(link)
      if (!meta) return null
      if (meta.kind !== 'link')
        return {
          kind: meta.kind,
          size: meta.kind === 'file' ? meta.size : 4096,
          mtime: meta.mtime,
          mode: meta.mode,
        }
      const row = await rowOf(link!)
      if (!row) return null
      return {
        kind: 'symlink',
        size: row.data.length,
        mtime: row.mtime,
        mode: 0o777,
        target: decode(row.data),
      }
    },

    async rename(from: string, to: string): Promise<void> {
      const source = await real(from, false)
      const target = await real(to, false)
      if (target === source) return
      if (target.startsWith(source + '/') || source === '/') throw new FsError('EINVAL', to)
      const node = await metaOf(source)
      if (!node) throw new FsError('ENOENT', from)
      await directory(parentOf(target))
      const existing = await metaOf(target)
      if (existing?.kind === 'directory') throw new FsError('EISDIR', to)
      const within = '(path = ? OR substr(path, 1, ?) = ?)'
      const subtree = [source, source.length + 1, source + '/']
      const tail = source.length + 1
      await run('rename', [
        [`DELETE FROM ${filesTable} WHERE scope = ? AND path = ?`, scope, target],
        drop(target),
        [
          `UPDATE ${filesTable} SET parent = CASE WHEN path = ? THEN ? ELSE ? || substr(parent, ?) END, path = ? || substr(path, ?) WHERE scope = ? AND ${within}`,
          source,
          parentOf(target),
          target,
          tail,
          target,
          tail,
          scope,
          ...subtree,
        ],
        [
          `UPDATE ${chunksTable} SET path = ? || substr(path, ?) WHERE scope = ? AND ${within}`,
          target,
          tail,
          scope,
          ...subtree,
        ],
      ])
    },
  }

  return fs
}

export declare namespace create {
  type Options = {
    scope?: string | undefined
    maxFileBytes?: number | undefined
  }
}

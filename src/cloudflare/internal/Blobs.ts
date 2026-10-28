/**
 * Blob host of the runtime over Durable Object SQLite storage: it splits each blob into parts that
 * fit the SQL value limit.
 *
 * @module
 */
import type * as Contracts from '../../Contracts.ts'
import * as Sql from '../Sql.ts'

/**
 * Returns a blob host over `storage`. It creates the `blob_parts` table, and renames a `blobs`
 * table of the older parted layout to it.
 */
export function create(storage: Sql.Storage, options: create.Options = {}): Contracts.BlobHost {
  const partBytes = options.partBytes ?? Sql.valueLimitBytes

  const tables = new Map(
    [
      ...storage.sql
        .exec(
          "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN ('blobs', 'blob_parts')",
        )
        .raw(),
    ].map(([name, sql]) => [String(name), String(sql)]),
  )
  if (tables.get('blobs')?.includes('part INTEGER') && !tables.has('blob_parts'))
    storage.sql.exec('ALTER TABLE blobs RENAME TO blob_parts')
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS blob_parts (key TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (key, part)) WITHOUT ROWID',
  )

  return {
    put(key, bytes) {
      storage.transactionSync(() => {
        if (
          [...storage.sql.exec('SELECT 1 FROM blob_parts WHERE key = ? LIMIT 1', key).raw()].length
        )
          return
        for (
          let offset = 0, part = 0;
          offset < bytes.length || part === 0;
          offset += partBytes, part++
        ) {
          storage.sql.exec(
            'INSERT INTO blob_parts (key, part, bytes) VALUES (?, ?, ?)',
            key,
            part,
            bytes.slice(offset, offset + partBytes).buffer,
          )
        }
      })
    },
    get(key) {
      const parts = [
        ...storage.sql.exec('SELECT bytes FROM blob_parts WHERE key = ? ORDER BY part', key).raw(),
      ].map(([bytes]) => new Uint8Array(bytes as ArrayBuffer))
      if (!parts.length) return null

      const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
      let offset = 0
      for (const part of parts) {
        joined.set(part, offset)
        offset += part.length
      }
      return joined
    },
  }
}

export declare namespace create {
  type Options = {
    /** Largest part in bytes. Defaults to `Sql.valueLimitBytes`. */
    partBytes?: number | undefined
  }
}

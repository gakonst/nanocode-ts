/**
 * Key-value metadata of a session in the `metadata` table, cached in memory after the first read.
 *
 * @module
 */

/** Cached view of the `metadata` table. */
export type Metadata = {
  /** Deletes `key`. */
  delete(key: string): void
  /** Returns the entry with the smallest key that starts with `prefix`. */
  first(prefix: string): [string, string] | undefined
  /** Returns the value of `key`. */
  get(key: string): string | undefined
  /** Inserts `key` unless it exists. */
  insert(key: string, value: string): void
  /** Drops the cache, so the next read loads the table again. */
  reset(): void
  /** Inserts or replaces `key`. */
  set(key: string, value: string): void
  /** Runs `operation` in one synchronous transaction, and drops the cache when it throws. */
  transaction<T>(operation: () => T): T
}

/** Returns the metadata of `storage`. The table must exist before the first read. */
export function create(storage: DurableObjectStorage): Metadata {
  let values: Map<string, string> | undefined

  const entries = () =>
    (values ??= new Map(
      storage.sql
        .exec<{ key: string; value: string }>('SELECT key, value FROM metadata')
        .toArray()
        .map((row) => [row.key, row.value]),
    ))

  return {
    delete(key) {
      const current = entries()
      if (!current.has(key)) return
      storage.sql.exec('DELETE FROM metadata WHERE key = ?', key)
      current.delete(key)
    },
    first(prefix) {
      let found: [string, string] | undefined
      for (const entry of entries())
        if (entry[0].startsWith(prefix) && (!found || entry[0] < found[0])) found = entry
      return found
    },
    get(key) {
      return entries().get(key)
    },
    insert(key, value) {
      const current = entries()
      if (current.has(key)) return
      storage.sql.exec('INSERT INTO metadata VALUES (?, ?)', key, value)
      current.set(key, value)
    },
    reset() {
      values = undefined
    },
    set(key, value) {
      const current = entries()
      storage.sql.exec(
        'INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        value,
      )
      current.set(key, value)
    },
    transaction(operation) {
      try {
        return storage.transactionSync(operation)
      } catch (error) {
        values = undefined
        throw error
      }
    },
  }
}

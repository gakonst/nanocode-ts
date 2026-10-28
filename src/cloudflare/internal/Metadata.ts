export type Metadata = {
  delete(key: string): void
  first(prefix: string): [string, string] | undefined
  get(key: string): string | undefined
  insert(key: string, value: string): void
  reset(): void
  set(key: string, value: string): void
  transaction<T>(operation: () => T): T
}

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

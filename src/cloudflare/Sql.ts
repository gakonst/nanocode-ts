import type * as Contracts from '../Contracts.ts'

export type Cursor = {
  raw(): IterableIterator<Contracts.SqlValue[]>
  readonly rowsRead: number
  readonly rowsWritten: number
}

export type Storage = {
  readonly sql: { exec(query: string, ...bindings: Contracts.SqlValue[]): Cursor }
  transactionSync<T>(closure: () => T): T
}

export type Observation = {
  kind: Contracts.SqlKind
  operation: string
  statements: number
  rows_read: number
  rows_written: number
  duration_ms: number
}

export type Host = Contracts.SqlHost & {
  readonly value_limit: number
  readonly storage: Storage
  transaction(
    kind: Contracts.SqlKind,
    operation: string,
    statements: Contracts.Statement[],
  ): Contracts.SqlValue[][][]
}

export const valueLimitBytes = 8_388_608

export function create(storage: Storage, options: create.Options = {}): Host {
  const valueLimit = options.valueLimit ?? valueLimitBytes
  if (!Number.isSafeInteger(valueLimit) || valueLimit <= 0)
    throw new Error('the SQL value limit must be a positive integer')

  return {
    storage,
    transaction(kind, operation, statements) {
      for (const [query, ...values] of statements) {
        for (const value of values) {
          const bytes =
            typeof value === 'string'
              ? value.length * 3 <= valueLimit
                ? 0
                : new TextEncoder().encode(value).length
              : value instanceof ArrayBuffer
                ? value.byteLength
                : 0
          if (bytes > valueLimit)
            throw new Error(
              `a bound value of ${bytes} bytes exceeds the host's ${valueLimit}-byte SQL value limit: ${query.slice(0, 80)}`,
            )
        }
      }

      const started = performance.now()
      let rows_read = 0
      let rows_written = 0
      try {
        return storage.transactionSync(() =>
          statements.map(([query, ...values]) => {
            const cursor = storage.sql.exec(query, ...values)
            const rows = [...cursor.raw()]
            rows_read += cursor.rowsRead
            rows_written += cursor.rowsWritten
            return rows
          }),
        )
      } finally {
        options.observe?.({
          kind,
          operation,
          statements: statements.length,
          rows_read,
          rows_written,
          duration_ms: performance.now() - started,
        })
      }
    },
    value_limit: valueLimit,
  }
}

export declare namespace create {
  type Options = {
    observe?: ((observation: Observation) => void) | undefined
    valueLimit?: number | undefined
  }
}

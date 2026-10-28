/**
 * SQL host of the runtime over Durable Object SQLite storage: it runs each transaction of the SDK
 * synchronously, enforces the host's value limit, and reports each transaction to an observer.
 *
 * @module
 */
import type * as Contracts from '../Contracts.ts'

/** Cursor of one SQL statement. */
export type Cursor = {
  /** Iterates the result rows as arrays. */
  raw(): IterableIterator<Contracts.SqlValue[]>
  /** Rows that the statement read. */
  readonly rowsRead: number
  /** Rows that the statement wrote. */
  readonly rowsWritten: number
}

/** Capabilities of Durable Object storage that the SQL host uses. */
export type Storage = {
  /** SQL interface of the storage. */
  readonly sql: { exec(query: string, ...bindings: Contracts.SqlValue[]): Cursor }
  /** Runs `closure` in one synchronous transaction. */
  transactionSync<T>(closure: () => T): T
}

/** Measurements of one transaction. */
export type Observation = {
  /** Store that the transaction wrote. */
  kind: Contracts.SqlKind
  /** Operation of the SDK that ran the transaction. */
  operation: string
  /** Number of statements in the transaction. */
  statements: number
  /** Rows that the transaction read. */
  rows_read: number
  /** Rows that the transaction wrote. */
  rows_written: number
  /** Duration of the transaction in milliseconds. */
  duration_ms: number
}

/** SQL host over Durable Object storage. */
export type Host = Contracts.SqlHost & {
  /** Largest bound value in bytes. */
  readonly value_limit: number
  /** Storage that the host writes. */
  readonly storage: Storage
  /** Runs `statements` in one transaction and returns the rows of each statement. */
  transaction(
    kind: Contracts.SqlKind,
    operation: string,
    statements: Contracts.Statement[],
  ): Contracts.SqlValue[][][]
}

/** Largest value in bytes that Durable Object SQLite storage binds. */
export const valueLimitBytes = 8_388_608

/**
 * Returns a SQL host over `storage`. Throws when `options.valueLimit` is not a positive integer.
 * A transaction throws before it starts when a bound value exceeds the limit.
 */
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
    /** Receives the measurements of each transaction, after it commits or fails. */
    observe?: ((observation: Observation) => void) | undefined
    /** Largest bound value in bytes. Defaults to `valueLimitBytes`. */
    valueLimit?: number | undefined
  }
}

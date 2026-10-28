/**
 * `node:sqlite` implementation of the `SqlHost` contract for integration suites.
 *
 * @module
 */
import { DatabaseSync } from 'node:sqlite'
import type { SqlHost, SqlKind, SqlValue, Statement } from '../src/contracts.ts'

/**
 * Opens a SQLite database and returns a `SqlHost` over it, with a count of transactions by kind.
 */
export function open(options: open.Options = {}): open.ReturnType {
  const db = new DatabaseSync(options.path ?? ':memory:')
  const counts = { log: 0, store: 0 }

  const sql: SqlHost = {
    transaction(kind: SqlKind, _operation: string, statements: Statement[]) {
      counts[kind]++
      db.exec('BEGIN IMMEDIATE')

      try {
        const rows = statements.map((statement) => {
          const [query, ...values] = statement
          const prepared = db.prepare(query)
          prepared.setReturnArrays(true)
          return prepared.all(
            ...values.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as unknown as SqlValue[][]
        })
        db.exec('COMMIT')
        return rows
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }

  return { close: () => db.close(), counts, sql }
}

export declare namespace open {
  type Options = {
    /** Database file. Defaults to an in-memory database. */
    path?: string | undefined
  }

  type ReturnType = {
    /** Closes the database. */
    close(): void
    /** Number of transactions run for each `SqlKind`. */
    counts: Record<SqlKind, number>
    /** The `SqlHost` over the database. */
    sql: SqlHost
  }
}

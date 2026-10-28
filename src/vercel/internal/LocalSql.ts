/**
 * In-memory `node:sqlite` replica that replays a session's committed SQL batches.
 *
 * @module
 */
import * as sqlite from 'node:sqlite'
import { Fatal } from 'durable-harness'
import type * as Contracts from '../../Contracts.ts'
import type * as Journal from '../Journal.ts'

/** SQLite replica of a session's log. */
export type LocalSql = {
  /** Closes the database. */
  close(): void
  /** Runs statements in one immediate transaction and returns each statement's rows. */
  run(statements: Contracts.Statement[]): Contracts.SqlValue[][][]
  /** Returns a value that changes after every write and schema change. */
  version(): string
}

/** Opens an in-memory database and replays `batches` into it. Throws `Fatal` when a batch does not replay. */
export function create(batches: Journal.Transaction[][]): LocalSql {
  const db = new sqlite.DatabaseSync(':memory:')
  const statements = new Map<string, sqlite.StatementSync>()

  const prepare = (query: string) => {
    let statement = statements.get(query)
    if (!statement) {
      statement = db.prepare(query)
      statement.setReturnArrays(true)
      statements.set(query, statement)
    }
    return statement
  }

  const run = (list: Contracts.Statement[]) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = list.map((statement) => {
        const [query, ...values] = statement
        return prepare(query).all(
          ...(values as (string | null)[]),
        ) as unknown as Contracts.SqlValue[][]
      })
      db.exec('COMMIT')
      return rows
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  batches.forEach((transactions, n) => {
    for (const transaction of transactions) {
      try {
        run(transaction.statements)
      } catch (error) {
        throw new Fatal(
          `nanocode: SQL batch ${n} of the session's log does not replay: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  })

  return {
    close: () => db.close(),
    run,
    version() {
      const [changes, schema] = prepare(
        'SELECT total_changes(), schema_version FROM pragma_schema_version',
      ).get() as unknown as [number, number]
      return `${changes}:${schema}`
    },
  }
}

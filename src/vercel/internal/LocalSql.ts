import * as sqlite from 'node:sqlite'
import { Fatal } from 'durable-harness'
import type * as Contracts from '../../Contracts.ts'
import type * as Journal from '../Journal.ts'

export type LocalSql = {
  close(): void
  run(statements: Contracts.Statement[], access?: Contracts.SqlAccess): Contracts.SqlValue[][][]
  version(): string
}

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

  const run = (list: Contracts.Statement[], access: Contracts.SqlAccess = 'write') => {
    const all = () =>
      list.map((statement) => {
        const [query, ...values] = statement
        const prepared = access === 'schema' ? db.prepare(query) : prepare(query)
        if (access === 'schema') prepared.setReturnArrays(true)
        return prepared.all(
          ...values.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)),
        ) as unknown as Contracts.SqlValue[][]
      })
    if (access === 'read') return all()
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = all()
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
        run(transaction.statements, transaction.access)
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

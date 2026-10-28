/**
 * Checkpoint store of a session: the SQL host of its runtimes, with per-store counters of the
 * statements and rows of each transaction.
 *
 * @module
 */
import * as Timing from '../../Timing.ts'
import * as Sql from '../Sql.ts'

/** One result row. */
export type Row = Record<string, SqlStorageValue>

/** Counters of the transactions of one store. */
export type Metrics = {
  /** Transactions per SDK operation. */
  operations: Record<string, number>
  /** Statements in all transactions. */
  statements: number
  /** Point queries outside the SDK's transactions. */
  point_queries: number
  /** Rows that the transactions read. */
  rows_read: number
  /** Rows that the transactions wrote. */
  rows_written: number
}

/** SQL host with counters for the checkpoint store and the event log. */
export type Checkpoints = Sql.Host & {
  /** Counters of the event log. */
  readonly log: Metrics
  /** Counters of the checkpoint store. */
  readonly metrics: Metrics
  /** Returns the counts of persisted states and records, and the unfinished turns of `scope`. */
  persisted(scope: string): Row | undefined
  /** Runs one query outside a transaction and returns its first row. */
  row(query: string, ...values: SqlStorageValue[]): Row | undefined
  /** Durations of the transactions per SDK operation. */
  readonly timings: Timing.Timings
}

/** Returns the checkpoint store over `storage`. */
export function create(storage: DurableObjectStorage, options: create.Options = {}): Checkpoints {
  const log = metrics()
  const counters = metrics()
  const timings = Timing.create()

  const sql = Sql.create(storage, {
    observe: (observation) => {
      const into = observation.kind === 'log' ? log : counters
      into.operations[observation.operation] = (into.operations[observation.operation] ?? 0) + 1
      into.statements += observation.statements
      into.rows_read += observation.rows_read
      into.rows_written += observation.rows_written
      timings.record(observation.operation, observation.duration_ms)
    },
    valueLimit: options.valueLimit,
  })

  const row = (query: string, ...values: SqlStorageValue[]): Row | undefined => {
    counters.point_queries++
    return storage.sql.exec(query, ...values).toArray()[0]
  }

  return {
    log,
    metrics: counters,
    persisted(scope) {
      const tables = new Set(
        storage.sql
          .exec(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('records', 'blobs', 'turns')",
          )
          .toArray()
          .map((row) => row.name),
      )
      const count = (table: string) => (tables.has(table) ? `(SELECT COUNT(*) FROM ${table})` : '0')
      const stored = tables.has('records')
        ? `(SELECT COUNT(*) FROM states) AS states, ${count('records')} + ${count('blobs')} AS records`
        : '0 AS states, 0 AS records'
      if (!tables.has('turns')) return row(`SELECT ${stored}, 0 AS unfinished`)
      return row(
        `SELECT ${stored}, (SELECT COUNT(*) FROM turns WHERE scope = ? AND status IN ('queued', 'running')) AS unfinished`,
        scope,
      )
    },
    row,
    storage,
    timings,
    transaction: sql.transaction,
    value_limit: sql.value_limit,
  }
}

export declare namespace create {
  type Options = {
    /** Largest bound value in bytes. Defaults to `Sql.valueLimitBytes`. */
    valueLimit?: number | undefined
  }
}

function metrics(): Metrics {
  return { operations: {}, statements: 0, point_queries: 0, rows_read: 0, rows_written: 0 }
}

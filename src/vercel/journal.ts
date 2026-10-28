import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { type DriveContext, Fatal, Restart, type SessionState } from 'durable-harness'
import type * as Contracts from '../Contracts.ts'

export const SQL_STEP = 'nanocode.sql'

export type Transaction = {
  kind: Contracts.SqlKind
  operation: string
  statements: Contracts.Statement[]
}

type Batch = { transactions: Transaction[] } | { packed: Uint8Array }

type Packed = { transactions: Transaction[]; sizes: number[] }

const BROTLI_QUALITY = 3

type Committed = { writer: string }

type Entry = {
  transaction?: Transaction
  bytes: number
  resolve(): void
  reject(error: unknown): void
}

export type Durability = 'on' | 'strict'

export const DEFAULT_BATCH_MS = 500

const BATCH_BYTES = 24 * 1024 * 1024

export type JournalStats = {
  replayed_batches: number
  replayed_transactions: number
  batches: number
  transactions: number
  reads: number
  batch_wait_ms: number
}

export const batchKey = (n: number) => `sql:${n}`

function weight(transaction: Transaction | undefined): number {
  let bytes = 0
  for (const statement of transaction?.statements ?? [])
    for (const value of statement)
      bytes +=
        value instanceof ArrayBuffer
          ? value.byteLength
          : ArrayBuffer.isView(value)
            ? value.byteLength
            : typeof value === 'string'
              ? value.length
              : 8
  return bytes
}

function pack(transactions: Transaction[]): Uint8Array {
  const blobs: Uint8Array[] = []
  const encoded = transactions.map((transaction) => ({
    ...transaction,
    statements: transaction.statements.map((statement) =>
      statement.map((value) => {
        if (value instanceof ArrayBuffer) return { $b: blobs.push(new Uint8Array(value)) - 1 }
        if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
          return { $n: String(value) }
        return value
      }),
    ),
  }))
  const header = Buffer.from(
    JSON.stringify({ transactions: encoded, sizes: blobs.map((blob) => blob.length) }),
  )
  const length = Buffer.alloc(4)
  length.writeUInt32LE(header.length)
  const raw = Buffer.concat([length, header, ...blobs])
  return new Uint8Array(
    brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
  )
}

function unpack(packed: Uint8Array): Transaction[] {
  const raw = brotliDecompressSync(packed)
  const length = raw.readUInt32LE(0)
  const header = JSON.parse(raw.subarray(4, 4 + length).toString('utf8')) as Packed
  const blobs: ArrayBuffer[] = []
  let offset = 4 + length
  for (const size of header.sizes) {
    blobs.push(
      raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + offset + size) as ArrayBuffer,
    )
    offset += size
  }
  return header.transactions.map((transaction) => ({
    ...transaction,
    statements: transaction.statements.map(
      (statement) =>
        statement.map((value) => {
          if (value && typeof value === 'object' && '$b' in value)
            return blobs[(value as { $b: number }).$b]!
          if (value && typeof value === 'object' && '$n' in value)
            return Number((value as { $n: string }).$n)
          return value
        }) as Contracts.Statement,
    ),
  }))
}

export function committedBatches(state: SessionState): Transaction[][] {
  const batches: Transaction[][] = []
  for (
    let record = state.effects.get(batchKey(0));
    record?.status === 'completed';
    record = state.effects.get(batchKey(batches.length))
  ) {
    const input = record.input as Batch
    batches.push('packed' in input ? unpack(input.packed) : input.transactions)
  }
  return batches
}

export class LocalSql {
  private readonly db = new DatabaseSync(':memory:')
  private readonly statements = new Map<string, StatementSync>()

  constructor(batches: Transaction[][]) {
    batches.forEach((transactions, n) => {
      for (const { statements } of transactions) {
        try {
          this.run(statements)
        } catch (error) {
          throw new Fatal(
            `nanocode: SQL batch ${n} of the session's log does not replay: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    })
  }

  run(statements: Contracts.Statement[]): Contracts.SqlValue[][][] {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const rows = statements.map(
        ([query, ...values]) =>
          this.prepare(query).all(
            ...(values as (string | null)[]),
          ) as unknown as Contracts.SqlValue[][],
      )
      this.db.exec('COMMIT')
      return rows
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  version(): string {
    const [changes, schema] = this.prepare(
      'SELECT total_changes(), schema_version FROM pragma_schema_version',
    ).get() as unknown as [number, number]
    return `${changes}:${schema}`
  }

  close(): void {
    this.db.close()
  }

  private prepare(query: string): StatementSync {
    let statement = this.statements.get(query)
    if (!statement) {
      statement = this.db.prepare(query)
      statement.setReturnArrays(true)
      this.statements.set(query, statement)
    }
    return statement
  }
}

export class SqlJournal implements Contracts.SqlHost {
  private readonly ctx: DriveContext
  private readonly durability: Durability
  private readonly sql: LocalSql
  private readonly writer = crypto.randomUUID()
  private queue: Entry[] = []
  private queued = 0
  private flushing = false
  private failure?: { error: unknown }
  private committed: number
  private readonly batchMs: number
  private lastBatch = -Infinity
  private hurry?: () => void
  private closed = false
  readonly stats: JournalStats

  constructor(ctx: DriveContext, durability: Durability, batchMs = DEFAULT_BATCH_MS) {
    this.ctx = ctx
    this.durability = durability
    this.batchMs = durability === 'on' ? batchMs : 0
    const batches = committedBatches(ctx.state())
    this.sql = new LocalSql(batches)
    this.committed = batches.length
    this.stats = {
      replayed_batches: batches.length,
      replayed_transactions: batches.reduce((count, batch) => count + batch.length, 0),
      batches: 0,
      transactions: 0,
      reads: 0,
      batch_wait_ms: 0,
    }
  }

  get batches(): number {
    return this.committed
  }

  transaction(
    kind: Contracts.SqlKind,
    operation: string,
    statements: Contracts.Statement[],
  ): Promise<Contracts.SqlValue[][][]> {
    if (this.failure) return Promise.reject(this.failure.error)
    let rows: Contracts.SqlValue[][][]
    let wrote: boolean
    try {
      const before = this.sql.version()
      rows = this.sql.run(statements)
      wrote = this.sql.version() !== before
    } catch (error) {
      return Promise.reject(error)
    }
    if (wrote) this.stats.transactions++
    else this.stats.reads++
    const durable = this.enqueue(wrote ? { kind, operation, statements } : undefined)
    if (this.durability === 'strict' || this.queued > BATCH_BYTES) return durable.then(() => rows)
    durable.catch(() => undefined)
    return Promise.resolve(rows)
  }

  durable(): Promise<void> {
    return this.enqueue(undefined)
  }

  close(): void {
    this.closed = true
    this.hurry?.()
    this.sql.close()
  }

  private enqueue(transaction: Transaction | undefined): Promise<void> {
    if (this.failure) return Promise.reject(this.failure.error)
    if (!transaction && !this.flushing && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const bytes = weight(transaction)
      this.queued += bytes
      this.queue.push({ transaction, bytes, resolve, reject })
      if (!transaction) this.hurry?.()
      void this.flush()
    })
  }

  private pace(): Promise<void> {
    const wait =
      this.queued >= BATCH_BYTES || this.queue.some((entry) => !entry.transaction)
        ? 0
        : this.lastBatch + this.batchMs - performance.now()
    if (wait <= 0) return new Promise((resolve) => setImmediate(resolve))
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, wait)
      this.hurry = done
      function done() {
        clearTimeout(timer)
        resolve()
      }
    }).finally(() => {
      this.hurry = undefined
    })
  }

  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.queue.length) {
        await this.pace()
        if (this.closed) {
          const error = new Error('the SQL journal closed with writes that were not committed')
          this.queued = 0
          for (const entry of this.queue.splice(0)) entry.reject(error)
          return
        }
        let count = 0
        let bytes = 0
        while (
          count < this.queue.length &&
          (count === 0 || bytes + this.queue[count]!.bytes <= BATCH_BYTES)
        )
          bytes += this.queue[count++]!.bytes
        const entries = this.queue.splice(0, count)
        this.queued -= bytes
        const transactions = entries.flatMap((entry) =>
          entry.transaction ? [entry.transaction] : [],
        )
        try {
          if (transactions.length) await this.commit(transactions)
        } catch (error) {
          this.failure = { error }
          this.queued = 0
          for (const entry of [...entries, ...this.queue.splice(0)]) entry.reject(error)
          this.ctx.halt?.(error)
          return
        }
        for (const entry of entries) entry.resolve()
      }
    } finally {
      this.flushing = false
    }
  }

  private async commit(transactions: Transaction[]): Promise<void> {
    const n = this.committed
    const started = performance.now()
    const output = await this.ctx.effect(
      batchKey(n),
      { name: SQL_STEP, replay: 'safe', input: { packed: pack(transactions) } satisfies Batch },
      async (): Promise<Committed> => ({ writer: this.writer }),
    )
    this.stats.batch_wait_ms += performance.now() - started
    if (output.writer !== this.writer)
      throw new Restart(`SQL batch ${n} was committed by another drive`)
    this.committed = n + 1
    this.lastBatch = performance.now()
    this.stats.batches++
  }
}

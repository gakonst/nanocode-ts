import * as zlib from 'node:zlib'
import { type DriveContext, Restart, type SessionState } from 'durable-harness'
import type * as Contracts from '../Contracts.ts'
import * as LocalSql from './internal/LocalSql.ts'

export const sqlStep = 'nanocode.sql'

export type Transaction = {
  kind: Contracts.SqlKind
  operation: string
  statements: Contracts.Statement[]
}

type Batch = { transactions: Transaction[] } | { packed: Uint8Array }

type Packed = { transactions: Transaction[]; sizes: number[] }

const brotliQuality = 3

type Committed = { writer: string }

type Entry = {
  transaction?: Transaction
  bytes: number
  resolve(): void
  reject(error: unknown): void
}

export type Durability = 'on' | 'strict'

export const defaultBatchMs = 500

const batchBytes = 24 * 1024 * 1024

export type Stats = {
  replayed_batches: number
  replayed_transactions: number
  batches: number
  transactions: number
  reads: number
  batch_wait_ms: number
}

export type Journal = Contracts.SqlHost & {
  readonly batches: number
  close(): void
  durable(): Promise<void>
  readonly stats: Stats
}

export function batchKey(n: number): string {
  return `sql:${n}`
}

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
    zlib.brotliCompressSync(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
  )
}

function unpack(packed: Uint8Array): Transaction[] {
  const raw = zlib.brotliDecompressSync(packed)
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

export function committed(state: SessionState): Transaction[][] {
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

export function create(ctx: DriveContext, options: create.Options = {}): Journal {
  const durability = options.durability ?? 'on'
  const batchMs = durability === 'on' ? (options.batchMs ?? defaultBatchMs) : 0
  const batches = committed(ctx.state())
  const sql = LocalSql.create(batches)
  const writer = crypto.randomUUID()
  const stats: Stats = {
    replayed_batches: batches.length,
    replayed_transactions: batches.reduce((count, batch) => count + batch.length, 0),
    batches: 0,
    transactions: 0,
    reads: 0,
    batch_wait_ms: 0,
  }

  let closed = false
  let count = batches.length
  let failure: { error: unknown } | undefined
  let flushing = false
  let hurry: (() => void) | undefined
  let lastBatch = -Infinity
  const queue: Entry[] = []
  let queued = 0

  const enqueue = (transaction: Transaction | undefined): Promise<void> => {
    if (failure) return Promise.reject(failure.error)
    if (!transaction && !flushing && queue.length === 0) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const bytes = weight(transaction)
      queued += bytes
      queue.push({ transaction, bytes, resolve, reject })
      if (!transaction) hurry?.()
      void flush()
    })
  }

  const pace = (): Promise<void> => {
    const wait =
      queued >= batchBytes || queue.some((entry) => !entry.transaction)
        ? 0
        : lastBatch + batchMs - performance.now()
    if (wait <= 0) return new Promise((resolve) => setImmediate(resolve))

    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, wait)
      hurry = done
      function done() {
        clearTimeout(timer)
        resolve()
      }
    }).finally(() => {
      hurry = undefined
    })
  }

  const commit = async (transactions: Transaction[]): Promise<void> => {
    const n = count
    const started = performance.now()
    const output = await ctx.effect(
      batchKey(n),
      { name: sqlStep, replay: 'safe', input: { packed: pack(transactions) } satisfies Batch },
      async (): Promise<Committed> => ({ writer }),
    )
    stats.batch_wait_ms += performance.now() - started

    if (output.writer !== writer) throw new Restart(`SQL batch ${n} was committed by another drive`)

    count = n + 1
    lastBatch = performance.now()
    stats.batches++
  }

  const flush = async (): Promise<void> => {
    if (flushing) return
    flushing = true
    try {
      while (queue.length) {
        await pace()
        if (closed) {
          const error = new Error('the SQL journal closed with writes that were not committed')
          queued = 0
          for (const entry of queue.splice(0)) entry.reject(error)
          return
        }

        let taken = 0
        let bytes = 0
        while (taken < queue.length && (taken === 0 || bytes + queue[taken]!.bytes <= batchBytes))
          bytes += queue[taken++]!.bytes
        const entries = queue.splice(0, taken)
        queued -= bytes
        const transactions = entries.flatMap((entry) =>
          entry.transaction ? [entry.transaction] : [],
        )

        try {
          if (transactions.length) await commit(transactions)
        } catch (error) {
          failure = { error }
          queued = 0
          for (const entry of [...entries, ...queue.splice(0)]) entry.reject(error)
          ctx.halt?.(error)
          return
        }

        for (const entry of entries) entry.resolve()
      }
    } finally {
      flushing = false
    }
  }

  return {
    get batches() {
      return count
    },
    close() {
      closed = true
      hurry?.()
      sql.close()
    },
    durable: () => enqueue(undefined),
    stats,
    transaction(kind, operation, statements) {
      if (failure) return Promise.reject(failure.error)

      let rows: Contracts.SqlValue[][][]
      let wrote: boolean
      try {
        const before = sql.version()
        rows = sql.run(statements)
        wrote = sql.version() !== before
      } catch (error) {
        return Promise.reject(error)
      }

      if (wrote) stats.transactions++
      else stats.reads++

      const durable = enqueue(wrote ? { kind, operation, statements } : undefined)
      if (durability === 'strict' || queued > batchBytes) return durable.then(() => rows)
      durable.catch(() => undefined)
      return Promise.resolve(rows)
    },
  }
}

export declare namespace create {
  type Options = {
    batchMs?: number | undefined
    durability?: Durability | undefined
  }
}

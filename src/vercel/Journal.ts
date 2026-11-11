import * as crypto from 'node:crypto'
import * as zlib from 'node:zlib'
import { type DriveContext, Fatal, Restart, type SessionState } from 'durable-harness'
import type * as Contracts from '../Contracts.ts'
import * as LocalSql from './internal/LocalSql.ts'

export const sqlStep = 'nanocode.sql'

export type Transaction = {
  kind: Contracts.SqlKind
  access?: Contracts.SqlAccess | undefined
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

export type Opened = {
  replayed: { batches: number; transactions: number }
  replica: Replica
}

export type Replica = {
  batches: number
  digests: string[]
  runId: string
  sql: LocalSql.LocalSql
}

export type Replicas = {
  keep(replica: Replica): void
  take(runId: string): Replica | undefined
}

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

function digest(packed: Uint8Array): string {
  return crypto.createHash('sha256').update(packed).digest('hex')
}

function inputs(state: SessionState): Batch[] {
  const batches: Batch[] = []
  for (
    let record = state.effects.get(batchKey(0));
    record?.status === 'completed';
    record = state.effects.get(batchKey(batches.length))
  )
    batches.push(record.input as Batch)
  return batches
}

export function committed(state: SessionState): Transaction[][] {
  return inputs(state).map((input) =>
    'packed' in input ? unpack(input.packed) : input.transactions,
  )
}

export function open(state: SessionState, replicas?: Replicas): Opened {
  const batches = inputs(state)
  const kept = replicas?.take(state.runId)
  const reused = (() => {
    if (!kept) return undefined
    if (kept.batches > batches.length) {
      replicas?.keep(kept)
      return undefined
    }
    const same = kept.digests.every((known, n) => {
      const input = batches[n]!
      return 'packed' in input && digest(input.packed) === known
    })
    if (same) return kept
    kept.sql.close()
    return undefined
  })()
  const replica = reused ?? {
    batches: 0,
    digests: [],
    runId: state.runId,
    sql: LocalSql.create([]),
  }
  const from = replica.batches
  let transactions = 0

  try {
    for (let n = from; n < batches.length; n++) {
      const input = batches[n]!
      const replayed = 'packed' in input ? unpack(input.packed) : input.transactions
      replica.sql.replay(replayed, n)
      transactions += replayed.length
      if ('packed' in input && replica.digests.length === n)
        replica.digests.push(digest(input.packed))
      replica.batches = n + 1
    }
  } catch (error) {
    replica.sql.close()
    throw error
  }

  return { replayed: { batches: batches.length - from, transactions }, replica }
}

export function read(state: SessionState, replicas?: Replicas): read.ReturnType {
  const { replica } = open(state, replicas)
  const version = replica.sql.version()

  return {
    close() {
      if (replicas && replica.sql.version() === version) replicas.keep(replica)
      else replica.sql.close()
    },
    sql: replica.sql,
  }
}

export declare namespace read {
  type ReturnType = {
    close(): void
    sql: LocalSql.LocalSql
  }
}

export function replicas(options: replicas.Options): Replicas {
  const kept = new Map<string, { bytes: number; replica: Replica }>()
  let total = 0

  const take = (runId: string) => {
    const found = kept.get(runId)
    if (!found) return undefined
    kept.delete(runId)
    total -= found.bytes
    return found.replica
  }

  return {
    keep(replica) {
      const bytes = replica.sql.bytes()
      const longer = kept.get(replica.runId)
      if (
        replica.digests.length !== replica.batches ||
        bytes > options.bytes ||
        (longer && longer.replica.batches >= replica.batches)
      ) {
        replica.sql.close()
        return
      }

      take(replica.runId)?.sql.close()
      kept.set(replica.runId, { bytes, replica })
      total += bytes
      for (const runId of kept.keys()) {
        if (total <= options.bytes) break
        take(runId)?.sql.close()
      }
    },
    take,
  }
}

export declare namespace replicas {
  type Options = {
    bytes: number
  }
}

export function create(ctx: DriveContext, options: create.Options = {}): Journal {
  const durability = options.durability ?? 'on'
  const batchMs = durability === 'on' ? (options.batchMs ?? defaultBatchMs) : 0
  const { replayed, replica } = open(ctx.state(), options.replicas)
  const sql = replica.sql
  const writer = crypto.randomUUID()
  const stats: Stats = {
    replayed_batches: replayed.batches,
    replayed_transactions: replayed.transactions,
    batches: 0,
    transactions: 0,
    reads: 0,
    batch_wait_ms: 0,
  }

  let closed = false
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
    const n = replica.batches
    const started = performance.now()
    const packed = pack(transactions)
    const output = await ctx.effect(
      batchKey(n),
      { name: sqlStep, replay: 'safe', input: { packed } satisfies Batch },
      async (): Promise<Committed> => ({ writer }),
    )
    stats.batch_wait_ms += performance.now() - started

    if (output.writer !== writer) throw new Restart(`SQL batch ${n} was committed by another drive`)

    if (replica.digests.length === n) replica.digests.push(digest(packed))
    replica.batches = n + 1
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
      return replica.batches
    },
    close() {
      if (closed) return
      closed = true
      hurry?.()
      if (options.replicas && !failure && !flushing && queue.length === 0)
        options.replicas.keep(replica)
      else sql.close()
    },
    durable: () => enqueue(undefined),
    stats,
    transaction(kind, operation, statements, access = 'write') {
      if (failure) return Promise.reject(failure.error)
      if (closed) return Promise.reject(new Error('the SQL journal is closed'))

      let rows: Contracts.SqlValue[][][]
      let wrote: boolean
      try {
        const before = sql.version()
        rows = sql.run(statements, access)
        wrote = sql.version() !== before
      } catch (error) {
        return Promise.reject(error)
      }

      if (wrote && access === 'read') {
        const error = new Fatal(
          `nanocode: the ${kind} ${operation} transaction is marked read but changed the database`,
        )
        failure = { error }
        ctx.halt?.(error)
        return Promise.reject(error)
      }

      if (wrote) stats.transactions++
      else stats.reads++
      if (!wrote && durability !== 'strict') return Promise.resolve(rows)

      const durable = enqueue(
        wrote
          ? { kind, ...(access === 'write' ? {} : { access }), operation, statements }
          : undefined,
      )
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
    replicas?: Replicas | undefined
  }
}

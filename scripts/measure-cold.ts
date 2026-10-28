import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import * as Contracts from '../src/Contracts.ts'
import * as AgentRuntime from '../src/AgentRuntime.ts'

const SCOPE = 'owner'
const ENDPOINTS = {
  claude: 'https://api.anthropic.com/v1/messages',
  codex: 'https://api.openai.com/v1',
}
const { values } = parseArgs({
  options: {
    child: { type: 'string' },
    database: { type: 'string' },
    session: { type: 'string' },
    providers: { type: 'string', default: 'claude,codex' },
    rounds: { type: 'string', default: '5' },
    history: { type: 'string', default: '20' },
    'reply-bytes': { type: 'string', default: '20000' },
    label: { type: 'string', default: 'run' },
  },
})
const wasmPath = process.env.NANOCODE_WASM_PATH ?? 'dist/nanocode_wasm.wasm'
const replyBytes = Number(values['reply-bytes'])
const round = (value) => Math.round(value * 100) / 100
const sse = (events) =>
  new Response(
    events
      .map(
        ([event, data]) => (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
let calls = 0

function reply(provider, input) {
  const call = calls++
  const text = 'x'.repeat(replyBytes)
  if (provider === 'claude')
    return sse([
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: `message-${call}`,
            type: 'message',
            role: 'assistant',
            model: input.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 8, output_tokens: 0 },
          },
        },
      ],
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 4 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ])
  const id = `resp_${call}`
  const item = {
    type: 'message',
    id: `msg_${call}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  }
  return sse([
    [null, { type: 'response.created', response: { id, status: 'in_progress' } }],
    [
      null,
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
    ],
    [
      null,
      {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: text,
      },
    ],
    [null, { type: 'response.output_item.done', output_index: 0, item }],
    [
      null,
      {
        type: 'response.completed',
        response: {
          id,
          status: 'completed',
          model: input.model,
          output: [item],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        },
      },
    ],
  ])
}

function database(path) {
  const db = new DatabaseSync(path)
  const operations = []
  const sql = {
    transaction(kind, operation, statements) {
      const started = performance.now()
      db.exec('BEGIN IMMEDIATE')
      let bytes = 0
      try {
        const rows = statements.map(([query, ...values]) => {
          const statement = db.prepare(query)
          statement.setReturnArrays(true)
          const result = statement.all(...values)
          for (const row of result)
            for (const cell of row) bytes += typeof cell === 'string' ? cell.length : 0
          return result
        })
        db.exec('COMMIT')
        operations.push({
          kind,
          operation,
          statements: statements.length,
          read_bytes: bytes,
          ms: round(performance.now() - started),
        })
        return rows
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { db, operations, sql }
}

async function instance(module, provider, path, sessionId) {
  const store = database(path)
  const marks = {}
  let started = performance.now()
  const runtime = await AgentRuntime.instantiate(module, store.sql, { published: () => {} })
  marks.instantiate_ms = performance.now() - started
  started = performance.now()
  await runtime.pending(SCOPE)
  marks.reader_ms = performance.now() - started
  const readerOperations = store.operations.length
  let dispatched
  started = performance.now()
  await runtime.open(
    {
      scope: SCOPE,
      session_id: sessionId,
      provider,
      subscription: false,
      endpoint: ENDPOINTS[provider],
      event_coalesce_ms: 0,
      tools: [],
    },
    {
      dispatch: async (request) => {
        dispatched?.(request.body.byteLength)
        return reply(provider, JSON.parse(new TextDecoder().decode(request.body)))
      },
    },
  )
  marks.open_ms = performance.now() - started
  marks.open_operations = store.operations.slice(readerOperations)
  return {
    runtime,
    store,
    marks,
    onDispatch: (callback) => {
      dispatched = callback
    },
  }
}

async function turn(session, requestId) {
  const marks = {}
  const started = performance.now()
  const before = session.store.operations.length
  session.onDispatch((bytes) => {
    marks.dispatch_ms ??= performance.now() - started
    marks.request_bytes ??= bytes
    marks.operations_before_dispatch ??= session.store.operations.slice(before)
  })
  const submitted = await session.runtime.submit(SCOPE, {
    request_id: requestId,
    prompt: `Reply for ${requestId}`,
    metadata: {},
  })
  if (submitted.submitted !== 'accepted')
    throw new Error(`turn ${requestId} was ${submitted.submitted}`)
  marks.submit_ms = performance.now() - started
  for (;;) {
    const next = (await session.runtime.pending(SCOPE))[0]
    if (!next) break
    const driven = await session.runtime.drive(next.report.request_id)
    if (driven.retry) throw new Error(`turn ${requestId} needs recovery`)
    if (driven.waiting) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  marks.turn_ms = performance.now() - started
  while (!(await session.runtime.settle())) await new Promise((resolve) => setTimeout(resolve, 5))
  const report = (await session.runtime.turn(SCOPE, requestId))?.report
  if (report?.status !== 'completed')
    throw new Error(`turn ${requestId} did not complete: ${JSON.stringify(report)}`)
  return marks
}

function rounded(value) {
  if (typeof value === 'number') return round(value)
  if (Array.isArray(value)) return value.map(rounded)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rounded(entry)]))
  return value
}

async function child(provider, path, sessionId) {
  const marks = {}
  let started = performance.now()
  const bytes = readFileSync(wasmPath)
  marks.read_ms = performance.now() - started
  started = performance.now()
  const module = await WebAssembly.compile(bytes)
  marks.compile_ms = performance.now() - started
  const cold = await instance(module, provider, path, sessionId)
  const coldTurn = await turn(cold, `cold-${Date.now()}`)
  const warmTurn = await turn(cold, `warm-${Date.now()}`)
  await cold.runtime.dispose()
  cold.store.db.close()
  const again = await instance(module, provider, path, sessionId)
  const againTurn = await turn(again, `again-${Date.now()}`)
  await again.runtime.dispose()
  again.store.db.close()
  return rounded({
    provider,
    ...marks,
    cold: { ...cold.marks, turn: coldTurn, warm_turn: warmTurn },
    compiled: { ...again.marks, turn: againTurn },
  })
}

async function prepare(provider, history) {
  const path = `output/cold-${provider}.sqlite`
  rmSync(path, { force: true })
  const sessionId = Contracts.sessionUuid()
  const module = await WebAssembly.compile(readFileSync(wasmPath))
  const session = await instance(module, provider, path, sessionId)
  for (let index = 0; index < history; index++) await turn(session, `history-${index}`)
  await session.runtime.dispose()
  const size = session.store.db
    .prepare(
      'SELECT (SELECT COALESCE(SUM(LENGTH(value)), 0) FROM blobs) AS records, (SELECT COUNT(*) FROM blobs) AS count, (SELECT LENGTH(payload) FROM states ORDER BY LENGTH(payload) DESC LIMIT 1) AS head',
    )
    .get()
  session.store.db.close()
  return {
    path,
    sessionId,
    records_bytes: size.records,
    records: size.count,
    head_bytes: size.head,
  }
}

if (values.child) {
  process.stdout.write(JSON.stringify(await child(values.child, values.database, values.session)))
} else {
  mkdirSync('output', { recursive: true })
  const report = {
    node: process.version,
    wasm: wasmPath,
    wasm_bytes: readFileSync(wasmPath).byteLength,
    label: values.label,
    history: Number(values.history),
    reply_bytes: replyBytes,
    measured_at: new Date().toISOString(),
    providers: [],
  }
  for (const provider of values.providers.split(',')) {
    const prepared = await prepare(provider, Number(values.history))
    const rounds = []
    for (let index = 0; index < Number(values.rounds); index++) {
      const copy = `${prepared.path}-${index}`
      copyFileSync(prepared.path, copy)
      rounds.push(
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              import.meta.filename,
              '--child',
              provider,
              '--database',
              copy,
              '--session',
              prepared.sessionId,
              '--reply-bytes',
              String(replyBytes),
            ],
            { env: process.env, maxBuffer: 1 << 26 },
          ).toString(),
        ),
      )
      rmSync(copy, { force: true })
    }
    const median = (pick) => {
      const sorted = rounds.map(pick).sort((a, b) => a - b)
      const middle = sorted.length >> 1
      return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
    }
    const summary = Object.fromEntries(
      Object.entries({
        compile_ms: (entry) => entry.compile_ms,
        cold_instantiate_ms: (entry) => entry.cold.instantiate_ms,
        cold_reader_ms: (entry) => entry.cold.reader_ms,
        cold_open_ms: (entry) => entry.cold.open_ms,
        cold_dispatch_ms: (entry) => entry.cold.turn.dispatch_ms,
        cold_turn_ms: (entry) => entry.cold.turn.turn_ms,
        warm_dispatch_ms: (entry) => entry.cold.warm_turn.dispatch_ms,
        warm_turn_ms: (entry) => entry.cold.warm_turn.turn_ms,
        compiled_instantiate_ms: (entry) => entry.compiled.instantiate_ms,
        compiled_reader_ms: (entry) => entry.compiled.reader_ms,
        compiled_open_ms: (entry) => entry.compiled.open_ms,
        compiled_dispatch_ms: (entry) => entry.compiled.turn.dispatch_ms,
        compiled_turn_ms: (entry) => entry.compiled.turn.turn_ms,
      }).map(([key, pick]) => [key, median(pick)]),
    )
    report.providers.push({ provider, ...prepared, summary, rounds })
    console.error(provider, JSON.stringify(summary))
  }
  const path = `output/cold-${values.label}-${Date.now()}.json`
  writeFileSync(path, JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify(
      report.providers.map(({ provider, records_bytes, records, head_bytes, summary }) => ({
        provider,
        records_bytes,
        records,
        head_bytes,
        summary,
      })),
    ),
  )
  console.log('report', path)
}

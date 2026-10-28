import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { AgentRuntime, sessionUuid } from '../src/index.ts'

const SCOPE = 'owner'
const LOOKUP = {
  name: 'lookup',
  description: 'Look up the value stored under a key.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
}
const ENDPOINTS = {
  claude: 'https://api.anthropic.com/v1/messages',
  codex: 'https://api.openai.com/v1',
}
const sse = (events) =>
  new Response(
    events
      .map(
        ([event, data]) => (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )

const module = await WebAssembly.compile(
  readFileSync(process.env.NANOCODE_WASM_PATH ?? 'dist/nanocode_wasm.wasm'),
)
mkdirSync('output', { recursive: true })
let calls = 0
const requests = []
const toolCalls = []

function claude(input) {
  const call = calls++
  const result = Array.isArray(input.messages.at(-1).content)
    ? input.messages.at(-1).content.find((block) => block.type === 'tool_result')
    : undefined
  const answered = result !== undefined
  if (answered && !JSON.stringify(result.content).includes('bravo'))
    throw new Error("the Claude tool result lost the host tool's output")
  const blocks = answered
    ? [
        [
          { type: 'text', text: '' },
          { type: 'text_delta', text: 'the value is bravo' },
        ],
      ]
    : [
        [
          { type: 'tool_use', id: `toolu_${call}`, name: LOOKUP.name, input: {} },
          { type: 'input_json_delta', partial_json: JSON.stringify({ key: 'alpha' }) },
        ],
      ]
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
    ...blocks.flatMap(([block, delta], index) => [
      ['content_block_start', { type: 'content_block_start', index, content_block: block }],
      ['content_block_delta', { type: 'content_block_delta', index, delta }],
      ['content_block_stop', { type: 'content_block_stop', index }],
    ]),
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: answered ? 'end_turn' : 'tool_use', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
}

function codex(input) {
  const items = input.input
  const user = items.findLastIndex((item) => item.type === 'message' && item.role === 'user')
  const result = items.find((item, index) => index > user && item.type === 'function_call_output')
  const answered = result !== undefined
  if (answered && !JSON.stringify(result.output).includes('bravo'))
    throw new Error("the Codex tool result lost the host tool's output")
  const call = calls++
  const id = `resp_${call}`
  const item = answered
    ? {
        type: 'message',
        id: `msg_${call}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'the value is bravo' }],
      }
    : {
        type: 'function_call',
        id: `fc_${call}`,
        call_id: `call_${call}`,
        name: LOOKUP.name,
        arguments: JSON.stringify({ key: 'alpha' }),
        status: 'completed',
      }
  return sse([
    [null, { type: 'response.created', response: { id, status: 'in_progress' } }],
    [
      null,
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: item.type === 'message' ? { ...item, status: 'in_progress', content: [] } : item,
      },
    ],
    ...(item.type === 'message'
      ? [
          [
            null,
            {
              type: 'response.output_text.delta',
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              delta: item.content[0].text,
            },
          ],
        ]
      : []),
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
  const counts = { store: 0, log: 0 }
  const sql = {
    transaction(kind, operation, statements) {
      counts[kind]++
      db.exec('BEGIN IMMEDIATE')
      try {
        const rows = statements.map(([query, ...values]) => {
          const statement = db.prepare(query)
          statement.setReturnArrays(true)
          return statement.all(...values)
        })
        db.exec('COMMIT')
        return rows
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { db, counts, sql }
}

async function open(provider, path, sessionId) {
  const store = database(path)
  const events = []
  const started = performance.now()
  const runtime = await AgentRuntime.instantiate(module, store.sql, {
    published: (batch) => events.push(...batch),
  })
  const instantiated = performance.now()
  await runtime.open(
    {
      scope: SCOPE,
      session_id: sessionId,
      provider,
      subscription: false,
      endpoint: ENDPOINTS[provider],
      event_coalesce_ms: 0,
      stream_tool_input: true,
      tools: [LOOKUP],
    },
    {
      dispatch: async (request) => {
        const body = JSON.parse(new TextDecoder().decode(request.body))
        requests.push({
          provider,
          endpoint: request.endpoint,
          credential_free: !request.headers.some(([name]) =>
            ['authorization', 'x-api-key'].includes(name.toLowerCase()),
          ),
          messages: (body.messages ?? body.input).length,
          tools: (
            body.tools ??
            body.input.flatMap((item) => (item.type === 'additional_tools' ? item.tools : []))
          ).map((tool) => tool.name),
        })
        return provider === 'claude' ? claude(body) : codex(body)
      },
      tools: {
        call: async (name, input) => {
          toolCalls.push({ provider, name, input })
          if (name !== LOOKUP.name || input?.key !== 'alpha')
            throw new Error(`unexpected tool call ${name}`)
          return { key: 'alpha', value: 'bravo' }
        },
      },
    },
  )
  return {
    runtime,
    store,
    events,
    instantiate_ms: instantiated - started,
    open_ms: performance.now() - instantiated,
  }
}

async function turn(session, requestId) {
  const started = performance.now()
  const submitted = await session.runtime.submit(SCOPE, {
    request_id: requestId,
    prompt: `Look up alpha for ${requestId}`,
    metadata: {},
  })
  if (submitted.submitted !== 'accepted')
    throw new Error(`turn ${requestId} was ${submitted.submitted}`)
  let finished
  for (;;) {
    const next = (await session.runtime.pending(SCOPE))[0]
    if (!next) break
    const driven = await session.runtime.drive(next.report.request_id)
    if (driven.retry) throw new Error(`turn ${requestId} needs recovery`)
    if (driven.finished?.report.request_id === requestId) finished = driven.finished
    if (driven.waiting) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  while (!(await session.runtime.settle())) await new Promise((resolve) => setTimeout(resolve, 10))
  const report = finished?.report ?? (await session.runtime.turn(SCOPE, requestId))?.report
  if (report?.status !== 'completed' || !JSON.stringify(report).includes('the value is bravo'))
    throw new Error(`turn ${requestId} did not complete: ${JSON.stringify(report)}`)
  return performance.now() - started
}

async function scenario(provider) {
  const path = `output/node-${provider}.sqlite`
  rmSync(path, { force: true })
  const sessionId = sessionUuid()
  const first = await open(provider, path, sessionId)
  const firstRequests = requests.length
  const turns = [await turn(first, 'turn-1'), await turn(first, 'turn-2')]
  const firstEvents = first.events.length
  await first.runtime.dispose()
  first.store.db.close()
  const restored = await open(provider, path, sessionId)
  const replayed = await restored.runtime.page(SCOPE, 0, 1000)
  const restoredTurn = await turn(restored, 'turn-3')
  const last = requests.at(-1)
  if (
    !requests
      .slice(firstRequests)
      .every((request) => request.credential_free && request.tools.includes(LOOKUP.name))
  )
    throw new Error(`${provider} requests did not offer the host tool`)
  if (replayed.events.length < firstEvents)
    throw new Error(`${provider} lost logged events across instances`)
  if (last.messages <= requests[firstRequests].messages)
    throw new Error(`${provider} did not replay its history after reopening`)
  const inputs = new Map()
  for (const { event } of replayed.events) {
    if (event.event?.type !== 'tool.input.delta') continue
    const { call_id, tool, text } = event.event.payload
    if (tool !== LOOKUP.name) throw new Error(`${provider} streamed input for ${tool}`)
    inputs.set(call_id, (inputs.get(call_id) ?? '') + text)
  }
  if (
    inputs.size !== 2 ||
    ![...inputs.values()].every((text) => text === JSON.stringify({ key: 'alpha' }))
  )
    throw new Error(`${provider} streamed tool input ${JSON.stringify([...inputs])}`)
  await restored.runtime.dispose()
  const metrics = restored.runtime.metrics
  restored.store.db.close()
  return {
    provider,
    instantiate_ms: first.instantiate_ms,
    open_ms: first.open_ms,
    reopen_ms: restored.instantiate_ms + restored.open_ms,
    turn_ms: turns,
    restored_turn_ms: restoredTurn,
    model_requests: requests.filter((request) => request.provider === provider).length,
    host_tool_calls: toolCalls.filter((call) => call.provider === provider).length,
    logged_events: replayed.events.length,
    streamed_tool_inputs: inputs.size,
    store_calls: first.store.counts.store + restored.store.counts.store,
    log_calls: first.store.counts.log + restored.store.counts.log,
    wasm_memory_bytes: metrics.wasm_memory_bytes,
  }
}

const report = {
  node: process.version,
  measured_at: new Date().toISOString(),
  scenarios: [await scenario('claude'), await scenario('codex')],
}
const path = `output/node-host-${Date.now()}.json`
writeFileSync(path, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
console.log('report', path)

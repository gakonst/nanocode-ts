import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as Contracts from '../src/Contracts.ts'
import * as AgentRuntime from '../src/AgentRuntime.ts'
import { Bash } from '../src/bash/index.ts'

const N = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 20)
const WAT =
  '(module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))'
const ADD = [
  0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100,
  100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11,
]
export const cells = {
  empty: 'text(1)',
  compute: 'let s = 0; for (let i = 0; i < 1e6; i++) s += i; text(s)',
  'host-tool': "text(JSON.stringify(await tools.lookup({ key: 'a' })))",
  'host-tool-x10':
    "text((await Promise.all(Array.from({ length: 10 }, (_, i) => tools.lookup({ key: 'k' + i })))).length)",
  'store-load': "store('k', { a: [1, 2, 3] }); text(JSON.stringify(load('k')))",
  fetch: "text(await (await fetch('https://bench.invalid/x')).text())",
  bash: "text((await bash('echo hello | wc -c')).stdout)",
  'bash-file':
    "await bash.writeFile('/workspace/f.txt', 'x'.repeat(100000)); text((await bash('wc -c /workspace/f.txt')).stdout)",
  wasm:
    'const { instance } = await WebAssembly.instantiate(new Uint8Array(' +
    JSON.stringify(ADD) +
    ')); text(await instance.exports.add(2, 3))',
  'output-100k': "text('x'.repeat(100000))",
}

const module = await WebAssembly.compile(
  readFileSync(process.env.NANOCODE_WASM_PATH ?? 'dist/nanocode_wasm.wasm'),
)
const enc = new TextEncoder()
const sse = (events) =>
  new Response(
    enc.encode(
      events.map(([e, d]) => 'event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n').join(''),
    ),
    { headers: { 'content-type': 'text/event-stream' } },
  )
let pending = null,
  step = 0,
  marks = []
function claude(code) {
  const s = step++
  const tool = code !== null
  const block = tool
    ? [
        { type: 'tool_use', id: 't' + s, name: 'exec', input: {} },
        { type: 'input_json_delta', partial_json: JSON.stringify({ code }) },
      ]
    : [
        { type: 'text', text: '' },
        { type: 'text_delta', text: 'ok' },
      ]
  return sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'm' + s,
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block[0] }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: block[1] }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
}
const db = new DatabaseSync(':memory:')
const sql = {
  transaction(kind, operation, statements) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = statements.map(([q, ...v]) => {
        const st = db.prepare(q)
        st.setReturnArrays(true)
        return st.all(...v)
      })
      db.exec('COMMIT')
      return rows
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  },
}
const runtime = await AgentRuntime.instantiate(module, sql, { published() {} })
const shell = await Bash.create({ cwd: '/workspace' })
let current = null
await runtime.open(
  {
    scope: 's',
    session_id: Contracts.sessionUuid(),
    provider: 'claude',
    model: 'claude-haiku-5-5',
    subscription: false,
    endpoint: 'https://api.anthropic.com/v1/messages',
    event_coalesce_ms: 100,
    live_deltas: true,
    code_mode: true,
    workspace: shell.cwd,
    tools: [
      {
        name: 'lookup',
        description: 'Look up a key.',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      },
    ],
  },
  {
    workspace: shell.workspace(),
    fetch: async () => new Response('pong'),
    tools: { call: async (name, input) => ({ key: input.key, value: 1 }) },
    dispatch: async () => {
      marks.push(performance.now())
      const code = current
      current = null
      return claude(code)
    },
  },
)
let turn = 0
async function once(code) {
  marks = []
  current = code
  const id = 't' + turn++
  const t0 = performance.now()
  await runtime.submit('s', { request_id: id, prompt: 'go', metadata: {} })
  for (;;) {
    const next = (await runtime.pending('s'))[0]
    if (!next) break
    const d = await runtime.drive(next.report.request_id)
    if (d.waiting) await new Promise((r) => setTimeout(r, 1))
  }
  const report = (await runtime.turn('s', id))?.report
  if (report?.status !== 'completed') throw new Error(JSON.stringify(report).slice(0, 300))
  const t1 = performance.now()
  return { turn: t1 - t0, between: marks.length > 1 ? marks[1] - marks[0] : 0 }
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const p90 = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length * 0.9)]
}
for (let i = 0; i < 3; i++) await once(null)
const rows = []
const base = []
for (let i = 0; i < N; i++) base.push((await once(null)).turn)
rows.push({
  cell: '(no cell: one text turn)',
  turn_med: median(base),
  turn_p90: p90(base),
  cell_med: 0,
  cell_p90: 0,
})
for (const [name, code] of Object.entries(cells)) {
  await once(code)
  const t = [],
    c = []
  for (let i = 0; i < N; i++) {
    const r = await once(code)
    t.push(r.turn)
    c.push(r.between)
  }
  rows.push({
    cell: name,
    turn_med: median(t),
    turn_p90: p90(t),
    cell_med: median(c),
    cell_p90: p90(c),
  })
}
await runtime.dispose()
const pad = (s, n) => String(s).padEnd(n)
const out = [
  'Code Mode overhead, node ' +
    process.version +
    ' (nanocode-ts WASM module, mock model answering instantly), ' +
    N +
    ' runs each, ms',
  '',
  pad('cell', 26) + pad('turn med', 10) + pad('turn p90', 10) + pad('cell med', 10) + 'cell p90',
]
for (const r of rows)
  out.push(
    pad(r.cell, 26) +
      pad(r.turn_med.toFixed(2), 10) +
      pad(r.turn_p90.toFixed(2), 10) +
      pad(r.cell_med.toFixed(2), 10) +
      r.cell_p90.toFixed(2),
  )
out.push(
  '',
  'turn = submit to finished turn record (2 model calls with a cell, 1 without); cell = first model response to next model request (cell run plus result handling).',
)
mkdirSync('bench/out', { recursive: true })
writeFileSync('bench/out/overhead-node.txt', out.join('\n') + '\n')
console.log(out.join('\n'))

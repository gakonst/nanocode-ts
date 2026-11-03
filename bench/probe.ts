
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import * as Contracts from '../src/Contracts.ts'
import * as AgentRuntime from '../src/AgentRuntime.ts'
import * as Bash from '../src/bash/Bash.ts'
const [wasm, provider] = process.argv.slice(2)
const module = await WebAssembly.compile(readFileSync(wasm))
const db = new DatabaseSync(':memory:')
const sql = { transaction(kind, operation, statements) { db.exec('BEGIN IMMEDIATE'); try { const rows = statements.map(([q, ...v]) => { const st = db.prepare(q); st.setReturnArrays(true); return st.all(...v) }); db.exec('COMMIT'); return rows } catch (e) { db.exec('ROLLBACK'); throw e } } }
const runtime = await AgentRuntime.instantiate(module, sql, { published() {} })
const shell = await Bash.create({ cwd: '/workspace' })
let captured = null
await runtime.open({
  scope: 's', session_id: Contracts.sessionUuid(), provider,
  model: provider === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-luna',
  subscription: false,
  endpoint: provider === 'claude' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1',
  event_coalesce_ms: 100, live_deltas: true, workspace: shell.cwd, hands: true,
  environment: { cwd: '/workspace' },
}, {
  workspace: shell.workspace(), fetch: async () => new Response('x'),
  dispatch: async (request) => { captured ??= request; return new Response('{"error":{"type":"invalid_request_error","message":"probe"}}', { status: 400, headers: { 'content-type': 'application/json' } }) },
})
await runtime.submit('s', { request_id: 't', prompt: 'hi', metadata: {} })
for (let i = 0; i < 50 && !captured; i++) { const next = (await runtime.pending('s'))[0]; if (!next) break; await runtime.drive(next.report.request_id); await new Promise((r) => setTimeout(r, 5)) }
const body = JSON.parse(new TextDecoder().decode(captured.body))
const first = (body.input || [])[0]; const system = provider === "claude" ? (Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n---\n") : body.system) : JSON.stringify(first?.content ?? first).slice(0, 4000) + " ROLE=" + first?.role + " N=" + (body.input || []).length
const input = JSON.stringify(body.input ?? body.messages ?? '')
console.log(JSON.stringify({ provider, systemStart: String(system).slice(0, 160), systemLength: String(system).length, placementInSystem: String(system).includes('Code Mode scripts run on one machine'), placementInInput: input.includes('Code Mode scripts run on one machine') }))

const items = (body.input || []).map((item) => { const text = JSON.stringify(item.content ?? item); return { type: item.type, role: item.role, len: text.length, start: text.slice(0, 110), placement: text.includes('Code Mode scripts run on one machine') } })
console.log(JSON.stringify(items, null, 0))
await runtime.dispose()

import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as Path from 'node:path'

import * as AgentRuntime from '../../src/AgentRuntime.ts'
import * as Bash from '../../src/bash/Bash.ts'
import * as Contracts from '../../src/Contracts.ts'
import { marks } from './fixture-marks.ts'

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback
const now = () => process.hrtime.bigint()
const ms = (a: bigint | string, b: bigint | string) => Number(BigInt(a) - BigInt(b)) / 1e6

const root = Path.resolve(arg('out', 'output/bench/sla'))
const samples = Number(arg('samples', '10'))
const turns = Number(arg('turns', '3'))
const tokens = Number(arg('tokens', '200'))
const label = arg('label', 'ts-node')

const module = await WebAssembly.compile(Fs.readFileSync(process.env.NANOCODE_WASM_PATH ?? 'dist/nanocode_wasm.wasm'))

const fixture = ChildProcess.spawn(process.execPath, [Path.join(import.meta.dirname, 'fixture.ts')], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] })
const url: string = await new Promise((resolve) => fixture.stdout.once('data', (data: Buffer) => resolve('http://127.0.0.1:' + JSON.parse(data.toString()).port)))

function sql() {
  const db = new DatabaseSync(':memory:')
  return {
    transaction(_kind: string, _operation: string, statements: any[]) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const rows = statements.map(([query, ...values]: any[]) => {
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
}

const rows: any[] = []
for (let index = 0; index < samples; index++) {
  let watch: { at?: bigint; text: string } | undefined
  let dispatched: bigint | undefined
  const runtime = await AgentRuntime.instantiate(module, sql() as any, {
    live(events) {
      const at = now()
      if (watch && watch.at === undefined && JSON.stringify(events).includes(watch.text)) watch.at = at
    },
    published(events) {
      const at = now()
      if (watch && watch.at === undefined && JSON.stringify(events).includes(watch.text)) watch.at = at
    },
  })
  const shell = await Bash.create({ cwd: '/workspace' })
  await runtime.open(
    { endpoint: url + '/v1/messages', event_coalesce_ms: 0, live_deltas: true, model: 'claude-haiku-5-5', provider: 'claude', scope: 's', session_id: Contracts.sessionUuid(), subscription: false, workspace: shell.cwd } as any,
    {
      dispatch: (request: any, signal: AbortSignal) => (dispatched ??= now(), fetch)(url + '/v1/messages', { body: request.body, headers: request.headers, method: request.method, signal }),
      fetch: async () => new Response('pong'),
      workspace: shell.workspace(),
    } as any,
  )
  for (let turn = 1; turn <= turns; turn++) {
    const run = 'ts-' + index + '-' + turn + '-' + String(Math.random()).slice(2, 8)
    watch = { text: marks(turn).first }
    dispatched = undefined
    const id = 'r' + run
    const enter = now()
    await runtime.submit('s', { metadata: {}, prompt: 'Reply SLA[run=' + run + ',turn=' + turn + ',tokens=' + tokens + ',rate=0,ttft=0,tool=0]', request_id: id })
    for (;;) {
      const next = (await runtime.pending('s'))[0]
      if (!next) break
      const driven = await runtime.drive(next.report.request_id)
      if (driven.waiting) await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const entries = (await (await fetch(url + '/_log?run=' + run)).json()) as any[]
    const text = entries.find((entry) => entry.kind === 'text')
    const seen = watch.at
    rows.push({
      conn_new: text?.conn_new,
      dispatch: dispatched && ms(dispatched, enter),
      e2e: seen && ms(seen, enter),
      fetch_out: dispatched && text && ms(text.arrive_ns, dispatched),
      index,
      lane: 'ts-node',
      overhead: seen && text && ms(seen, enter) - ms(text.first_token_ns, text.arrive_ns),
      render: seen && text && ms(seen, text.first_token_ns),
      request_bytes: text?.request_bytes,
      request_out: text && ms(text.arrive_ns, enter),
      turn,
    })
  }
  await runtime.dispose()
}
fixture.kill()

const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1)]!
const metrics = ['e2e', 'dispatch', 'fetch_out', 'request_out', 'render', 'overhead', 'request_bytes']
const lines = ['# ' + label + ' (' + samples + ' samples, node ' + process.version + ', ' + new Date().toISOString() + ')', '', '| lane | turn | n | ' + metrics.map((m) => m + ' p50 / p99').join(' | ') + ' |', '|' + ' --- |'.repeat(metrics.length + 3)]
for (let turn = 1; turn <= turns; turn++) {
  const list = rows.filter((row) => row.turn === turn && typeof row.e2e === 'number')
  lines.push('| ts-node | ' + turn + ' | ' + list.length + ' | ' + metrics.map((metric) => {
    const values = list.map((row) => row[metric]).filter((value) => typeof value === 'number')
    return values.length ? pct(values, 50).toFixed(2) + ' / ' + pct(values, 99).toFixed(2) : '-'
  }).join(' | ') + ' |')
}
Fs.mkdirSync(root, { recursive: true })
Fs.writeFileSync(Path.join(root, label + '.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
Fs.appendFileSync(Path.join(root, 'REPORT.md'), lines.join('\n') + '\n\n')
console.log(lines.join('\n'))
process.exit(0)

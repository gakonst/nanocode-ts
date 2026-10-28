import {
  arg,
  stats,
  histogram,
  bytesHist,
  hand,
  handCpu,
  Session,
  median,
  p90,
  pad,
  f,
  report,
} from './handbench.ts'

const N = Number(arg('n', '10'))
const HAND = arg('hand', 'native')
const ONLY = arg('cells', '') ? arg('cells', '').split(',') : null
const LABEL = arg('label', HAND)

export const cells = {
  noop: 'text(1)',
  bash: "await tools.Bash({ command: 'true' }); text('ok')",
  'bash-seq-50': "for (let i = 0; i < 50; i++) await tools.Bash({ command: 'true' }); text('ok')",
  exec: "await tools.exec_command({ cmd: 'true' }); text('ok')",
  'exec-seq-50':
    "for (let i = 0; i < 50; i++) await tools.exec_command({ cmd: 'true' }); text('ok')",
  'exec-par-50':
    "await Promise.all(Array.from({ length: 50 }, () => tools.exec_command({ cmd: 'true' }))); text('ok')",
  'bash-par-50':
    "await Promise.all(Array.from({ length: 50 }, () => tools.Bash({ command: 'true' }))); text('ok')",
  'bash-par-timed':
    "const t = []; await Promise.all(Array.from({ length: 50 }, async () => { const s = Date.now(); await tools.Bash({ command: 'true' }); t.push(Date.now() - s); })); text(JSON.stringify(t.sort((a, b) => b - a).slice(0, 4)))",
  'mixed-par-100':
    "await Promise.all(Array.from({ length: 100 }, (_, i) => i % 2 ? tools.Bash({ command: 'echo ' + i }) : tools.exec_command({ cmd: 'echo ' + i }))); text('ok')",
  'bash-1m-out':
    'const r = await tools.Bash({ command: "head -c 1000000 /dev/zero | tr \'\\\\0\' x | wc -c" }); text(JSON.stringify(r).length)',
  'read-1m':
    "await tools.Write({ file_path: 'big.txt', content: ('x'.repeat(99) + '\\n').repeat(10000) }); const r = await tools.Read({ file_path: 'big.txt', limit: 10000 }); text(JSON.stringify(r).length)",
  'callback-seq-50':
    "for (let i = 0; i < 50; i++) await tools.lookup({ key: 'k' + i }); text('ok')",
  'callback-par-50':
    "await Promise.all(Array.from({ length: 50 }, (_, i) => tools.lookup({ key: 'k' + i }))); text('ok')",
  'callback-seq-500':
    "for (let i = 0; i < 500; i++) await tools.lookup({ key: 'k' + i }); text('ok')",
  'callback-par-500':
    "await Promise.all(Array.from({ length: 500 }, (_, i) => tools.lookup({ key: 'k' + i }))); text('ok')",
  'callback-1m-in': "await tools.lookup({ key: 'x'.repeat(1 << 20) }); text('ok')",
  'text-1m': "text('x'.repeat(1 << 20))",
  'text-6m': "text('x'.repeat(6 << 20))",
  'log-10k': "for (let i = 0; i < 10000; i++) console.log('line ' + i)",
  'log-100k': "for (let i = 0; i < 100000; i++) console.log('line ' + i)",
  'notify-1k': "for (let i = 0; i < 1000; i++) notify('n' + i); text('ok')",
  'timers-10k':
    "await Promise.all(Array.from({ length: 10000 }, () => new Promise(r => setTimeout(r, 0)))); text('ok')",
  'store-1m': "store('k', 'x'.repeat(1 << 20)); text(load('k').length)",
  compute: 'let s = 0; for (let i = 0; i < 1e7; i++) s += i; text(s)',
  'json-big':
    "const o = Array.from({ length: 100000 }, (_, i) => ({ i, s: 'v' + i })); text(JSON.parse(JSON.stringify(o)).length)",
  'string-concat': "let s = ''; for (let i = 0; i < 1e6; i++) s += 'x'; text(s.length)",
  regex: "const t = 'abc '.repeat(250000); text(t.replace(/b/g, 'B').match(/aBc/g).length)",
  recursion: 'const f = n => n === 0 ? 0 : 1 + f(n - 1); text(f(5000))',
  'alloc-50m':
    "const a = []; for (let i = 0; i < 1e6; i++) a.push({ i, t: 'x' + i }); text(a.length)",
  'source-200k': "const big = '" + 'y'.repeat(200000) + "'; text(big.length)",
}

const attached = await hand(HAND, arg('bin', process.env.NANOCODE_BIN ?? 'nanocode'))
const rows = []
for (const [cell, code] of Object.entries(cells)) {
  if (ONLY && !ONLY.includes(cell)) continue
  const session = await new Session(attached).open()
  try {
    await session.once('text(1)')
    await session.once(code)
  } catch (error) {
    rows.push({ cell, error: String(error.message ?? error).slice(0, 120) })
    await session.dispose()
    continue
  }
  const before = { ...stats }
  const hb = { ...histogram }
  const bb = { ...bytesHist }
  const t = [],
    c = []
  const brain0 = process.cpuUsage()
  const hand0 = handCpu(attached)
  for (let i = 0; i < N; i++) {
    const r = await session.once(code)
    t.push(r.turn)
    c.push(r.cell)
  }
  const brain1 = process.cpuUsage(brain0)
  const handMs = (handCpu(attached) - hand0) / N
  const per = (key) => (stats[key] - before[key]) / N
  if (process.env.HIST) {
    console.log(
      '== ' +
        cell +
        ' transactions/turn ' +
        ((stats.transactions - before.transactions) / N).toFixed(1),
    )
    for (const [k, v] of Object.entries(histogram)
      .map(([k, v]) => [k, (v - (hb[k] ?? 0)) / N])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]))
      console.log(
        '  ' +
          v.toFixed(1) +
          '  ' +
          ((bytesHist[k] - (bb[k] ?? 0)) / N / 1024).toFixed(1) +
          ' KB  ' +
          k,
      )
  }
  rows.push({
    cell,
    turn_med: median(t),
    turn_p90: p90(t),
    cell_med: median(c),
    cell_p90: p90(c),
    frames_in: per('frames_in'),
    kb_in: per('bytes_in') / 1024,
    frames_out: per('frames_out'),
    kb_out: per('bytes_out') / 1024,
    tx: per('transactions'),
    sql: per('statements'),
    sql_kb: per('bytes') / 1024,
    req_kb: per('request_bytes') / 1024,
    brain_cpu: (brain1.user + brain1.system) / 1000 / N,
    hand_cpu: handMs,
  })
  if (process.env.TOP) {
    for (const row of session.sql.db
      .prepare(
        'select substr(body, 1, 160) as head, length(body) as n from events order by length(body) desc limit 6',
      )
      .all())
      console.log(row.n, row.head)
    for (const row of session.sql.db
      .prepare('select body from events order by length(body) desc limit 1')
      .all()) {
      const e = JSON.parse(row.body).event
      const walk = (v, path) => {
        if (v && typeof v === 'object')
          for (const [k, x] of Object.entries(v)) {
            const n = JSON.stringify(x)?.length ?? 0
            if (n > 1000) {
              console.log('  ' + path + '.' + k, n)
              walk(x, path + '.' + k)
            }
          }
      }
      walk(e.payload, 'payload')
    }
  }
  await session.dispose()
}
attached.close()
const out = [
  'hand=' +
    HAND +
    ' node ' +
    process.version +
    ', WASM brain (nanocode-ts) on loopback, scripted Claude model, ' +
    N +
    ' runs, ms and per-turn counts',
  '',
  pad('cell', 18) +
    pad('turn med', 10) +
    pad('p90', 9) +
    pad('cell med', 10) +
    pad('p90', 9) +
    pad('in fr', 8) +
    pad('in KB', 9) +
    pad('out fr', 8) +
    pad('out KB', 9) +
    pad('tx', 7) +
    pad('sql', 7) +
    pad('sql KB', 9) +
    pad('req KB', 9) +
    pad('brain cpu', 11) +
    'hand cpu',
]
for (const r of rows)
  out.push(
    r.error
      ? pad(r.cell, 18) + 'error: ' + r.error
      : pad(r.cell, 18) +
          pad(f(r.turn_med), 10) +
          pad(f(r.turn_p90), 9) +
          pad(f(r.cell_med), 10) +
          pad(f(r.cell_p90), 9) +
          pad(f(r.frames_in), 8) +
          pad(f(r.kb_in), 9) +
          pad(f(r.frames_out), 8) +
          pad(f(r.kb_out), 9) +
          pad(f(r.tx), 7) +
          pad(f(r.sql), 7) +
          pad(f(r.sql_kb), 9) +
          pad(f(r.req_kb), 9) +
          pad(f(r.brain_cpu), 11) +
          f(r.hand_cpu),
  )
report('hands-' + LABEL, out)
process.exit(0)

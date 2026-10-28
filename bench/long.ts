import {
  arg,
  stats,
  hand,
  Session,
  median,
  pad,
  f,
  report,
  histogram,
  bytesHist,
} from './handbench.ts'

const HAND = arg('hand', 'local')
const LABEL = arg('label', HAND)
const attached = await hand(HAND, arg('bin', process.env.NANOCODE_BIN ?? 'nanocode'))
const out = []

const TURNS = Number(arg('turns', '300'))
const code = arg(
  'code',
  "for (let i = 0; i < 3; i++) await tools.Bash({ command: 'echo ' + i }); text('r'.repeat(2000))",
)
const session = await new Session(attached).open()
out.push(
  'long session, hand=' + HAND + ', ' + TURNS + ' turns of: ' + code,
  '',
  pad('turns', 12) +
    pad('turn med', 10) +
    pad('tx/turn', 9) +
    pad('sql/turn', 10) +
    pad('sql KB/turn', 13) +
    pad('req KB/turn', 13) +
    'db KB',
)
let window = [],
  before = { ...stats }
for (let i = 1; i <= TURNS; i++) {
  const r = await session.once(code)
  window.push(r.turn)
  if (i % 50 === 0 || i === 1 || i === 10) {
    const n = window.length
    const size = session.sql.db
      .prepare('select page_count * page_size as s from pragma_page_count(), pragma_page_size()')
      .get().s
    out.push(
      pad(i - n + 1 + '-' + i, 12) +
        pad(f(median(window)), 10) +
        pad(f((stats.transactions - before.transactions) / n), 9) +
        pad(f((stats.statements - before.statements) / n), 10) +
        pad(f((stats.bytes - before.bytes) / n / 1024), 13) +
        pad(f((stats.request_bytes - before.request_bytes) / n / 1024), 13) +
        (size / 1024).toFixed(0),
    )
    window = []
    before = { ...stats }
  }
}
if (process.env.HIST) {
  const h = { ...histogram },
    bh = { ...bytesHist }
  for (let i = 0; i < 10; i++) await session.once(code)
  for (const k of Object.keys(histogram).sort(
    (a, b) => bytesHist[b] - (bh[b] ?? 0) - (bytesHist[a] - (bh[a] ?? 0)),
  )) {
    const n = (histogram[k] - (h[k] ?? 0)) / 10
    if (n > 0)
      console.log(
        pad(n.toFixed(1), 6) +
          pad(((bytesHist[k] - (bh[k] ?? 0)) / 10 / 1024).toFixed(1) + ' KB', 11) +
          k,
      )
  }
}
await session.dispose()
const t0 = performance.now()
await session.open()
const opened = performance.now() - t0
const b = { ...stats }
const first = await session.once(code)
out.push(
  '',
  'reopen after ' +
    TURNS +
    ' turns: open ' +
    f(opened) +
    ' ms (' +
    (stats.statements - b.statements) +
    ' statements in first turn), first turn ' +
    f(first.turn) +
    ' ms, next ' +
    f((await session.once(code)).turn) +
    ' ms',
)
await session.dispose()

attached.close()
report('long-' + LABEL, out)
process.exit(0)

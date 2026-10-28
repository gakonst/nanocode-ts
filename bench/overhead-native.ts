import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'

const BIN = process.env.CODE_MODE_BIN ?? '../nanocodex/target/release/examples/code_mode'
const N = 50
const cells = {
  empty: 'text(1)',
  compute: 'let s = 0; for (let i = 0; i < 1e6; i++) s += i; text(s)',
  'host-tool': 'text(await tools.checked_sum({ a: 19, b: 23 }))',
  'host-tool-x10':
    'text((await Promise.all(Array.from({ length: 10 }, (_, i) => tools.checked_sum({ a: i, b: 1 })))).length)',
  'store-load': "store('k', { a: [1, 2, 3] }); text(JSON.stringify(load('k')))",
  'output-100k': "text('x'.repeat(100000))",
}
const time = (args) => {
  const t = process.hrtime.bigint()
  execFileSync(BIN, ['embedded', ...args], {
    stdio: ['ignore', 'ignore', 'inherit'],
    maxBuffer: 1 << 28,
  })
  return Number(process.hrtime.bigint() - t) / 1e6
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const pad = (s, n) => String(s).padEnd(n)
const out = [
  'Code Mode overhead, native Rust (SDK code_mode example, embedded cells, release build), ms',
  '',
  pad('cell', 16) + pad('per cell', 10) + 'process with 1 cell',
]
for (const [name, code] of Object.entries(cells)) {
  const one = median(Array.from({ length: 5 }, () => time([code])))
  const many = median(Array.from({ length: 3 }, () => time(Array(N).fill(code))))
  out.push(pad(name, 16) + pad(((many - one) / (N - 1)).toFixed(3), 10) + one.toFixed(1))
}
out.push(
  '',
  'per cell = (time for ' +
    N +
    ' cells - time for 1 cell) / ' +
    (N - 1) +
    ', so process start and runtime setup are excluded.',
)
mkdirSync('output/bench', { recursive: true })
writeFileSync('output/bench/overhead-native.txt', out.join('\n') + '\n')
console.log(out.join('\n'))

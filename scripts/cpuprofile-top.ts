import { readFileSync } from 'node:fs'

const profile = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const limit = Number(process.argv[3] ?? '40')
const byId = new Map(profile.nodes.map((node) => [node.id, node]))
const self = new Map()
const deltas = profile.timeDeltas
const counts = new Map()
profile.samples.forEach((id, index) => counts.set(id, (counts.get(id) ?? 0) + (deltas[index] ?? 0)))
let total = 0
for (const [id, time] of counts) {
  const node = byId.get(id)
  const frame = node.callFrame
  const key =
    (frame.functionName || '(anonymous)') +
    ' ' +
    (frame.url ? frame.url.split('/').slice(-2).join('/') : '')
  self.set(key, (self.get(key) ?? 0) + time)
  total += time
}
const parentOf = new Map()
for (const node of profile.nodes)
  for (const child of node.children ?? []) parentOf.set(child, node.id)
const buckets = new Map()
for (const [id, time] of counts) {
  let node = byId.get(id)
  let label = 'other'
  const name = node.callFrame.functionName
  const url = node.callFrame.url ?? ''
  if (url.startsWith('wasm://')) label = 'wasm'
  else if (name === '(garbage collector)') label = 'gc'
  else if (name === '(idle)' || name === '(program)') label = name
  else if (
    url.includes('node:sqlite') ||
    name.startsWith('prepare') ||
    name === 'all' ||
    name === 'exec'
  )
    label = 'sqlite'
  else if (url.includes('/src/')) label = 'host-ts'
  else if (url.startsWith('node:')) label = 'node'
  buckets.set(label, (buckets.get(label) ?? 0) + time)
}
console.log('total', (total / 1000).toFixed(0), 'ms')
for (const [label, time] of [...buckets].sort((a, b) => b[1] - a[1]))
  console.log(
    label.padEnd(12),
    (time / 1000).toFixed(0).padStart(7),
    'ms',
    ((100 * time) / total).toFixed(1) + '%',
  )
console.log('')
for (const [key, time] of [...self].sort((a, b) => b[1] - a[1]).slice(0, limit))
  console.log((time / 1000).toFixed(1).padStart(8), 'ms', key.slice(0, 150))

import { writeFileSync, mkdirSync } from 'node:fs'
import * as EventHub from '../src/EventHub.ts'

if (typeof globalThis.gc !== 'function')
  throw new Error('run with node --expose-gc scripts/measure-events.mjs')
const count = Number(process.env.EVENT_PAGE_SIZE ?? 128)
const budget = Number(process.env.EVENT_TAIL_BYTES ?? 4194304)
const sizes = (process.env.EVENT_SIZES ?? '300,4096,65536,1048576').split(',').map(Number)
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
const settle = async () => {
  for (let round = 0; round < 6; round++) {
    globalThis.gc()
    await tick()
  }
  return process.memoryUsage().heapUsed
}

function batch(first, size, total) {
  const text = JSON.stringify(
    Array.from({ length: total }, (_, index) => ({
      seq: first + index,
      request_id: 'turn',
      created_at: Date.now(),
      event: {
        source: 'agent',
        event: {
          protocol_version: 1,
          request_id: '01a15893-734d-70c1-984b-1ecaa64451c1',
          seq: first + index,
          type: 'tool.completed',
          payload: { output: String.fromCharCode(97 + (index % 26)).repeat(size) },
        },
        sdk_timing: { emitted_ns: 1, received_ns: 2, queue_ns: 1, source_received_ns: null },
      },
    })),
  )
  const events = JSON.parse(text)
  return { events, bytes: events.map((event) => JSON.stringify(event.event).length) }
}

function fill(size) {
  const hub = EventHub.create(
    () => count,
    () => budget,
  )
  for (let first = 1; first <= count; first += 16) {
    const { events, bytes } = batch(first, size, 16)
    hub.publish(events, bytes)
  }
  return hub
}

const rows = []
for (const size of sizes) {
  const before = await settle()
  const hub = fill(size)
  const after = await settle()
  const tail = hub['tail']
  rows.push({
    event_bytes: size,
    published: count,
    retained_events: tail.length,
    oldest_retained_seq: tail[0]?.seq ?? null,
    heap_retained_bytes: after - before,
    served_from_tail: hub.recent(count - 1) !== undefined,
    paged_from_log: hub.recent(0) === undefined,
  })
}
const report = {
  measured_at: new Date().toISOString(),
  node: process.version,
  event_page_size: count,
  event_tail_bytes: budget,
  rows,
}
mkdirSync('output', { recursive: true })
writeFileSync('output/events-measurement.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
const largest = rows.at(-1)
if (largest.heap_retained_bytes > 2 * budget) {
  console.log(
    `FAILED: a tail of ${largest.event_bytes}-byte events retained ${largest.heap_retained_bytes} bytes of heap, above twice EVENT_TAIL_BYTES`,
  )
  process.exitCode = 1
} else
  console.log(
    `ok: a tail of ${largest.event_bytes}-byte events retained ${largest.heap_retained_bytes} bytes of heap`,
  )

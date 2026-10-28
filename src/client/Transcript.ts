import type * as Files from '../internal/Files.ts'
import * as Format from './internal/Format.ts'
import * as ToolInput from './internal/ToolInput.ts'
import * as LiveEvent from './LiveEvent.ts'
import * as Tool from './Tool.ts'

export type Activity = {
  busy: boolean
  phase: ActivityPhase
  tool?: string
}

export type ActivityPhase = 'idle' | 'waiting' | 'thinking' | 'writing' | 'running'

export type Entry = {
  kind: EntryKind
  text: string
  tool?: Tool.Cell
  started_at?: number
  ended_at?: number
  steer?: boolean
  attachments?: Files.Attachment[]
}

export type EntryKind = 'assistant' | 'error' | 'reasoning' | 'tool' | 'user'

export type State = {
  running: Tool.Cell[]
  stream: Omit<Stream, 'shown'>
  links: [string, { cell: string; latest: string }][]
  orphans: [string, Tool.Cell[]][]
  ended?: string[]
  seen?: [number, string][]
  received?: [string, number][]
}

export type Transcript = {
  aside(entry: Entry): void
  close(): void
  pending(): boolean
  push(event: LiveEvent.LiveEvent): void
  reset(): void
  restore(state: State | undefined): void
  run(callback: () => void): void
  state(limit?: number): State
}

export type Turn = {
  id: string
  prompt: Entry | undefined
  blocks: TurnBlock[]
  live: boolean
  started_at?: number
  ended_at?: number
}

export type TurnBlock = Entry & {
  live: boolean
}

type Queued = { event: LiveEvent.LiveEvent } | { run: () => void } | { aside: Entry }

type Stream = {
  kind?: 'assistant' | 'reasoning'
  item?: unknown
  posted: number
  shown: number
  text: string
  started?: number
  ended?: number
}

const endedLimit = 1024

const outputLimit = 65_536

const receivedLimit = 256

const savedSeen = 256

const seenLimit = 4096

const toolEvents = new Set(['tool_input', 'tool_start', 'tool_output', 'tool_end'])

export function activity(live: readonly Entry[], options: activity.Options): Activity {
  if (!options.pending) return { busy: false, phase: 'idle' }
  const last = live[live.length - 1]
  if (last?.kind === 'reasoning') return { busy: true, phase: 'thinking' }
  if (last?.kind === 'assistant') return { busy: true, phase: 'writing' }
  if (last?.tool?.status === 'running')
    return { busy: true, phase: 'running', tool: last.tool.name }
  return { busy: true, phase: 'waiting' }
}

export declare namespace activity {
  type Options = {
    pending: boolean
  }
}

export function create(options: create.Options): Transcript {
  const calls = new Map<string, Tool.Cell>()
  const consumed = new Map<string, number>()
  const ended = new Set<string>()
  const inputs = new Map<string, ToolInput.ToolInput>()
  const links = new Map<string, { cell: string; latest: string }>()
  const orphans = new Map<string, Tool.Cell[]>()
  const received = new Map<string, number>()
  const seen = new Map<number, string>()
  let clock = 0
  let frame: ReturnType<typeof setTimeout> | undefined
  let held: Entry[] = []
  let queue: Queued[] = []
  let running: Tool.Cell[] = []
  let stream: Stream = { posted: 0, shown: 0, text: '' }
  let streaming: Entry | undefined

  const consume = (event: LiveEvent.LiveEvent) => {
    if (event.type === 'text' && event.item !== undefined && typeof event.through === 'number')
      remember(consumed, String(event.item), event.through)
  }

  const end = (status: Tool.Status) => {
    settle(status)
    orphans.clear()
    links.clear()
    options.end?.(status)
  }

  const enqueue = (item: Queued) => {
    queue.push(item)
    if (frame === undefined) frame = setTimeout(step)
  }

  const timing = (): Pick<Entry, 'started_at' | 'ended_at'> => {
    const { started, ended } = stream
    return {
      ...(started !== undefined ? { started_at: started } : {}),
      ...(ended !== undefined ? { ended_at: ended } : {}),
    }
  }

  const release = () => {
    for (const entry of held.splice(0)) options.add(entry)
  }

  const flush = () => {
    const { kind, posted, text } = stream
    if (kind === 'assistant')
      for (const chunk of Format.paragraphs(text, { final: true, from: posted }).chunks)
        options.add({ kind, text: chunk, ...timing() })
    else if (kind === 'reasoning' && text.trim())
      options.add({ kind, text: text.trim(), ...timing() })
    stream = { posted: 0, shown: 0, text: '' }
    streaming = undefined
    release()
  }

  const reveal = () => {
    const current = stream
    const visible = current.text.slice(0, current.shown)
    if (current.kind === 'assistant') {
      const { chunks, next } = Format.paragraphs(visible, { from: current.posted })
      current.posted = next
      for (const chunk of chunks) options.add({ kind: current.kind, text: chunk, ...timing() })
      if (chunks.length) release()
    }
    const rest = visible.slice(current.posted).trim()
    streaming =
      rest && current.kind
        ? {
            kind: current.kind,
            text: rest,
            ...(current.started !== undefined ? { started_at: current.started } : {}),
          }
        : undefined
  }

  const emit = () => {
    const entries: Entry[] = running.map((cell) => ({
      kind: 'tool',
      text: Tool.summary(cell),
      tool: structuredClone(cell),
      started_at: cell.started_at,
    }))
    if (streaming) entries.push(streaming)
    options.live(entries)
  }

  const resolve = (id: string) => links.get(id)?.latest ?? id

  const tool = (event: LiveEvent.LiveEvent) => {
    const id = resolve(String(event.call_id ?? ''))
    let cell = calls.get(id)
    if (!cell) {
      if (event.type === 'tool_output') return
      const parentId = typeof event.parent === 'string' ? resolve(event.parent) : undefined
      if (
        ended.has(id) ||
        (parentId !== undefined &&
          ended.has(parentId) &&
          !calls.has(parentId) &&
          !links.has(String(event.parent)))
      )
        return
      cell = Tool.create({
        callId: id,
        startedAt: LiveEvent.at(event),
        tool: typeof event.name === 'string' ? event.name : 'tool',
      })
      calls.set(id, cell)
      const parent = typeof event.parent === 'string' ? calls.get(resolve(event.parent)) : undefined
      if (parent) parent.children.push(cell)
      else running.push(cell)
    }
    if (event.type === 'tool_input') {
      let input = inputs.get(id)
      if (!input) inputs.set(id, (input = ToolInput.create()))
      const delta = typeof event.delta === 'string' ? event.delta : ''
      const have = input.raw.length
      const offset = typeof event.offset === 'number' ? event.offset : have
      if (offset + delta.length > have)
        input.push(offset >= have ? delta : delta.slice(have - offset))
      Tool.describe(cell, { args: input.arguments() })
    } else if (event.type === 'tool_start') {
      inputs.delete(id)
      Tool.describe(cell, { args: event.args })
      if (cell.tool === 'wait') {
        const args = Format.decode(event.args) as Record<string, unknown>
        const target =
          args && (typeof args.cell_id === 'string' || typeof args.cell_id === 'number')
            ? String(args.cell_id)
            : undefined
        for (const [origin, link] of links) {
          if (link.cell !== target) continue
          link.latest = id
          const carried = orphans.get(origin)
          orphans.delete(origin)
          if (carried)
            cell.children.push(...carried.filter((orphan) => !cell!.children.includes(orphan)))
        }
      }
    } else if (event.type === 'tool_output') {
      if (cell.status === 'running' && typeof event.text === 'string') {
        const output = cell.output
          ? cell.output + '\n' + Format.plain(event.text)
          : Format.plain(event.text)
        cell.output = output.length > outputLimit ? output.slice(-outputLimit) : output
      }
    } else {
      inputs.delete(id)
      Tool.finish(cell, { event })
      const origin = String(event.call_id ?? '')
      const yieldedCell =
        cell.status === 'yielded' ? /^cell (\S+)/.exec(cell.title)?.[1] : undefined
      if (yieldedCell !== undefined) links.set(origin, { cell: yieldedCell, latest: origin })
      else for (const [key, link] of links) if (link.latest === id && key !== id) links.delete(key)
    }
    settle()
  }

  const settle = (all?: Tool.Status) => {
    while (running.length && (all || running[0]!.status !== 'running')) {
      const cell = running.shift()!
      finalize(cell, all ?? cell.status)
      const posted = structuredClone(cell)
      if (cell.status === 'yielded') {
        const carried = cell.children.filter((child) => child.status === 'running')
        if (carried.length) orphans.set(cell.call_id, carried)
        for (const child of posted.children)
          if (child.status === 'running') finalize(child, 'yielded')
      }
      forget(cell)
      options.add({
        kind: 'tool',
        text: Tool.summary(posted),
        tool: posted,
        started_at: cell.started_at,
        ...(cell.duration_ms !== undefined ? { ended_at: cell.started_at + cell.duration_ms } : {}),
      })
    }
  }

  const forget = (cell: Tool.Cell) => {
    if (cell.status === 'running' && [...orphans.values()].some((cells) => cells.includes(cell)))
      return
    calls.delete(cell.call_id)
    inputs.delete(cell.call_id)
    ended.add(cell.call_id)
    if (ended.size > endedLimit) ended.delete(ended.values().next().value!)
    for (const child of cell.children) forget(child)
  }

  const step = () => {
    frame = undefined
    const now = performance.now()
    const elapsed = clock ? now - clock : 0
    clock = now
    const revealMs = options.revealMs ?? 30
    const instant = revealMs <= 0 || (options.reducedMotion?.() ?? false)
    let revealed = false
    for (;;) {
      const current = stream
      const next = queue[0]
      const event = next && 'event' in next ? next.event : undefined
      const kind =
        event?.type === 'text' ? 'assistant' : event?.type === 'reasoning' ? 'reasoning' : undefined
      const item = event?.item
      if (event && kind && (!current.kind || (current.kind === kind && current.item === item))) {
        queue.shift()
        current.kind = kind
        current.item = item
        current.text += typeof event.delta === 'string' ? event.delta : ''
        consume(event)
        current.started ??= LiveEvent.at(event)
        current.ended = LiveEvent.at(event)
        options.checkpoint?.(event)
        continue
      }
      if (
        event &&
        !kind &&
        !toolEvents.has(event.type) &&
        event.type !== 'turn' &&
        !describe(event, { limit: options.limit })
      ) {
        queue.shift()
        options.apply?.(event)
        options.checkpoint?.(event)
        continue
      }
      if (
        next &&
        'aside' in next &&
        current.kind === 'assistant' &&
        current.text.slice(current.posted).trim()
      ) {
        queue.shift()
        held.push(next.aside)
        continue
      }
      if (current.shown < current.text.length) {
        if (revealed) break
        revealed = true
        const backlog = current.text.length - current.shown
        current.shown += instant
          ? backlog
          : Math.max(1, Math.ceil(backlog * (1 - Math.exp(-elapsed / revealMs))))
        reveal()
        continue
      }
      if (!next) break
      queue.shift()
      flush()
      if ('run' in next) {
        next.run()
        continue
      }
      if ('aside' in next) {
        options.add(next.aside)
        continue
      }
      if (kind) {
        stream = {
          kind,
          item,
          posted: 0,
          shown: 0,
          text: typeof next.event.delta === 'string' ? next.event.delta : '',
          started: LiveEvent.at(next.event),
          ended: LiveEvent.at(next.event),
        }
        consume(next.event)
        options.checkpoint?.(next.event)
        continue
      }
      if (toolEvents.has(next.event.type)) {
        tool(next.event)
        options.checkpoint?.(next.event)
        continue
      }
      if (next.event.type === 'turn')
        end(next.event.status === 'completed' ? 'completed' : 'cancelled')
      const entry = describe(next.event, { limit: options.limit })
      if (entry) options.add(entry)
      options.apply?.(next.event)
      options.checkpoint?.(next.event)
    }
    emit()
    if (queue.length || stream.shown < stream.text.length)
      frame = setTimeout(step, options.frameMs ?? 16)
    else clock = 0
  }

  return {
    aside(entry) {
      enqueue({ aside: entry })
    },
    close() {
      enqueue({ run: () => end('cancelled') })
    },
    pending() {
      return queue.length > 0
    },
    push(event) {
      if (typeof event.seq === 'number') {
        const key = fingerprint(event)
        if (seen.get(event.seq) === key) return
        seen.delete(event.seq)
        seen.set(event.seq, key)
        if (seen.size > seenLimit) seen.delete(seen.keys().next().value!)
      }
      if (event.type === 'text' && event.item !== undefined) {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        const key = String(event.item)
        const have =
          received.get(key) ??
          (stream.kind === 'assistant' && stream.item === event.item ? stream.text.length : 0)
        const offset = typeof event.offset === 'number' ? event.offset : have
        const through = Math.max(have, offset + delta.length)
        remember(received, key, through)
        if (offset + delta.length <= have) return
        event = { ...event, delta: offset >= have ? delta : delta.slice(have - offset), through }
      }
      enqueue({ event })
    },
    reset() {
      if (frame !== undefined) clearTimeout(frame)
      frame = undefined
      queue = []
      stream = { posted: 0, shown: 0, text: '' }
      streaming = undefined
      running = []
      calls.clear()
      inputs.clear()
      links.clear()
      orphans.clear()
      ended.clear()
      seen.clear()
      received.clear()
      consumed.clear()
      held = []
      clock = 0
      options.live([])
    },
    restore(state) {
      if (!state || !Array.isArray(state.running)) return
      const index = (cell: Tool.Cell) => {
        calls.set(cell.call_id, cell)
        for (const child of cell.children) index(child)
      }
      running = state.running
      for (const cell of running) index(cell)
      for (const [key, cells] of state.orphans ?? []) {
        orphans.set(key, cells)
        for (const cell of cells) index(cell)
      }
      for (const [key, link] of state.links ?? []) links.set(key, link)
      for (const id of Array.isArray(state.ended) ? state.ended : []) ended.add(id)
      for (const [seq, key] of Array.isArray(state.seen) ? state.seen : []) seen.set(seq, key)
      for (const [key, length] of Array.isArray(state.received) ? state.received : []) {
        received.set(key, length)
        consumed.set(key, length)
      }
      if (state.stream && typeof state.stream.text === 'string') {
        stream = { ...state.stream, shown: state.stream.text.length }
        reveal()
      }
      emit()
    },
    run(callback) {
      enqueue({ run: callback })
    },
    state(limit = 65_536) {
      const clip = (cell: Tool.Cell) => Tool.clip(cell, { limit, tail: true })
      const { shown: _shown, ...saved } = stream
      return {
        running: running.map(clip),
        stream: saved,
        links: [...links],
        orphans: [...orphans].map(([key, cells]) => [key, cells.map(clip)]),
        ended: [...ended].slice(-256),
        seen: [...seen].slice(-savedSeen),
        received: [...consumed].slice(-savedSeen),
      }
    },
  }
}

export declare namespace create {
  type Options = {
    add(entry: Entry): void
    apply?(event: LiveEvent.LiveEvent): void
    checkpoint?(event: LiveEvent.LiveEvent): void
    end?(status: Tool.Status): void
    frameMs?: number | undefined
    limit?: number | undefined
    live(entries: Entry[]): void
    reducedMotion?(): boolean
    revealMs?: number | undefined
  }
}

export function describe(
  event: LiveEvent.LiveEvent,
  options: describe.Options = {},
): Entry | undefined {
  const { limit = 160 } = options
  const result = event.result as string | { text?: string } | undefined
  switch (event.type) {
    case 'tool_start':
      return { kind: 'tool', text: `${event.name} ${JSON.stringify(event.args)}` }
    case 'tool_end':
      return {
        kind: 'tool',
        text: `${event.name} ${event.status}: ${Format.clip(typeof result === 'string' ? result : (result?.text ?? ''), limit)}`,
      }
    case 'retrying':
      return {
        kind: 'tool',
        text: `Retrying: ${typeof event.error === 'string' ? event.error : JSON.stringify(event.error ?? event.message ?? '')}`,
      }
    case 'turn':
      return event.status === 'completed'
        ? undefined
        : event.status === 'cancelled'
          ? { kind: 'error', text: 'The turn was cancelled.' }
          : {
              kind: 'error',
              text: `The turn ${event.status}: ${JSON.stringify(event.error ?? '')}`,
            }
    case 'error':
      return {
        kind: 'error',
        text: typeof event.message === 'string' ? event.message : JSON.stringify(event),
      }
    case 'steered':
      return { kind: 'tool', text: 'steered into the running turn' }
    default:
      return undefined
  }
}

export declare namespace describe {
  type Options = {
    limit?: number | undefined
  }
}

export function turns(entries: readonly Entry[], options: turns.Options = {}): Turn[] {
  const { live = [], pending = false } = options
  const result: Turn[] = []
  const all = [
    ...entries.map((entry) => ({ entry, live: false })),
    ...live.map((entry) => ({ entry, live: true })),
  ]
  for (const [index, item] of all.entries()) {
    const entry = item.entry
    if (entry.kind === 'user' || !result.length)
      result.push({
        id: String(index),
        prompt: entry.kind === 'user' ? entry : undefined,
        blocks: [],
        live: false,
        ...(entry.started_at !== undefined ? { started_at: entry.started_at } : {}),
      })
    const turn = result[result.length - 1]!
    turn.live ||= item.live
    const ended = entry.ended_at ?? entry.started_at
    if (ended !== undefined && !item.live) turn.ended_at = ended
    if (entry.kind === 'user') continue
    const last = turn.blocks[turn.blocks.length - 1]
    if (
      last &&
      last.kind === entry.kind &&
      (entry.kind === 'assistant' || entry.kind === 'reasoning')
    ) {
      const merged: TurnBlock = {
        ...last,
        text: last.text + '\n\n' + entry.text,
        live: last.live || item.live,
      }
      if (entry.ended_at !== undefined && !item.live) merged.ended_at = entry.ended_at
      else delete merged.ended_at
      turn.blocks[turn.blocks.length - 1] = merged
    } else turn.blocks.push({ ...entry, live: item.live })
  }
  if (pending && result.length) result[result.length - 1]!.live = true
  for (const turn of result) if (turn.live) delete turn.ended_at
  return result
}

export declare namespace turns {
  type Options = {
    live?: readonly Entry[] | undefined
    pending?: boolean | undefined
  }
}

function fingerprint(event: LiveEvent.LiveEvent): string {
  return [
    event.type,
    event.call_id ?? event.item ?? '',
    typeof event.delta === 'string'
      ? event.delta.length
      : typeof event.text === 'string'
        ? event.text.length
        : '',
  ].join('|')
}

function finalize(cell: Tool.Cell, status: Tool.Status): void {
  if (cell.status === 'running') {
    cell.status = status
    cell.duration_ms ??= Date.now() - cell.started_at
  }
  for (const child of cell.children)
    finalize(
      child,
      status === 'yielded' ? 'running' : cell.status === 'yielded' ? 'completed' : cell.status,
    )
}

function remember(map: Map<string, number>, key: string, value: number): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > receivedLimit) map.delete(map.keys().next().value!)
}

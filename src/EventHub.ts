import type * as Contracts from './Contracts.ts'

type Event = Contracts.LoggedEvent & { [key: string]: unknown }

type Streamed = {
  key: string
  text: string
  offset: number | undefined
  final: boolean
  ends: boolean
}

type Stream = {
  event: Contracts.LoggedEvent
  request_id: string | null
  base: number
  text: string
  flushed: number
}

export type Cursor = { sent: Map<string, number>; cursor: number }

const STREAM_BYTES = 4_194_304

function streamed(event: Contracts.LoggedEvent): Streamed | undefined {
  const body = event.event as {
    source?: string
    type?: string
    event?: {
      type?: string
      payload?: { item_id?: unknown; call_id?: unknown; text?: unknown; offset?: unknown }
    }
  }
  if (body.source === undefined && body.type === 'result')
    return { key: '', text: '', offset: undefined, final: false, ends: true }
  if (body.source !== 'agent' || !body.event) return undefined
  const { type, payload = {} } = body.event
  if (type === 'run.completed' || type === 'run.failed')
    return { key: '', text: '', offset: undefined, final: false, ends: true }
  const id =
    type === 'assistant.delta' || type === 'assistant.message'
      ? payload.item_id
      : type === 'tool.input.delta' || type === 'tool.call'
        ? payload.call_id
        : undefined
  if (typeof id !== 'string' || type === undefined) return undefined
  const key = (type.startsWith('assistant') ? 'a:' : 't:') + id
  const final = type === 'assistant.message' || type === 'tool.call'
  return {
    key,
    text: typeof payload.text === 'string' ? payload.text : '',
    offset: typeof payload.offset === 'number' ? payload.offset : undefined,
    final,
    ends: false,
  }
}

function chunk(stream: Stream, from: number): Contracts.LoggedEvent {
  const body = stream.event.event as { event: { payload: Record<string, unknown> } }
  const text = stream.text.slice(from - stream.base)
  return {
    ...stream.event,
    event: {
      ...body,
      event: { ...body.event, payload: { ...body.event.payload, text, offset: from } },
    },
  }
}

export function create(retained: () => number, retainedBytes: () => number) {
  const state: {
    listeners: Set<() => void>
    revision: number
    highest: number
    tail: Contracts.LoggedEvent[]
    streams: Map<string, Stream>
    sizes: number[]
    bytes: number
    retained: () => number
    retainedBytes: () => number
  } = {
    listeners: new Set<() => void>(),
    revision: 0,
    highest: -1,
    tail: [],
    streams: new Map<string, Stream>(),
    sizes: [],
    bytes: 0,
    retained: undefined as unknown as () => number,
    retainedBytes: undefined as unknown as () => number,
  }
  state.retained = retained
  state.retainedBytes = retainedBytes
  const internal = {
    settle(event: Contracts.LoggedEvent): void {
      const found = streamed(event)
      if (!found) return
      if (found.ends) {
        for (const [key, stream] of state.streams)
          if (stream.request_id === (event.request_id ?? null)) state.streams.delete(key)
        return
      }
      if (found.final) {
        state.streams.delete(found.key)
        return
      }
      const stream = state.streams.get(found.key)
      if (!stream || found.offset === undefined) return
      const end = found.offset + found.text.length
      if (end > stream.base) {
        stream.text = stream.text.slice(Math.min(end - stream.base, stream.text.length))
        stream.base = end
      }
      stream.flushed = event.seq
    },
  }
  const self = {
    get version(): number {
      return state.revision
    },

    get latest(): number {
      return state.highest
    },

    notify(): void {
      state.revision++
      for (const resolve of [...state.listeners]) resolve()
    },

    publish(events: Contracts.LoggedEvent[], bytes: number[]): void {
      if (!events.length) return
      const first = events[0].seq
      const last = events[events.length - 1].seq
      if (state.highest < 0 || first === state.highest + 1) {
        const tail = [...state.tail, ...events]
        const sizes = [...state.sizes, ...bytes]
        let total = state.bytes + bytes.reduce((sum, size) => sum + size, 0)
        let start = Math.max(0, tail.length - state.retained())
        for (let index = 0; index < start; index++) total -= sizes[index]
        const budget = state.retainedBytes()
        while (start < tail.length && total > budget) total -= sizes[start++]
        state.tail = tail.slice(start)
        state.sizes = sizes.slice(start)
        state.bytes = total
      } else {
        state.tail = []
        state.sizes = []
        state.bytes = 0
      }
      state.highest = Math.max(state.highest, last)
      for (const event of events) internal.settle(event)
      self.notify()
    },

    live(events: Contracts.LoggedEvent[]): void {
      if (!events.length) return
      for (const event of events) {
        const found = streamed(event)
        if (!found || found.final || found.ends || found.offset === undefined) continue
        let stream = state.streams.get(found.key)
        if (!stream || found.offset > stream.base + stream.text.length) {
          stream = {
            event,
            request_id: event.request_id ?? null,
            base: found.offset,
            text: '',
            flushed: stream?.flushed ?? 0,
          }
          state.streams.set(found.key, stream)
        }
        const end = stream.base + stream.text.length
        if (found.offset + found.text.length > end)
          stream.text += found.text.slice(end - found.offset)
        stream.event = event
      }
      let bytes = 0
      for (const stream of state.streams.values()) bytes += stream.text.length
      for (const [key, stream] of state.streams) {
        if (bytes <= STREAM_BYTES) break
        bytes -= stream.text.length
        state.streams.delete(key)
      }
      self.notify()
    },

    chunks(cursor: Cursor, requestId?: string): Contracts.LoggedEvent[] {
      const out: Contracts.LoggedEvent[] = []
      for (const [key, stream] of state.streams) {
        if (requestId !== undefined && stream.request_id !== requestId) continue
        const sent = cursor.sent.get(key) ?? 0
        if (sent < stream.base && cursor.cursor < stream.flushed) continue
        const from = Math.max(sent, stream.base)
        if (from >= stream.base + stream.text.length) continue
        out.push(chunk(stream, from))
        cursor.sent.set(key, stream.base + stream.text.length)
      }
      return out
    },

    sent(cursor: Cursor, event: Contracts.LoggedEvent): void {
      cursor.cursor = Math.max(cursor.cursor, event.seq)
      const found = streamed(event)
      if (!found || found.ends) return
      if (found.final) cursor.sent.delete(found.key)
      else if (found.offset !== undefined)
        cursor.sent.set(
          found.key,
          Math.max(cursor.sent.get(found.key) ?? 0, found.offset + found.text.length),
        )
    },

    recent(after: number, requestId?: string): Contracts.LogPage | undefined {
      if (!state.tail.length || after < state.tail[0].seq - 1) return undefined
      const events = state.tail.filter(
        (event) => event.seq > after && (requestId === undefined || event.request_id === requestId),
      )
      return {
        events,
        next_cursor: Math.max(after, state.tail[state.tail.length - 1].seq),
        has_more: false,
      }
    },

    async wait(milliseconds: number, version = state.revision): Promise<void> {
      if (version !== state.revision) return
      let finish!: () => void
      const ready = new Promise<void>((resolve) => {
        finish = resolve
      })
      const timer = setTimeout(finish, milliseconds)
      state.listeners.add(finish)
      try {
        await ready
      } finally {
        clearTimeout(timer)
        state.listeners.delete(finish)
      }
    },

    stream(
      after: number,
      interval: number,
      read: (after: number) => Promise<Contracts.LogPage>,
      finished?: (event: Event) => boolean,
      options: { requestId?: string; live?: boolean } = {},
    ): Response {
      let cursor = after
      const live: Cursor = { sent: new Map(), cursor: after }
      let closed = false
      let complete = false
      let release: (() => void) | undefined
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            if (complete) {
              controller.close()
              closed = true
              return
            }
            while (!closed) {
              let timedOut = false
              let finish!: () => void
              const ready = new Promise<void>((resolve) => {
                finish = resolve
              })
              const timer = setTimeout(() => {
                timedOut = true
                finish()
              }, interval)
              release = () => {
                clearTimeout(timer)
                state.listeners.delete(finish)
                finish()
              }
              state.listeners.add(finish)
              const page = await read(cursor)
              if (closed) {
                release()
                release = undefined
                return
              }
              for (const event of page.events) self.sent(live, event)
              live.cursor = Math.max(live.cursor, page.next_cursor)
              const chunks = options.live ? self.chunks(live, options.requestId) : []
              if (page.events.length || chunks.length) {
                release()
                release = undefined
                cursor = page.next_cursor
                complete = !!finished && page.events.some((event) => finished(event as Event))
                const streamedAt = Date.now()
                controller.enqueue(
                  encoder.encode(
                    page.events
                      .map(
                        (event) =>
                          `id: ${event.seq}\ndata: ${JSON.stringify({ ...event, streamed_at: streamedAt })}\n\n`,
                      )
                      .join('') +
                      chunks
                        .map(
                          ({ seq: _, ...event }) =>
                            `event: live\ndata: ${JSON.stringify({ ...event, streamed_at: streamedAt })}\n\n`,
                        )
                        .join(''),
                  ),
                )
                return
              }
              cursor = page.next_cursor
              await ready
              release()
              release = undefined
              if (closed) return
              if (timedOut) {
                controller.enqueue(encoder.encode(': keepalive\n\n'))
                return
              }
            }
          } catch {
            release?.()
            release = undefined
            if (!closed) controller.error(new Error('event stream unavailable'))
            closed = true
          }
        },
        cancel: () => {
          closed = true
          release?.()
          release = undefined
        },
      })
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      })
    },
  }
  return self
}

export type EventHub = ReturnType<typeof create>

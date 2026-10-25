import type { LoggedEvent, LogPage } from "./contracts.ts";

type Event = LoggedEvent & { [key: string]: unknown };

type Streamed = { key: string; text: string; offset: number | undefined; final: boolean; ends: boolean };

type Stream = { event: LoggedEvent; request_id: string | null; base: number; text: string; flushed: number };

export type LiveCursor = { sent: Map<string, number>; cursor: number };

const STREAM_BYTES = 4_194_304;

function streamed(event: LoggedEvent): Streamed | undefined {
  const body = event.event as { source?: string; type?: string; event?: { type?: string; payload?: { item_id?: unknown; call_id?: unknown; text?: unknown; offset?: unknown } } };
  if (body.source === undefined && body.type === "result") return { key: "", text: "", offset: undefined, final: false, ends: true };
  if (body.source !== "agent" || !body.event) return undefined;
  const { type, payload = {} } = body.event;
  if (type === "run.completed" || type === "run.failed") return { key: "", text: "", offset: undefined, final: false, ends: true };
  const id = type === "assistant.delta" || type === "assistant.message" ? payload.item_id : type === "tool.input.delta" || type === "tool.call" ? payload.call_id : undefined;
  if (typeof id !== "string" || type === undefined) return undefined;
  const key = (type.startsWith("assistant") ? "a:" : "t:") + id;
  const final = type === "assistant.message" || type === "tool.call";
  return { key, text: typeof payload.text === "string" ? payload.text : "", offset: typeof payload.offset === "number" ? payload.offset : undefined, final, ends: false };
}

function chunk(stream: Stream, from: number): LoggedEvent {
  const body = stream.event.event as { event: { payload: Record<string, unknown> } };
  const text = stream.text.slice(from - stream.base);
  return { ...stream.event, event: { ...body, event: { ...body.event, payload: { ...body.event.payload, text, offset: from } } } };
}

export class EventHub {
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private highest = -1;
  private tail: LoggedEvent[] = [];
  private streams = new Map<string, Stream>();
  private sizes: number[] = [];
  private bytes = 0;
  private readonly retained: () => number;
  private readonly retainedBytes: () => number;

  constructor(retained: () => number, retainedBytes: () => number) {
    this.retained = retained;
    this.retainedBytes = retainedBytes;
  }

  get version(): number { return this.revision; }

  get latest(): number { return this.highest; }

  notify(): void {
    this.revision++;
    for (const resolve of [...this.listeners]) resolve();
  }

  publish(events: LoggedEvent[], bytes: number[]): void {
    if (!events.length) return;
    const first = events[0].seq;
    const last = events[events.length - 1].seq;
    if (this.highest < 0 || first === this.highest + 1) {
      const tail = [...this.tail, ...events];
      const sizes = [...this.sizes, ...bytes];
      let total = this.bytes + bytes.reduce((sum, size) => sum + size, 0);
      let start = Math.max(0, tail.length - this.retained());
      for (let index = 0; index < start; index++) total -= sizes[index];
      const budget = this.retainedBytes();
      while (start < tail.length && total > budget) total -= sizes[start++];
      this.tail = tail.slice(start);
      this.sizes = sizes.slice(start);
      this.bytes = total;
    } else {
      this.tail = [];
      this.sizes = [];
      this.bytes = 0;
    }
    this.highest = Math.max(this.highest, last);
    for (const event of events) this.settle(event);
    this.notify();
  }

  live(events: LoggedEvent[]): void {
    if (!events.length) return;
    for (const event of events) {
      const found = streamed(event);
      if (!found || found.final || found.ends || found.offset === undefined) continue;
      let stream = this.streams.get(found.key);
      if (!stream || found.offset > stream.base + stream.text.length) {
        stream = { event, request_id: event.request_id ?? null, base: found.offset, text: "", flushed: stream?.flushed ?? 0 };
        this.streams.set(found.key, stream);
      }
      const end = stream.base + stream.text.length;
      if (found.offset + found.text.length > end) stream.text += found.text.slice(end - found.offset);
      stream.event = event;
    }
    let bytes = 0;
    for (const stream of this.streams.values()) bytes += stream.text.length;
    for (const [key, stream] of this.streams) {
      if (bytes <= STREAM_BYTES) break;
      bytes -= stream.text.length;
      this.streams.delete(key);
    }
    this.notify();
  }

  chunks(state: LiveCursor, requestId?: string): LoggedEvent[] {
    const out: LoggedEvent[] = [];
    for (const [key, stream] of this.streams) {
      if (requestId !== undefined && stream.request_id !== requestId) continue;
      const sent = state.sent.get(key) ?? 0;
      if (sent < stream.base && state.cursor < stream.flushed) continue;
      const from = Math.max(sent, stream.base);
      if (from >= stream.base + stream.text.length) continue;
      out.push(chunk(stream, from));
      state.sent.set(key, stream.base + stream.text.length);
    }
    return out;
  }

  sent(state: LiveCursor, event: LoggedEvent): void {
    state.cursor = Math.max(state.cursor, event.seq);
    const found = streamed(event);
    if (!found || found.ends) return;
    if (found.final) state.sent.delete(found.key);
    else if (found.offset !== undefined) state.sent.set(found.key, Math.max(state.sent.get(found.key) ?? 0, found.offset + found.text.length));
  }

  private settle(event: LoggedEvent): void {
    const found = streamed(event);
    if (!found) return;
    if (found.ends) {
      for (const [key, stream] of this.streams) if (stream.request_id === (event.request_id ?? null)) this.streams.delete(key);
      return;
    }
    if (found.final) {
      this.streams.delete(found.key);
      return;
    }
    const stream = this.streams.get(found.key);
    if (!stream || found.offset === undefined) return;
    const end = found.offset + found.text.length;
    if (end > stream.base) {
      stream.text = stream.text.slice(Math.min(end - stream.base, stream.text.length));
      stream.base = end;
    }
    stream.flushed = event.seq;
  }

  recent(after: number, requestId?: string): LogPage | undefined {
    if (!this.tail.length || after < this.tail[0].seq - 1) return undefined;
    const events = this.tail.filter(event => event.seq > after && (requestId === undefined || event.request_id === requestId));
    return { events, next_cursor: Math.max(after, this.tail[this.tail.length - 1].seq), has_more: false };
  }

  async wait(milliseconds: number, version = this.revision): Promise<void> {
    if (version !== this.revision) return;
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });
    const timer = setTimeout(finish, milliseconds);
    this.listeners.add(finish);
    try { await ready; } finally { clearTimeout(timer); this.listeners.delete(finish); }
  }

  stream(after: number, interval: number, read: (after: number) => Promise<LogPage>, finished?: (event: Event) => boolean, options: { requestId?: string; live?: boolean } = {}): Response {
    let cursor = after;
    const live: LiveCursor = { sent: new Map(), cursor: after };
    let closed = false;
    let complete = false;
    let release: (() => void) | undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          if (complete) { controller.close(); closed = true; return; }
          while (!closed) {
            let timedOut = false;
            let finish!: () => void;
            const ready = new Promise<void>(resolve => { finish = resolve; });
            const timer = setTimeout(() => { timedOut = true; finish(); }, interval);
            release = () => { clearTimeout(timer); this.listeners.delete(finish); finish(); };
            this.listeners.add(finish);
            const page = await read(cursor);
            if (closed) { release(); release = undefined; return; }
            for (const event of page.events) this.sent(live, event);
            live.cursor = Math.max(live.cursor, page.next_cursor);
            const chunks = options.live ? this.chunks(live, options.requestId) : [];
            if (page.events.length || chunks.length) {
              release();
              release = undefined;
              cursor = page.next_cursor;
              complete = !!finished && page.events.some(event => finished(event as Event));
              const streamedAt = Date.now();
              controller.enqueue(encoder.encode(page.events.map(event => `id: ${event.seq}\ndata: ${JSON.stringify({ ...event, streamed_at: streamedAt })}\n\n`).join("") + chunks.map(({ seq: _, ...event }) => `event: live\ndata: ${JSON.stringify({ ...event, streamed_at: streamedAt })}\n\n`).join("")));
              return;
            }
            cursor = page.next_cursor;
            await ready;
            release();
            release = undefined;
            if (closed) return;
            if (timedOut) { controller.enqueue(encoder.encode(": keepalive\n\n")); return; }
          }
        } catch {
          release?.();
          release = undefined;
          if (!closed) controller.error(new Error("event stream unavailable"));
          closed = true;
        }
      },
      cancel: () => { closed = true; release?.(); release = undefined; },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }
}

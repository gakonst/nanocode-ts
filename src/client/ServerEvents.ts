/**
 * Server-sent events: reads a `text/event-stream` body into messages.
 *
 * @module
 */

/** One server-sent event. */
export type Event = {
  /** Event identifier, from the `id` field. */
  id?: string
  /** Event name. Defaults to `message`. */
  event: string
  /** Joined `data` lines. */
  data: string
}

/** Yields each event of a `text/event-stream` body, and releases the reader when it ends. */
export async function* parse(body: ReadableStream<Uint8Array>): AsyncGenerator<Event> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const block = buffered.slice(0, end)
        buffered = buffered.slice(end + 2)
        const message: Event = { event: 'message', data: '' }
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) message.id = line.slice(3).trim()
          else if (line.startsWith('event:')) message.event = line.slice(6).trim()
          else if (line.startsWith('data:')) message.data += line.slice(5).trim()
        }
        yield message
      }
    }
  } finally {
    reader.releaseLock()
  }
}

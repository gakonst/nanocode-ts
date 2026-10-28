/**
 * Integration suite for the server-sent event reader.
 *
 * @module
 */
import { describe, expect, test } from 'vite-plus/test'
import * as ServerEvents from './ServerEvents.ts'

describe('parse', () => {
  test('reads events across chunk boundaries', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'id: 1\nevent: turn\nda',
      'ta: {"a":1}\n\n',
      'data: two\n\nid: 3\n',
      'data: three\n\n',
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })

    const events: ServerEvents.Event[] = []
    for await (const event of ServerEvents.parse(body)) events.push(event)

    expect(events).toMatchInlineSnapshot(`
      [
        {
          "data": "{"a":1}",
          "event": "turn",
          "id": "1",
        },
        {
          "data": "two",
          "event": "message",
        },
        {
          "data": "three",
          "event": "message",
          "id": "3",
        },
      ]
    `)
    expect(body.locked).toMatchInlineSnapshot(`false`)
  })
})

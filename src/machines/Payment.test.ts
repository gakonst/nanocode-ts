/**
 * Integration suite for the payment policy and the receipt events of paid streams.
 *
 * @module
 */
import { describe, expect, test } from 'vite-plus/test'
import * as Payment from './Payment.ts'

describe('resolve', () => {
  test('applies the defaults', () => {
    expect(Payment.resolve()).toMatchInlineSnapshot(`
      {
        "inference": "tempo",
        "servers": [
          {
            "name": "mercator",
            "url": "https://mercator.sh/mcp",
          },
          {
            "name": "gateway",
            "url": "https://gateway.tempo-dev.workers.dev/mcp",
          },
        ],
        "tools": "tempo",
      }
    `)
  })

  test('drops the servers when tools are off', () => {
    expect(Payment.resolve({ inference: 'apiKey', tools: 'off' })).toMatchInlineSnapshot(`
      {
        "inference": "apiKey",
        "servers": [],
        "tools": "off",
      }
    `)
  })
})

describe('receipts', () => {
  test('removes receipt events and passes their data', async () => {
    const encoder = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: one\n\nevent: payment-receipt\ndata: {"spent":"5"}'),
        )
        controller.enqueue(encoder.encode('\n\ndata: two\n\n'))
        controller.close()
      },
    })
    const received: string[] = []

    const text = await new Response(Payment.receipts(source, (data) => received.push(data))).text()

    expect(text).toMatchInlineSnapshot(`
      "data: one

      data: two

      "
    `)
    expect(received).toMatchInlineSnapshot(`
      [
        "{"spent":"5"}",
      ]
    `)
  })
})

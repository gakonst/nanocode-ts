/**
 * Integration suite for the WebAssembly agent runtime over a real SQLite host.
 *
 * @module
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import * as Agent from '../test/Agent.ts'
import { sessionUuid } from './contracts.ts'

let directory: string
let module: WebAssembly.Module

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocode-runtime-'))
  module = await Agent.compile()
})

afterAll(() => {
  fs.rmSync(directory, { force: true, recursive: true })
})

describe('instantiate', () => {
  for (const provider of ['claude', 'codex'] as const)
    test(`runs host tool turns and replays them after reopening (${provider})`, async () => {
      const database = path.join(directory, `${provider}.sqlite`)
      const requests: Agent.Request[] = []
      const sessionId = sessionUuid()

      const first = await Agent.open({ database, module, provider, requests, sessionId })
      expect(await Agent.turn(first.runtime, 'turn-1')).toMatchInlineSnapshot(`"completed"`)
      expect(await Agent.turn(first.runtime, 'turn-2')).toMatchInlineSnapshot(`"completed"`)
      const logged = first.events.length
      await first.runtime.dispose()
      first.store.close()

      const second = await Agent.open({ database, module, provider, requests, sessionId })
      const replayed = await second.runtime.page(Agent.scope, 0, 1000)
      expect(replayed.events.length).toBeGreaterThanOrEqual(logged)
      expect(await Agent.turn(second.runtime, 'turn-3')).toMatchInlineSnapshot(`"completed"`)

      const inputs = new Map<string, string>()
      for (const entry of replayed.events) {
        const event = (entry.event as { event?: { payload: Record<string, string>; type: string } })
          .event
        if (event?.type !== 'tool.input.delta') continue
        const payload = event.payload as { call_id: string; text: string; tool: string }
        inputs.set(payload.call_id, (inputs.get(payload.call_id) ?? '') + payload.text)
      }
      expect([...inputs.values()]).toMatchInlineSnapshot(`
        [
          "{"key":"alpha"}",
          "{"key":"alpha"}",
        ]
      `)

      expect(requests.length).toMatchInlineSnapshot(`6`)
      expect(requests.every((request) => request.credentialFree)).toMatchInlineSnapshot(`true`)
      expect(requests.every((request) => request.tools.includes(Agent.lookup.name))).toMatchInlineSnapshot(
        `true`,
      )
      expect(requests.at(-1)!.messages > requests[0]!.messages).toMatchInlineSnapshot(`true`)

      await second.runtime.dispose()
      second.store.close()
    })
})

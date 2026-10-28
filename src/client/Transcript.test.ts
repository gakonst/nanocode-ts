/**
 * Integration suite for the browser transcript over events that a real session logs.
 *
 * @module
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, test } from 'vite-plus/test'
import * as Agent from '../../test/Agent.ts'
import * as Contracts from '../Contracts.ts'
import * as LiveEvent from './LiveEvent.ts'
import * as Transcript from './Transcript.ts'

describe('Transcript', () => {
  for (const provider of ['claude', 'codex'] as const)
    test(`folds a logged turn into entries (${provider})`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocode-transcript-'))
      const module = await Agent.compile()
      const session = await Agent.open({
        database: path.join(directory, 'session.sqlite'),
        module,
        provider,
        requests: [],
        sessionId: Contracts.sessionUuid(),
      })
      await Agent.turn(session.runtime, 'turn-1')
      const logged = await session.runtime.page(Agent.scope, 0, 1000)

      const entries: Transcript.Entry[] = []
      const transcript = Transcript.create({
        add: (entry) => entries.push(entry),
        live: () => {},
        revealMs: 0,
      })
      for (const event of logged.events) {
        const live = LiveEvent.fromLogged(event)
        if (live) transcript.push(live)
      }
      await expect.poll(() => transcript.pending()).toBe(false)

      expect(entries.map(shape)).toMatchInlineSnapshot(`
        [
          {
            "kind": "tool",
            "text": "lookup alpha · <duration>",
            "tool": {
              "input": "",
              "name": "lookup",
              "status": "completed",
              "title": "alpha",
            },
          },
          {
            "kind": "assistant",
            "text": "the value is bravo",
          },
        ]
      `)
      expect(
        Transcript.turns(entries, { live: [], pending: false }).map((turn) =>
          turn.blocks.map((block) => block.kind),
        ),
      ).toMatchInlineSnapshot(`
        [
          [
            "tool",
            "assistant",
          ],
        ]
      `)

      await session.runtime.dispose()
      session.store.close()
      fs.rmSync(directory, { force: true, recursive: true })
    })
})

/** Drops identifiers, timestamps, and durations, which differ between runs. */
function shape(entry: Transcript.Entry) {
  const tool = entry.tool
  return {
    kind: entry.kind,
    text: entry.text.replace(/\d+ ms$/, '<duration>'),
    ...(tool
      ? { tool: { input: tool.input, name: tool.name, status: tool.status, title: tool.title } }
      : {}),
  }
}

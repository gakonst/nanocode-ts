/**
 * Integration suite for the SQL journal, the harness that writes it, and the reader that replays it, on a local Workflow world.
 *
 * @module
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { durableSessions, type DurableSessions, getWorld, type HostTool } from 'durable-harness'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import * as Agent from '../../test/Agent.ts'
import * as Harness from './Harness.ts'
import * as Journal from './Journal.ts'
import * as Reader from './Reader.ts'

const lookup: HostTool = {
  description: Agent.lookup.description,
  execute: async () => JSON.stringify({ key: 'alpha', value: 'bravo' }),
  inputSchema: Agent.lookup.parameters,
  name: Agent.lookup.name,
  replay: 'safe',
}

let directory: string
let module: WebAssembly.Module
let sessions: DurableSessions
const reports: Harness.DriveReport[] = []

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocode-journal-'))
  process.env.WORKFLOW_TARGET_WORLD = 'local'
  process.env.WORKFLOW_LOCAL_DATA_DIR = directory
  module = await Agent.compile()

  sessions = durableSessions({
    harness: Harness.create({
      dispatch: async (request) => Agent.claude(JSON.parse(new TextDecoder().decode(request.body))),
      durability: 'strict',
      endpoint: 'https://api.anthropic.com/v1/messages',
      module: async () => module,
      report: (report) => reports.push(report),
      tools: [lookup],
      workspace: false,
    }),
    world: await getWorld(),
  })
})

afterAll(() => {
  fs.rmSync(directory, { force: true, recursive: true })
})

describe('committed', () => {
  test('returns the batches that a drive committed, and the reader replays them', async () => {
    const { sessionId } = await sessions.start()
    const submission = await sessions.send(sessionId, 'Look up alpha', 'prompt', {
      wake: 'backstop',
    })
    await sessions.drive(sessionId)

    const state = await sessions.inspect(sessionId)
    const batches = Journal.committed(state)
    expect(batches.length > 0).toMatchInlineSnapshot(`true`)
    expect(state.effects.get(Journal.batchKey(0))?.name).toMatchInlineSnapshot(`"nanocode.sql"`)
    expect(Harness.isIdle(state, { batches: batches.length })).toMatchInlineSnapshot(`true`)

    const reader = await Reader.open(state, { module: async () => module })
    const turn = await reader.turn(submission)
    expect(turn?.report.status).toMatchInlineSnapshot(`"completed"`)
    expect(JSON.stringify(turn).includes('the value is bravo')).toMatchInlineSnapshot(`true`)
    await reader.close()
  })
})

describe('create', () => {
  test('replays the committed batches before the next turn of a session', async () => {
    const { sessionId } = await sessions.start()
    await sessions.send(sessionId, 'Look up alpha', 'prompt', { wake: 'backstop' })
    await sessions.drive(sessionId)
    const first = Journal.committed(await sessions.inspect(sessionId)).length

    await sessions.send(sessionId, 'Look up alpha again', 'prompt', { wake: 'backstop' })
    await sessions.drive(sessionId)

    const report = reports.filter((entry) => entry.run_id === sessionId).at(-1)!
    expect(report.outcome).toMatchInlineSnapshot(`"settled"`)
    expect(report.journal.replayed_batches === first).toMatchInlineSnapshot(`true`)
    expect(report.journal.batches > 0).toMatchInlineSnapshot(`true`)
    const total = Journal.committed(await sessions.inspect(sessionId)).length
    expect(total === first + report.journal.batches).toMatchInlineSnapshot(`true`)
  })
})

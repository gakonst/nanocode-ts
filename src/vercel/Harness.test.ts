/**
 * Integration suite for sessions that run on a ChatGPT or Claude plan through `Harness.create`'s `subscription`.
 *
 * @module
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { durableSessions, type DurableSessions, getWorld } from 'durable-harness'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import * as Agent from '../../test/Agent.ts'
import * as Harness from './Harness.ts'

let directory: string
let sessions: DurableSessions
const gateway: string[] = []
const plan: string[] = []
const asked: { account: string; provider: string }[] = []

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocode-plan-'))
  process.env.WORKFLOW_TARGET_WORLD = 'local'
  process.env.WORKFLOW_LOCAL_DATA_DIR = directory
  const module = await Agent.compile()

  sessions = durableSessions({
    harness: Harness.create({
      dispatch: async (request) => {
        gateway.push(request.endpoint)
        return Agent.claude(JSON.parse(new TextDecoder().decode(request.body)))
      },
      durability: 'strict',
      endpoint: 'https://api.anthropic.com/v1/messages',
      module: async () => module,
      subscription: (session) => {
        asked.push({ account: session.account, provider: session.provider })
        if (session.account !== 'signed-in') return undefined
        return {
          dispatch: async (request) => {
            plan.push(request.endpoint)
            return Agent.claude(JSON.parse(new TextDecoder().decode(request.body)))
          },
        }
      },
      workspace: false,
    }),
    world: await getWorld(),
  })
})

afterAll(() => {
  fs.rmSync(directory, { force: true, recursive: true })
})

describe('subscription', () => {
  test('sends the model requests of a signed-in account to its plan endpoint', async () => {
    const { sessionId } = await sessions.start({ config: { account: 'signed-in' } })
    await sessions.send(sessionId, 'Say hi', 'prompt', { wake: 'backstop' })
    await sessions.drive(sessionId)

    expect(asked.at(-1)).toMatchInlineSnapshot(`
      {
        "account": "signed-in",
        "provider": "claude",
      }
    `)
    expect(plan.length > 0).toMatchInlineSnapshot(`true`)
    expect(new Set(plan)).toMatchInlineSnapshot(`
      Set {
        "https://api.anthropic.com/v1/messages?beta=true",
      }
    `)
    expect(gateway.length).toMatchInlineSnapshot(`0`)
  })

  test('keeps the gateway for an account without a plan and for a session without an account', async () => {
    const before = plan.length
    for (const config of [{ account: 'signed-out' }, {}]) {
      const { sessionId } = await sessions.start({ config })
      await sessions.send(sessionId, 'Say hi', 'prompt', { wake: 'backstop' })
      await sessions.drive(sessionId)
    }

    expect(plan.length - before).toMatchInlineSnapshot(`0`)
    expect(new Set(gateway)).toMatchInlineSnapshot(`
      Set {
        "https://api.anthropic.com/v1/messages",
      }
    `)
    expect(asked.map((entry) => entry.account)).toMatchInlineSnapshot(`
      [
        "signed-in",
        "signed-out",
      ]
    `)
  })
})

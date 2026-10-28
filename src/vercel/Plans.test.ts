/**
 * Integration suite for plans on Vercel: the sign-in routes of an account and its subscription.
 *
 * @module
 */
import { Store } from 'nanocode-egress'
import { describe, expect, test } from 'vite-plus/test'
import * as Plans from './Plans.ts'

const secret = 'plan-secret-plan-secret-plan-secret'

describe('create', () => {
  test('serves the routes of the account that signed the request', async () => {
    const plans = Plans.create({ store: Store.memory(), secret }, (request) =>
      request.headers.get('x-account'),
    )
    const status = await plans.routes.GET(
      new Request('https://app.example/api/plans', { headers: { 'x-account': 'visitor-1' } }),
    )

    expect(status.status).toMatchInlineSnapshot(`200`)
    expect(await status.json()).toMatchInlineSnapshot(`
      {
        "claude": {
          "state": "signed_out",
        },
        "codex": {
          "state": "signed_out",
        },
      }
    `)
    expect(
      (await plans.routes.GET(new Request('https://app.example/api/plans'))).status,
    ).toMatchInlineSnapshot(`401`)
    expect(
      (await plans.routes.GET(new Request('https://app.example/api/other'))).status,
    ).toMatchInlineSnapshot(`404`)
    expect(
      await plans.subscription({ account: 'visitor-1', provider: 'claude' }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('needs an account', () => {
    expect(() =>
      Plans.create({ store: Store.memory(), secret }, undefined),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: plans need an account: pass App.create an account, or plans one]`,
    )
  })
})

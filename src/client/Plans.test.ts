/**
 * Integration suite for the plan client: its requests to the plan routes and its errors.
 *
 * @module
 */
import { models } from 'nanocode-ts/models'
import { describe, expect, test } from 'vite-plus/test'
import * as Plans from './Plans.ts'

function routes() {
  const requests: string[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    requests.push(
      [init?.method ?? 'GET', String(input), headers.get('x-visitor'), init?.body ?? '']
        .join(' ')
        .trim(),
    )
    const path = new URL(String(input)).pathname
    if (path === '/plans/claude/complete')
      return Response.json({ error: 'invalid code' }, { status: 400 })
    if (path === '/plans/codex/sign-in')
      return Response.json({
        provider: 'codex',
        status: {
          state: 'pending',
          user_code: 'ABCD-1234',
          verification_url: 'https://auth.openai.com/codex/device',
          expires_at: 1,
          poll_after_ms: 5000,
        },
      })
    if (path === '/plans/codex') return Response.json({ ok: true })
    return Response.json({ claude: { state: 'signed_out' }, codex: { state: 'signed_out' } })
  }) as typeof globalThis.fetch
  return { requests, fetch }
}

describe('create', () => {
  test('sends the plan routes with the visitor headers', async () => {
    const server = routes()
    const client = Plans.create({
      url: 'https://app.example/plans/',
      headers: () => ({ 'x-visitor': 'v1' }),
      fetch: server.fetch,
    })

    expect(await client.status()).toMatchInlineSnapshot(`
      {
        "claude": {
          "state": "signed_out",
        },
        "codex": {
          "state": "signed_out",
        },
      }
    `)
    expect((await client.signIn('codex')).provider).toMatchInlineSnapshot(`"codex"`)
    await client.signOut('codex')
    expect(server.requests).toMatchInlineSnapshot(`
      [
        "GET https://app.example/plans v1",
        "POST https://app.example/plans/codex/sign-in v1 {}",
        "DELETE https://app.example/plans/codex v1",
      ]
    `)
  })

  test('throws the error that a route answers', async () => {
    const client = Plans.create({ url: 'https://app.example/plans', fetch: routes().fetch })

    await expect(client.complete('wrong#state')).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: invalid code]`,
    )
  })
})

describe('serves', () => {
  test('serves the models of the catalog that the provider’s own API serves', () => {
    expect(
      models.harnesses.flatMap((harness) =>
        harness.models
          .filter(
            (model) => Plans.serves(harness.id, model.id) !== model.gateways.includes('direct'),
          )
          .map((model) => model.id),
      ),
    ).toMatchInlineSnapshot(`[]`)
  })

  test('serves the provider’s own models', () => {
    expect(
      [
        ['claude', 'claude-haiku-5-5'],
        ['claude', 'zai/glm-5.3'],
        ['codex', 'gpt-6-luna'],
        ['codex', 'glm-5.3'],
        ['codex', 'kimi-k3'],
        ['codex', undefined],
      ].map(([provider, model]) => Plans.serves(provider as Plans.Provider, model)),
    ).toMatchInlineSnapshot(`
      [
        true,
        false,
        true,
        false,
        false,
        true,
      ]
    `)
  })
})

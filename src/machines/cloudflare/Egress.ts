import type * as App from '../../cloudflare/App.ts'
import { json } from '../Account.ts'
import * as Env from './Env.ts'

export const proxies: Record<string, string> = {
  'api.openai.com': 'https://openai.mpp.tempo.xyz',
  'api.anthropic.com': 'https://anthropic.mpp.tempo.xyz',
}

const forwardedHeaders = /^(accept|content-type|anthropic-version|anthropic-beta)$/

function modelError(provider: string | undefined, status: number, message: string): Response {
  if (provider === 'codex')
    return json({ error: { type: 'invalid_request_error', message } }, status)
  return json({ type: 'error', error: { type: 'invalid_request_error', message } }, status)
}

async function model(env: Env.Env, request: Request): Promise<Response> {
  let dispatch: App.ModelDispatch
  try {
    dispatch = JSON.parse(request.headers.get('x-nanocode-model') ?? '')
  } catch {
    return modelError(undefined, 400, 'invalid model dispatch')
  }
  if (dispatch.subscription)
    return modelError(
      dispatch.provider,
      409,
      'nanocode machines pays by the token over MPP; subscriptions are not used',
    )
  const upstream = new URL(dispatch.endpoint)
  const proxy = proxies[upstream.hostname]
  if (!proxy) return modelError(dispatch.provider, 400, `no MPP proxy for ${upstream.hostname}`)
  const headers: [string, string][] = dispatch.headers.filter(([name]) =>
    forwardedHeaders.test(name.toLowerCase()),
  )
  const body = await request.arrayBuffer()
  return Env.wallet(env, { account: dispatch.authority.account_id }).fetch(
    new Request('https://wallet.internal/model', {
      method: 'POST',
      body,
      signal: request.signal,
      headers: {
        'x-target': proxy + upstream.pathname + upstream.search,
        'x-headers': JSON.stringify(headers),
        'x-session': dispatch.authority.session_id,
      },
    }),
  )
}

async function warm(env: Env.Env, request: Request): Promise<Response> {
  let dispatch: Pick<App.ModelDispatch, 'authority'>
  try {
    dispatch = JSON.parse(request.headers.get('x-nanocode-model') ?? '')
  } catch {
    return modelError(undefined, 400, 'invalid model dispatch')
  }
  await Env.wallet(env, { account: dispatch.authority.account_id }).warm()
  return new Response(null, { status: 204 })
}

export function paid(request: Request): boolean {
  const header = request.headers.get('x-nanocode-model') ?? request.headers.get('x-nanocode-socket')
  try {
    return (JSON.parse(header ?? 'null') as { payer?: unknown } | null)?.payer === 'wallet'
  } catch {
    return false
  }
}

export function create(env: Env.Env): App.PrivateBinding {
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url)
      if (pathname === '/model' && request.method === 'POST') return model(env, request)
      if (pathname === '/warm' && request.method === 'POST') return warm(env, request)
      if (pathname === '/socket')
        return json(
          {
            error: {
              type: 'invalid_request_error',
              message: 'nanocode machines pays for models over HTTPS only',
            },
          },
          426,
        )
      if (pathname === '/remote')
        return json(
          { error: 'this deployment has no remote executors; attach a hand instead' },
          501,
        )
      if (pathname === '/metrics') return json({ ok: true, egress: 'mpp' })
      return json({ error: 'not_found' }, 404)
    },
  }
}

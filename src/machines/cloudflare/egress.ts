import type { ModelDispatch, PrivateBinding } from '../../cloudflare/contracts.ts'
import { json, type MachinesEnv, wallet } from './env.ts'

export const PROXIES: Record<string, string> = {
  'api.openai.com': 'https://openai.mpp.tempo.xyz',
  'api.anthropic.com': 'https://anthropic.mpp.tempo.xyz',
}

const HEADERS = /^(accept|content-type|anthropic-version|anthropic-beta)$/

function modelError(provider: string | undefined, status: number, message: string): Response {
  if (provider === 'codex')
    return json({ error: { type: 'invalid_request_error', message } }, status)
  return json({ type: 'error', error: { type: 'invalid_request_error', message } }, status)
}

async function model(env: MachinesEnv, request: Request): Promise<Response> {
  let dispatch: ModelDispatch
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
  const proxy = PROXIES[upstream.hostname]
  if (!proxy) return modelError(dispatch.provider, 400, `no MPP proxy for ${upstream.hostname}`)
  const headers: [string, string][] = dispatch.headers.filter(([name]) =>
    HEADERS.test(name.toLowerCase()),
  )
  const body = await request.arrayBuffer()
  return wallet(env, dispatch.authority.account_id).fetch(
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

export function egress(env: MachinesEnv): PrivateBinding {
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url)
      if (pathname === '/model' && request.method === 'POST') return model(env, request)
      if (pathname === '/warm' && request.method === 'POST')
        return new Response(null, { status: 204 })
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

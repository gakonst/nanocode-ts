import type * as Contracts from '../Contracts.ts'

export type Dispatch = (
  request: { endpoint: string; method: string; headers: [string, string][]; body: Uint8Array },
  signal: AbortSignal,
) => Promise<Response>

export async function credential(): Promise<string> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (key) return key

  const { getVercelOidcToken } = await import('@vercel/oidc')
  try {
    return await getVercelOidcToken()
  } catch (error) {
    throw new Error(
      `no AI Gateway credential: set AI_GATEWAY_API_KEY, or run \`vercel env pull\` for VERCEL_OIDC_TOKEN (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

export function dispatch(options: dispatch.Options = {}): Dispatch {
  const read = options.credential ?? credential

  return async (request, signal) => {
    const origin = new URL(url()).origin
    if (new URL(request.endpoint).origin !== origin)
      throw new Error(`model request to ${request.endpoint} is not for the AI Gateway at ${origin}`)

    const key = await read()
    const headers = new Headers(request.headers)
    headers.set('authorization', `Bearer ${key}`)
    headers.set('x-api-key', key)

    return fetch(request.endpoint, {
      method: 'POST',
      headers,
      body: request.body as Uint8Array<ArrayBuffer>,
      signal,
      redirect: 'manual',
    })
  }
}

export declare namespace dispatch {
  type Options = {
    credential?: (() => Promise<string>) | undefined
  }
}

export function endpoint(provider: Contracts.ModelProvider): string {
  return provider === 'codex' ? `${url()}/v1` : `${url()}/v1/messages`
}

export function planEndpoint(provider: Contracts.ModelProvider): string {
  return provider === 'codex'
    ? 'https://chatgpt.com/backend-api/codex'
    : 'https://api.anthropic.com/v1/messages?beta=true'
}

export function url(): string {
  return process.env.AI_GATEWAY_BASE_URL ?? 'https://ai-gateway.vercel.sh'
}

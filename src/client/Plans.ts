import type { ChatGpt, Claude } from 'nanocode-egress'

export type Provider = 'claude' | 'codex'

export type Status = { claude: Claude.Status; codex: ChatGpt.Status }

export type SignIn =
  | { provider: 'claude'; authorization_url: string; expires_at: number }
  | { provider: 'codex'; status: ChatGpt.Status }

export type Client = {
  status(): Promise<Status>
  signIn(provider: Provider): Promise<SignIn>
  complete(code: string): Promise<Claude.Status>
  signOut(provider: Provider): Promise<void>
}

export function create(options: create.Options): Client {
  const base = options.url.replace(/\/+$/, '')
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    for (const [name, value] of Object.entries((await options.headers?.()) ?? {}))
      headers.set(name, value)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await (options.fetch ?? fetch)(base + path, {
      ...init,
      headers,
      cache: 'no-store',
    })
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    if (!response.ok) throw new Error(body.error ?? `the plan route answered ${response.status}`)
    return body as unknown
  }
  return {
    status: async () => (await send('')) as Status,
    signIn: async (provider) =>
      (await send(`/${provider}/sign-in`, { method: 'POST', body: '{}' })) as SignIn,
    complete: async (code) =>
      (await send('/claude/complete', {
        method: 'POST',
        body: JSON.stringify({ code }),
      })) as Claude.Status,
    signOut: async (provider) => {
      await send(`/${provider}`, { method: 'DELETE' })
    },
  }
}

export declare namespace create {
  type Options = {
    url: string
    headers?: () => Record<string, string> | Promise<Record<string, string>>
    fetch?: typeof fetch
  }
}

const vendors: Record<Provider, RegExp> = { claude: /^claude-/, codex: /^gpt-/ }

export function serves(provider: Provider, model?: string | undefined): boolean {
  return !model || vendors[provider].test(model)
}

export function name(provider: Provider): string {
  return provider === 'codex' ? 'ChatGPT' : 'Claude'
}

/**
 * Browser client of a deployment's plan routes: the ChatGPT and Claude plans of the visitor's account, their sign-in
 * and sign-out.
 *
 * @module
 */
import type { ChatGpt, Claude } from 'nanocode-egress'

/** Model provider of a plan: `codex` for ChatGPT, `claude` for Claude. */
export type Provider = 'claude' | 'codex'

/** Sign-in states of both plans. */
export type Status = { claude: Claude.Status; codex: ChatGpt.Status }

/** Started sign-in: Claude's page to open, or ChatGPT's code to enter at its page. */
export type SignIn =
  | { provider: 'claude'; authorization_url: string; expires_at: number }
  | { provider: 'codex'; status: ChatGpt.Status }

/** Client of one account's plans. */
export type Client = {
  /** Returns both plans' states, polling a pending ChatGPT sign-in. */
  status(): Promise<Status>
  /** Starts a sign-in to the plan of `provider`. */
  signIn(provider: Provider): Promise<SignIn>
  /** Finishes a Claude sign-in with the code that Claude's page shows, `code#state`, or its callback URL. */
  complete(code: string): Promise<Claude.Status>
  /** Signs out of the plan of `provider`. */
  signOut(provider: Provider): Promise<void>
}

/** Returns the client of the plan routes at `options.url`, such as `/plans` on Cloudflare or `/api/plans` on Vercel. */
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
    /** URL of the plan routes. */
    url: string
    /** Returns the headers that identify the visitor, such as the deployment's authorization. */
    headers?: () => Record<string, string> | Promise<Record<string, string>>
    /** `fetch` of the requests. Defaults to the global `fetch`. */
    fetch?: typeof fetch
  }
}

/** Model IDs of each plan's vendor: Anthropic's `claude-` models and OpenAI's `gpt-` models. */
const vendors: Record<Provider, RegExp> = { claude: /^claude-/, codex: /^gpt-/ }

/**
 * Returns whether the plan of `provider` serves `model`: a Claude plan serves Anthropic's models and a ChatGPT plan
 * OpenAI's, the models the catalog lists on the provider's `direct` API, which `Plans.test.ts` checks. Other models
 * of the harness, such as GLM-5.3 or Kimi K3 through a gateway, run on the deployment's gateway. A session that names
 * no model takes its harness's default, which the plan serves.
 */
export function serves(provider: Provider, model?: string | undefined): boolean {
  return !model || vendors[provider].test(model)
}

/** Display name of the plan of `provider`. */
export function name(provider: Provider): string {
  return provider === 'codex' ? 'ChatGPT' : 'Claude'
}

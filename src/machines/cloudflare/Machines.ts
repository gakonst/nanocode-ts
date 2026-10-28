/**
 * nanocode machines on Cloudflare: a Worker that runs sessions whose models, tools, and MCP servers
 * the account's wallet pays for, with key, secret, and file routes.
 *
 * @module
 */
import * as App from '../../cloudflare/App.ts'
import { json } from '../account.ts'
import * as Payment from '../payment.ts'
import * as Egress from './Egress.ts'
import * as Env from './Env.ts'
import * as Keys from './internal/Keys.ts'
import * as Tools from './Tools.ts'
import * as Wallets from './Wallets.ts'

const secretName = /^[A-Z_][A-Z0-9_]{0,63}$/

const archivePath = /^\/api\/github\/([\w.-]+)\/([\w.-]+)\/(.+)$/

const machinesKeys = Keys.handlers<Env.Env>()

/** Returns the principal of a request that carries a wallet key, or `null`. */
export async function principal(request: Request, env: Env.Env) {
  return machinesKeys.principal(request, env)
}

/** Serves `POST /v1/keys`, which registers a wallet key. */
export async function register(request: Request, env: Env.Env): Promise<Response> {
  return machinesKeys.register(request, env)
}

/** Serves the key, secret, and file routes under `/v1/`. */
export async function api<E extends Env.Env>(
  request: Request,
  options: api.Options<E>,
): Promise<Response> {
  return serve(Keys.handlers<E>(), request, options.env, options.pathname)
}

export declare namespace api {
  type Options<E extends Env.Env> = {
    /** Bindings of the Worker. */
    env: E
    /** Path of the request. */
    pathname: string
  }
}

/**
 * Returns the `AgentSession` and `Wallet` Durable Object classes and the Worker handler of a
 * machines deployment. Throws when `payment.inference` is `apiKey` without the host's egress.
 */
export function create<E extends Env.Env = Env.Env>(options: create.Options<E> = {}) {
  const { fallback, payment, account, ...rest } = options
  const { inference, servers, tools: paid } = Payment.resolve(payment)
  if (inference === 'apiKey' && !rest.egress)
    throw new Error("payment.inference apiKey needs the host's egress")

  const handlers = Keys.handlers<E>(account)
  const nanocode = App.create<E>({
    authenticate: async (request, env) =>
      account ? ((await account(request, env)) ?? null) : handlers.principal(request, env),
    egress: Egress.create,
    tools: { call: Tools.call, definitions: Tools.definitions },
    subagents: true,
    streamToolInput: true,
    codeMode:
      paid === 'tempo'
        ? { fetch: (authority, env) => Env.paying(env, { account: authority.account_id }) }
        : {},
    ...(servers.length
      ? {
          mcp: {
            servers: [...servers],
            fetch: (authority: App.SessionAuthority, env: E) =>
              Env.paying(env, { account: authority.account_id }),
          },
        }
      : {}),
    ...rest,
  })

  async function fetch(request: Request, env: E): Promise<Response> {
    const { pathname } = new URL(request.url)
    const relayed = Keys.relay(request, pathname)
    if (relayed) return relayed
    if (request.method === 'GET' && pathname.startsWith('/api/github/')) return archive(pathname)
    if (pathname.startsWith('/v1/')) return serve(handlers, request, env, pathname)
    if (pathname.startsWith('/sessions/') || pathname === '/health')
      return nanocode.fetch(request, env)
    if (fallback) return fallback(request, env)
    return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'not_found' }, 404)
  }

  return {
    AgentSession: nanocode.AgentSession,
    Wallet: Wallets.subclass({ servers }),
    fetch,
    nanocode,
  }
}

export declare namespace create {
  type Options<E extends Env.Env> = Partial<App.create.Options<E>> & {
    /** Returns the account of a request from the host's own authentication. */
    account?: Keys.Account<E>
    /** Serves the requests that no route of the deployment serves. Defaults to `ASSETS`. */
    fallback?(request: Request, env: E): Promise<Response> | Response
    /** Payment configuration of inference, tools, and MCP servers. */
    payment?: Payment.Config
  }
}

async function serve<E extends Env.Env>(
  handlers: Keys.Handlers<E>,
  request: Request,
  env: E,
  pathname: string,
): Promise<Response> {
  const answered = await Keys.routes(handlers, request, env, pathname)
  if (answered) return answered

  const owner = await handlers.caller(request, env)
  if (!owner) return json({ error: 'send Authorization: Bearer <token> from POST /v1/keys' }, 401)

  const stub = Env.wallet(env, { account: owner })
  const secret = /^\/v1\/secrets\/([^/]+)$/.exec(pathname)
  if (secret) {
    const name = decodeURIComponent(secret[1]!)
    if (!secretName.test(name))
      return json({ error: 'secret names are [A-Z_][A-Z0-9_]{0,63}' }, 400)
    if (request.method === 'DELETE')
      return (await stub.setSecret(name, null), json({ deleted: name }))
    if (request.method !== 'PUT') return json({ error: 'PUT or DELETE' }, 405)

    const value = ((await request.json().catch(() => undefined)) as { value?: unknown } | undefined)
      ?.value
    if (typeof value !== 'string' || !value || value.length > 8192)
      return json({ error: 'send {value}' }, 400)
    await stub.setSecret(name, value)
    return json({ stored: name })
  }

  if (pathname === '/v1/files' && request.method === 'GET')
    return json({ sessions: await stub.allFiles() })

  const file = /^\/v1\/files\/([^/]+)\/(.+)$/.exec(pathname)
  if (file && request.method === 'GET') {
    const content = await stub.readFile(decodeURIComponent(file[1]!), decodeURIComponent(file[2]!))
    return content === undefined
      ? json({ error: 'no such file' }, 404)
      : new Response(content, {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        })
  }

  return json({ error: 'not_found' }, 404)
}

async function archive(pathname: string): Promise<Response> {
  const match = archivePath.exec(pathname)
  if (!match) return json({ error: 'use /api/github/OWNER/REPO/REF' }, 404)

  const upstream = await fetch(
    `https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${match[3]}`,
    { headers: { 'user-agent': 'nanocode-machines-web' } },
  )
  return new Response(upstream.body, {
    headers: {
      'cache-control': 'public, max-age=300',
      'content-type': upstream.headers.get('content-type') ?? 'application/x-gzip',
    },
    status: upstream.status,
  })
}

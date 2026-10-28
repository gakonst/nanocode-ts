import {
  createNanocode,
  type NanocodeOptions,
  type SessionAuthority,
} from '../../cloudflare/runtime.ts'
import { githubArchives } from '../../bash/index.ts'
import * as Mcp from '../mcp.ts'
import * as Payment from '../payment.ts'
import { device, type Holder, keys } from '../account.ts'
import { egress } from './egress.ts'
import { json, type MachinesEnv, paying, wallet } from './env.ts'
import { tools } from './tools.ts'
import { walletClass } from './wallet.ts'

export { egress, PROXIES } from './egress.ts'
export { json, type MachinesEnv, paying, wallet } from './env.ts'
export { tools } from './tools.ts'
export { digest, type KeyRecord, MACH, RPC, Wallet, walletClass } from './wallet.ts'
export { visitor, VISITOR } from '../account.ts'

const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/

type Account<E> = (
  request: Request,
  env: E,
) => Promise<string | null | undefined> | string | null | undefined

function keyHandlers<E extends MachinesEnv>(account?: Account<E>) {
  return keys<E>({
    holder: (owner, env) => wallet(env, owner) as unknown as Holder,
    rpc: (env) => env.TEMPO_RPC,
    extra: async (owner, env) => ({ secrets: await wallet(env, owner).secretNames() }),
    ...(account ? { account } : {}),
  })
}

const machinesKeys = keyHandlers<MachinesEnv>()

export async function principal(request: Request, env: MachinesEnv) {
  return machinesKeys.principal(request, env)
}

export async function register(request: Request, env: MachinesEnv): Promise<Response> {
  return machinesKeys.register(request, env)
}

async function routes<E extends MachinesEnv>(
  handlers: ReturnType<typeof keyHandlers<E>>,
  request: Request,
  env: E,
  pathname: string,
): Promise<Response | undefined> {
  if (pathname === '/v1/keys' && request.method === 'POST') return handlers.register(request, env)
  if (pathname === '/v1/keys' && request.method === 'DELETE') return handlers.logout(request, env)
  if ((pathname === '/v1/me' || pathname === '/v1/keys') && request.method === 'GET')
    return handlers.me(request, env)
  return undefined
}

export async function api<E extends MachinesEnv>(
  request: Request,
  env: E,
  pathname: string,
  handlers = keyHandlers<E>(),
): Promise<Response> {
  const answered = await routes(handlers, request, env, pathname)
  if (answered) return answered
  const owner = await handlers.caller(request, env)
  if (!owner) return json({ error: 'send Authorization: Bearer <token> from POST /v1/keys' }, 401)
  const stub = wallet(env, owner)
  const secret = /^\/v1\/secrets\/([^/]+)$/.exec(pathname)
  if (secret) {
    const name = decodeURIComponent(secret[1]!)
    if (!SECRET_NAME.test(name))
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

const ARCHIVE = /^\/api\/github\/([\w.-]+)\/([\w.-]+)\/(.+)$/

async function archive(pathname: string): Promise<Response> {
  const match = ARCHIVE.exec(pathname)
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

function relay(request: Request, pathname: string): Promise<Response> | undefined {
  if (
    request.method !== 'POST' ||
    (pathname !== '/api/device/register' && pathname !== '/api/device/token')
  )
    return undefined
  return device(request, pathname.slice('/api/device/'.length))
}

export type MachinesOptions<E extends MachinesEnv> = Partial<NanocodeOptions<E>> & {
  payment?: Payment.Config
  account?: Account<E>
  fallback?(request: Request, env: E): Promise<Response> | Response
}

export function createMachines<E extends MachinesEnv = MachinesEnv>(
  options: MachinesOptions<E> = {},
) {
  const { fallback, payment, account, ...rest } = options
  const { inference, servers, tools: paid } = Payment.resolve(payment)
  if (inference === 'apiKey' && !rest.egress)
    throw new Error("payment.inference apiKey needs the host's egress")
  const handlers = keyHandlers<E>(account)
  const nanocode = createNanocode<E>({
    authenticate: async (request, env) =>
      account ? ((await account(request, env)) ?? null) : handlers.principal(request, env),
    egress,
    tools,
    subagents: true,
    streamToolInput: true,
    codeMode:
      paid === 'tempo' ? { fetch: (authority, env) => paying(env, authority.account_id) } : {},
    ...(servers.length
      ? {
          mcp: {
            servers: [...servers],
            fetch: (authority: { account_id: string }, env: E) => paying(env, authority.account_id),
          },
        }
      : {}),
    ...rest,
  })

  async function fetch(request: Request, env: E): Promise<Response> {
    const { pathname } = new URL(request.url)
    const relayed = relay(request, pathname)
    if (relayed) return relayed
    if (request.method === 'GET' && pathname.startsWith('/api/github/')) return archive(pathname)
    if (pathname.startsWith('/v1/')) return api(request, env, pathname, handlers)
    if (pathname.startsWith('/sessions/') || pathname === '/health')
      return nanocode.fetch(request, env)
    if (fallback) return fallback(request, env)
    return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'not_found' }, 404)
  }

  return { AgentSession: nanocode.AgentSession, Wallet: walletClass(servers), fetch, nanocode }
}

export type WalletsOptions<E extends MachinesEnv> = {
  account: Account<E>
  payment?: Payment.Config
  scripts?: boolean
}

export function createWallets<E extends MachinesEnv>(options: WalletsOptions<E>) {
  const { servers } = Payment.resolve({ inference: 'apiKey', ...options.payment })
  const scripts = options.scripts ?? false
  const handlers = keyHandlers<E>(options.account)
  const nanocode: Pick<NanocodeOptions<E>, 'codeMode' | 'mcp'> = {
    ...(scripts
      ? {
          codeMode: {
            fetch: (authority: SessionAuthority, env: E) => paying(env, authority.account_id),
          },
        }
      : { codeMode: { fetch: () => githubArchives() } }),
    ...(servers.length
      ? {
          mcp: {
            servers: [...servers],
            fetch: (authority: SessionAuthority, env: E) => paying(env, authority.account_id),
          },
        }
      : {}),
  }

  async function fetch(request: Request, env: E): Promise<Response | undefined> {
    const { pathname } = new URL(request.url)
    return relay(request, pathname) ?? routes(handlers, request, env, pathname)
  }

  return { Wallet: walletClass(servers, scripts), fetch, nanocode, servers, scripts }
}

import type { KeyAuthorization } from 'ox/tempo'
import type { Address, Hex } from 'viem'
import * as Egress from '../internal/Egress.ts'
import type * as Core from './internal/Core.ts'
import * as Mcp from './Mcp.ts'

export const mach: Address = '0x20c000000000000000000000f37de3740adec032'
export const rpc = 'https://rpc.tempo.xyz'
export const visitorHeader = 'x-nanocode-visitor'
const tokenPattern = /^(0x[0-9a-f]{40})\.[0-9a-f]{64}$/
const visitorPattern = /^[0-9a-f]{64}$/

export type KeyRecord = {
  address: Address
  keyAddress: Address
  keyType: 'secp256k1' | 'p256'
  key: Hex
  expiry: number
  authorization?: KeyAuthorization.Rpc | undefined
}

export type Store = {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list<T>(prefix: string): Promise<[string, T][]>
  update<T>(key: string, change: (value: T | undefined) => T): Promise<T>
}

export type Status = {
  address?: string
  key_address?: string
  key_type?: string
  expires_at?: number
  spent: Record<string, string>
  calls: Record<string, number>
}

export type Init = {
  method: string
  headers: [string, string][]
  body?: BodyInit
  signal?: AbortSignal
}

export type Holder = {
  register(record: KeyRecord, issue?: boolean): Promise<string | undefined>
  authenticate(hash: string): Promise<number | null>
  status(): Promise<Status>
  logout(): Promise<boolean>
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function digest(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

export function sealer(secret: string | undefined) {
  let sealing: Promise<CryptoKey> | undefined
  const material = () =>
    (sealing ??= (async () => {
      if (!secret || secret.length < 32) throw new Error('KEY_SECRET is not set')
      const raw = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        'HKDF',
        false,
        ['deriveKey'],
      )
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new TextEncoder().encode('nanocode-machines-cloud'),
          info: new TextEncoder().encode('wallet-v1'),
        },
        raw,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
    })())
  return {
    async seal(text: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        await material(),
        new TextEncoder().encode(text),
      )
      return `${hex(iv)}.${hex(sealed)}`
    },
    async open(value: string): Promise<string> {
      const [iv, sealed] = value
        .split('.')
        .map((part) => Uint8Array.from(part!.match(/../g)!, (byte) => parseInt(byte, 16)))
      return new TextDecoder().decode(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv! }, await material(), sealed!),
      )
    },
  }
}

export function create(options: create.Options): Account {
  let loading: Promise<Account> | undefined
  const core = () =>
    (loading ??= import('./internal/Core.ts').then((module) => module.create(options)))
  return {
    allFiles: async () => (await core()).allFiles(),
    authenticate: async (hash) => (await core()).authenticate(hash),
    deleteFile: async (session, path) => (await core()).deleteFile(session, path),
    files: async (session) => (await core()).files(session),
    logout: async () => (await core()).logout(),
    readFile: async (session, path) => (await core()).readFile(session, path),
    record: async () => (await core()).record(),
    register: async (next, issue) => (await core()).register(next, issue),
    secretNames: async () => (await core()).secretNames(),
    secrets: async (names) => (await core()).secrets(names),
    send: async (kind, target, init) => (await core()).send(kind, target, init),
    setSecret: async (name, value) => (await core()).setSecret(name, value),
    status: async () => (await core()).status(),
    warm: async () => (await core()).warm(),
    writeFile: async (session, path, content) => (await core()).writeFile(session, path, content),
  }
}

export declare namespace create {
  type Options = {
    fetch?: typeof fetch
    rpc?: string
    scripts?: boolean
    secret: string | undefined
    servers?: readonly Mcp.Server[]
    store: Store
  }
}

export type Account = ReturnType<typeof Core.create>

export { publicTarget } from '../internal/Egress.ts'

export async function envelope(
  request: Request,
  servers: readonly Mcp.Server[] = Mcp.servers,
): Promise<{ kind: 'model' | 'pay'; target: string; init: Init } | undefined> {
  const { pathname } = new URL(request.url)
  const target = request.headers.get('x-target')
  if (!target || (pathname !== '/model' && pathname !== '/pay')) return undefined
  const headers = JSON.parse(request.headers.get('x-headers') ?? '[]') as [string, string][]
  const method = request.headers.get('x-method') ?? request.method
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : Mcp.server(target, servers)
        ? await request.text()
        : await request.arrayBuffer()
  return {
    kind: pathname === '/model' ? 'model' : 'pay',
    target,
    init: { method, headers, ...(body === undefined ? {} : { body }), signal: request.signal },
  }
}

export async function forward(
  send: (request: Request) => Promise<Response>,
  options: forward.Options,
): Promise<Response> {
  const request = new Request(options.input, options.init)
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer()
  return send(
    new Request('https://wallet.internal/pay', {
      method: 'POST',
      body,
      signal: request.signal,
      headers: {
        'x-target': request.url,
        'x-method': request.method,
        'x-headers': JSON.stringify([...request.headers]),
      },
    }),
  )
}

export declare namespace forward {
  type Options = {
    init?: RequestInit | undefined
    input: RequestInfo | URL
  }
}

export function paying(
  holder: () => Pick<Account, 'send'>,
  servers: readonly Mcp.Server[] = Mcp.servers,
): typeof fetch {
  return Egress.mark(async (input, init) => {
    const request = new Request(input, init)
    const method = request.method
    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : Mcp.server(request.url, servers)
          ? await request.text()
          : await request.arrayBuffer()
    return holder().send('pay', request.url, {
      method,
      headers: [...request.headers],
      ...(body === undefined ? {} : { body }),
      signal: request.signal,
    })
  })
}

export async function verify(
  body: Parameters<typeof Core.verify>[0],
  endpoint = rpc,
): Promise<(KeyRecord & { spendPolicy: string }) | Response> {
  return (await import('./internal/Core.ts')).verify(body, endpoint)
}

export async function visitor(request: Request): Promise<string | null> {
  const id = request.headers.get(visitorHeader) ?? ''
  return visitorPattern.test(id) ? `visitor:${(await digest(id)).slice(0, 40)}` : null
}

export type KeysOptions<E> = {
  holder(account: string, env: E): Holder
  account?(request: Request, env: E): Promise<string | null | undefined> | string | null | undefined
  rpc?(env: E): string | undefined
  extra?(account: string, env: E): Promise<Record<string, unknown>>
}

export function keys<E>(options: KeysOptions<E>) {
  async function principal(
    request: Request,
    env: E,
  ): Promise<{ account: string; expires_at: number } | null> {
    const header = request.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : (new URL(request.url).searchParams.get('token') ?? '')
    const match = tokenPattern.exec(token)
    if (!match) return null
    const expires = await options.holder(match[1]!, env).authenticate(await digest(token))
    return expires ? { account: match[1]!, expires_at: expires } : null
  }

  async function caller(request: Request, env: E): Promise<string | null> {
    const hosted = await options.account?.(request, env)
    if (hosted) return hosted
    return (await principal(request, env))?.account ?? null
  }

  async function register(request: Request, env: E): Promise<Response> {
    const verified = await verify(
      (await request.json().catch(() => undefined)) as Parameters<typeof verify>[0],
      options.rpc?.(env) ?? rpc,
    )
    if (verified instanceof Response) return verified
    const { spendPolicy, ...record } = verified
    const hosted = await options.account?.(request, env)
    const owner = hosted ?? record.address
    const token = await options.holder(owner, env).register(record, !hosted)
    return json({
      ...(token ? { token } : {}),
      account: owner,
      address: record.address,
      key_address: record.keyAddress,
      expires_at: record.expiry * 1000,
      spend_policy: spendPolicy,
    })
  }

  async function me(request: Request, env: E): Promise<Response> {
    const owner = await caller(request, env)
    if (!owner) return json({ error: 'send Authorization: Bearer <token> from POST /v1/keys' }, 401)
    return json({
      account: owner,
      ...(await options.holder(owner, env).status()),
      ...(await options.extra?.(owner, env)),
    })
  }

  async function logout(request: Request, env: E): Promise<Response> {
    const owner = await caller(request, env)
    if (!owner) return json({ error: 'send Authorization: Bearer <token> from POST /v1/keys' }, 401)
    return json({ account: owner, removed: await options.holder(owner, env).logout() })
  }

  return { caller, logout, me, principal, register }
}

export async function device(request: Request, step: string): Promise<Response> {
  const response = await fetch(`https://wallet.tempo.xyz/api/auth/device/${step}`, {
    body: await request.text(),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    method: 'POST',
  })
  return new Response(response.body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': response.headers.get('content-type') ?? 'application/json',
    },
    status: response.status,
  })
}

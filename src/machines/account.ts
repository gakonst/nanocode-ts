import { createJsonChannelStore, Mppx, tempo as payments } from 'mppx/client'
import { type Address, type Hex, isAddressEqual, isHex } from 'viem'
import { Account, Actions, createClient, http } from 'viem/tempo'
import { tempo } from 'viem/tempo/chains'
import { guard, mark } from '../egress.ts'
import * as Mcp from './mcp.ts'
import * as Payment from './payment.ts'

export const MACH: Address = '0x20c000000000000000000000f37de3740adec032'
export const RPC = 'https://rpc.tempo.xyz'
export const VISITOR = 'x-nanocode-visitor'
const OPENING = '200000'
const TOP_UP = '0.2'
const MAX_DEPOSIT = '2'
const FILE_LIMIT = 1_000_000
const TOKEN = /^(0x[0-9a-f]{40})\.[0-9a-f]{64}$/
const VISITOR_ID = /^[0-9a-f]{64}$/

export type KeyRecord = {
  address: Address
  keyAddress: Address
  keyType: 'secp256k1' | 'p256'
  key: Hex
  expiry: number
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

export type AccountOptions = {
  store: Store
  secret: string | undefined
  servers?: readonly Mcp.Server[]
  rpc?: string
  scripts?: boolean
  fetch?: typeof fetch
}

type Payer = {
  fetch: (input: string, init: RequestInit & { context?: unknown }) => Promise<Response>
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

export function account(options: AccountOptions) {
  const { store } = options
  const servers = options.servers ?? Mcp.servers
  const rpc = options.rpc ?? RPC
  const network = guard(options.fetch ?? ((input, init) => globalThis.fetch(input, init)))
  const sealing = sealer(options.secret)
  let payer: { sealed: string; payer: Payer } | undefined

  async function record(): Promise<KeyRecord | undefined> {
    const sealed = await store.get<string>('key')
    if (!sealed) return undefined
    const record = JSON.parse(await sealing.open(sealed)) as KeyRecord
    return record.expiry * 1000 > Date.now() ? record : undefined
  }

  async function register(next: KeyRecord, issue = true): Promise<string | undefined> {
    const current = issue ? await record() : undefined
    if (current && !isAddressEqual(current.address, next.address))
      throw new Error('this wallet object belongs to another account')
    await store.put('key', await sealing.seal(JSON.stringify(next)))
    payer = undefined
    if (!issue) return undefined
    const token = `${next.address.toLowerCase()}.${hex(crypto.getRandomValues(new Uint8Array(32)))}`
    await store.put(`token:${await digest(token)}`, next.expiry)
    return token
  }

  async function authenticate(hash: string): Promise<number | null> {
    const expiry = await store.get<number>(`token:${hash}`)
    if (!expiry || expiry * 1000 <= Date.now()) return null
    const current = await record()
    return current ? Math.min(expiry, current.expiry) * 1000 : null
  }

  async function status(): Promise<Status> {
    const current = await record()
    const spent: Record<string, string> = {}
    for (const [key, value] of await store.list<string>('spent:'))
      spent[key.slice('spent:'.length)] = value
    const calls: Record<string, number> = {}
    for (const [key, value] of await store.list<number>('calls:'))
      calls[key.slice('calls:'.length)] = value
    return current
      ? {
          address: current.address,
          key_address: current.keyAddress,
          key_type: current.keyType,
          expires_at: current.expiry * 1000,
          spent,
          calls,
        }
      : { spent, calls }
  }

  async function logout(): Promise<boolean> {
    const had = await store.delete('key')
    for (const [key] of await store.list('token:')) await store.delete(key)
    payer = undefined
    return had
  }

  async function setSecret(name: string, value: string | null) {
    if (value === null) await store.delete(`secret:${name}`)
    else await store.put(`secret:${name}`, await sealing.seal(value))
  }

  async function secretNames(): Promise<string[]> {
    return (await store.list('secret:')).map(([key]) => key.slice('secret:'.length))
  }

  async function secrets(names: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const name of names) {
      const sealed = await store.get<string>(`secret:${name}`)
      if (sealed) out[name] = await sealing.open(sealed)
    }
    return out
  }

  async function files(session: string): Promise<{ path: string; chars: number }[]> {
    const prefix = `file:${session}:`
    return (await store.list<string>(prefix)).map(([key, value]) => ({
      path: key.slice(prefix.length),
      chars: value.length,
    }))
  }

  async function allFiles(): Promise<Record<string, { path: string; chars: number }[]>> {
    const out: Record<string, { path: string; chars: number }[]> = {}
    for (const [key, value] of await store.list<string>('file:')) {
      const [, session, ...rest] = key.split(':')
      ;(out[session!] ??= []).push({ path: rest.join(':'), chars: value.length })
    }
    return out
  }

  function readFile(session: string, path: string): Promise<string | undefined> {
    return store.get<string>(`file:${session}:${path}`)
  }

  async function writeFile(session: string, path: string, content: string) {
    if (content.length > FILE_LIMIT)
      throw new Error(`files are limited to ${FILE_LIMIT} characters`)
    await store.put(`file:${session}:${path}`, content)
  }

  function deleteFile(session: string, path: string) {
    return store.delete(`file:${session}:${path}`)
  }

  function route(url: string) {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  }

  async function label(url: string) {
    const description = await store.get<string>(`label:${route(url)}`)
    const host = new URL(url).hostname
    return description ? `${host} · ${description}` : host
  }

  async function describe(url: string, description: string | undefined) {
    if (description) await store.put(`label:${route(url)}`, description.slice(0, 80))
  }

  async function count(url: string) {
    await store.update<number>(`calls:${await label(url)}`, (value) => (value ?? 0) + 1)
  }

  async function charge(url: string, amount: bigint) {
    if (amount === 0n) return
    await store.update<string>(`spent:${await label(url)}`, (value) => {
      const total = BigInt(value ?? '0') + amount
      return (total > 0n ? total : 0n).toString()
    })
  }

  async function receipt(url: string, text: string) {
    let parsed: { channelId?: string; intent?: string; spent?: string }
    try {
      parsed = JSON.parse(text)
    } catch {
      return false
    }
    if (parsed.intent !== 'session' || !parsed.channelId || parsed.spent === undefined) return false
    const spent = BigInt(parsed.spent)
    let before = 0n
    await store.update<string>(`seen:${parsed.channelId}`, (value) => {
      before = BigInt(value ?? '0')
      return spent.toString()
    })
    await charge(url, spent - before)
    return true
  }

  async function tool(call: Mcp.Call | undefined, response: Response) {
    if (!call) return
    const result = await Mcp.outcome(response)
    await describe(call.url, result.description ?? call.challenge?.description)
    if (result.required || !call.challenge) return
    await count(call.url)
    if (call.challenge.intent === 'charge')
      return charge(call.url, BigInt(call.challenge.request?.amount ?? '0'))
    if (result.receipt) await receipt(call.url, JSON.stringify(result.receipt))
  }

  function metered(url: string, body: ReadableStream<Uint8Array>) {
    return Payment.receipts(body, (data) => receipt(url, data))
  }

  async function pay(): Promise<Payer> {
    const sealed = await store.get<string>('key')
    if (payer && payer.sealed === sealed) return payer.payer
    const current = await record()
    if (!sealed || !current)
      throw new Error(
        'no access key is registered for this account, or it expired: connect Tempo Wallet again',
      )
    const signer =
      current.keyType === 'p256'
        ? Account.fromP256(current.key, { access: current.address })
        : Account.fromSecp256k1(current.key, { access: current.address })
    const client = createClient({ chain: tempo, transport: http(rpc) })
    const prefix = `channel:${current.keyAddress.toLowerCase()}:`
    const mppx = Mppx.create({
      fetch: async (input, init) => {
        const url = String(input instanceof Request ? input.url : input)
        if (Mcp.server(url, servers)) {
          const call = await Mcp.call(input, init)
          const response = await network(input, init)
          await tool(call, response)
          return response
        }
        const response = await network(input, init)
        if (response.status === 402) {
          await describe(
            url,
            response.headers.get('www-authenticate')?.match(/description="([^"]*)"/)?.[1],
          )
          return response
        }
        await count(url)
        const header = response.headers.get('payment-receipt')
        if (header) await receipt(url, atob(header.replace(/-/g, '+').replace(/_/g, '/')))
        if (
          !response.body ||
          !response.headers.get('content-type')?.startsWith('text/event-stream')
        )
          return response
        return new Response(metered(url, response.body), {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        })
      },
      methods: [
        payments.session({
          account: signer,
          allowedChainIds: [tempo.id],
          channelStore: createJsonChannelStore({
            delete: async (key) => {
              await store.delete(prefix + key)
            },
            get: (key) => store.get<string>(prefix + key),
            set: (key, value) => store.put(prefix + key, value),
          }),
          getClient: () => client,
          maxDeposit: MAX_DEPOSIT,
          topUpAmount: TOP_UP,
        }),
        payments.charge({ account: signer, allowedChainIds: [tempo.id], getClient: () => client }),
      ],
      orderChallenges: (candidates) => {
        const rank = (candidate: (typeof candidates)[number]) => {
          const request = candidate.challenge.request as {
            currency?: Address
            methodDetails?: { machineTokenEnabled?: boolean }
          }
          const isMach = !!request.currency && isAddressEqual(request.currency, MACH)
          if (candidate.challenge.intent === 'session') return isMach ? 0 : -1
          if (candidate.challenge.intent !== 'charge') return -1
          if (request.methodDetails?.machineTokenEnabled === true) return 1
          return isMach ? 2 : -1
        }
        return candidates
          .filter((candidate) => rank(candidate) >= 0)
          .sort((a, b) => rank(a) - rank(b))
          .slice(0, 1)
      },
      polyfill: false,
    })
    mppx.onPaymentResponse((payment) => {
      void payment.response.body?.cancel().catch(() => undefined)
      const url = String(payment.input instanceof Request ? payment.input.url : payment.input)
      if (Mcp.server(url, servers)) return
      void describe(url, (payment.challenge as { description?: string }).description)
      if (payment.challenge.intent !== 'charge') return
      const request = payment.challenge.request as { amount?: string }
      void charge(url, BigInt(request.amount ?? '0'))
    })
    const created: Payer = { fetch: (input, init) => mppx.fetch(input, init as never) }
    payer = { sealed, payer: created }
    return created
  }

  async function send(kind: 'model' | 'pay', target: string, init: Init): Promise<Response> {
    if (kind === 'pay' && !new Headers(init.headers).has('user-agent'))
      init = { ...init, headers: [...new Headers(init.headers), ['user-agent', 'nanocode-ts']] }
    if (kind === 'pay' && !(await record()))
      return Payment.locked(
        servers,
        network,
        options.scripts,
      )(target, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      })
    try {
      const current = await pay()
      return await current.fetch(target, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
        context: { depositRaw: OPENING },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json(
        kind === 'model'
          ? { type: 'error', error: { type: 'payment_error', message } }
          : { error: message },
        402,
      )
    }
  }

  return {
    allFiles,
    authenticate,
    deleteFile,
    files,
    logout,
    readFile,
    record,
    register,
    secretNames,
    secrets,
    send,
    setSecret,
    status,
    writeFile,
  }
}

export type Account = ReturnType<typeof account>

export { publicTarget } from '../egress.ts'

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
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init)
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

export function paying(
  holder: () => Pick<Account, 'send'>,
  servers: readonly Mcp.Server[] = Mcp.servers,
): typeof fetch {
  return mark(async (input, init) => {
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
  body: { address?: string; key_type?: string; private_key?: string } | undefined,
  rpc = RPC,
): Promise<(KeyRecord & { spendPolicy: string }) | Response> {
  const address = body?.address
  const key = body?.private_key
  const types: ('secp256k1' | 'p256')[] =
    body?.key_type === 'p256'
      ? ['p256']
      : body?.key_type === 'secp256k1'
        ? ['secp256k1']
        : ['secp256k1', 'p256']
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || !key || !isHex(key) || key.length !== 66)
    return json({ error: 'send {address, private_key, key_type?: secp256k1 | p256}' }, 400)
  const client = createClient({ chain: tempo, transport: http(rpc) })
  for (const keyType of types) {
    const keyAddress = (
      keyType === 'p256'
        ? Account.fromP256(key, { access: address as Address })
        : Account.fromSecp256k1(key, { access: address as Address })
    ).accessKeyAddress
    const metadata = await Actions.accessKey
      .getMetadata(client, { account: address as Address, accessKey: keyAddress })
      .catch(() => undefined)
    if (!metadata || !isAddressEqual(metadata.address, keyAddress) || metadata.isRevoked) continue
    const expiry = Number(metadata.expiry)
    if (expiry * 1000 <= Date.now()) return json({ error: 'the access key has expired' }, 403)
    return {
      address: address.toLowerCase() as Address,
      keyAddress,
      keyType,
      key,
      expiry,
      spendPolicy: String(metadata.spendPolicy),
    }
  }
  return json(
    { error: `this key is not an active access key of ${address} on Tempo; publish it first` },
    403,
  )
}

export async function visitor(request: Request): Promise<string | null> {
  const id = request.headers.get(VISITOR) ?? ''
  return VISITOR_ID.test(id) ? `visitor:${(await digest(id)).slice(0, 40)}` : null
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
    const match = TOKEN.exec(token)
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
      options.rpc?.(env) ?? RPC,
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

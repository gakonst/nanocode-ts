import { createJsonChannelStore, Mppx, tempo as payments } from 'mppx/client'
import { KeyAuthorization } from 'ox/tempo'
import { type Address, BaseError, isAddressEqual, isHex, parseUnits } from 'viem'
import { Account, Actions, createClient, http, KeyAuthorizationManager } from 'viem/tempo'
import { tempo } from 'viem/tempo/chains'
import * as Egress from '../../internal/Egress.ts'
import * as AccessKey from '../AccessKey.ts'
import * as Mcp from '../Mcp.ts'
import * as Payment from '../Payment.ts'
import {
  type create as Create,
  digest,
  hex,
  type Init,
  json,
  type KeyRecord,
  mach,
  rpc,
  sealer,
  type Status,
} from '../Account.ts'

const opening = '200000'
const topUp = '0.2'
const maxDeposit = '2'
const tokenDecimals = 6
const fileLimit = 1_000_000
const approveSelector = '0x095ea7b3'
const feeTokens: Address[] = [
  '0x20c0000000000000000000000000000000000000',
  '0x20c000000000000000000000b9537d11c60e8b50',
  mach,
]

type Payer = {
  fetch: (input: string, init: RequestInit & { context?: unknown }) => Promise<Response>
}

function chainClient(endpoint: string) {
  return createClient({ chain: tempo, transport: http(endpoint) })
}

type Channel = {
  channelId?: string
  cumulativeAmount?: string
  descriptor?: { payee?: string; token?: string }
}

type Session = {
  amount?: string
  currency?: string
  methodDetails?: { sessionSnapshot?: { channelId?: string; requiredCumulative?: string } }
  recipient?: string
}

function exhausted(channel: Channel, options: { cap: bigint; request: Session }): boolean {
  const { cap, request } = options
  if (
    channel.cumulativeAmount === undefined ||
    !channel.descriptor?.payee ||
    !channel.descriptor.token ||
    !request.amount ||
    !request.currency ||
    !request.recipient ||
    !isAddressEqual(channel.descriptor.payee as Address, request.recipient as Address) ||
    !isAddressEqual(channel.descriptor.token as Address, request.currency as Address)
  )
    return false
  const next = BigInt(channel.cumulativeAmount) + BigInt(request.amount)
  const snapshot = request.methodDetails?.sessionSnapshot
  const required =
    snapshot?.requiredCumulative !== undefined &&
    snapshot.channelId?.toLowerCase() === channel.channelId?.toLowerCase() &&
    BigInt(snapshot.requiredCumulative) > next
      ? BigInt(snapshot.requiredCumulative)
      : next
  return required > cap
}

async function land(
  client: ReturnType<typeof chainClient>,
  signer: ReturnType<typeof Account.fromSecp256k1> | ReturnType<typeof Account.fromP256>,
  current: KeyRecord,
  authorization: KeyAuthorization.KeyAuthorization,
): Promise<void> {
  const metadata = await Actions.accessKey.getMetadata(client, {
    account: current.address,
    accessKey: current.keyAddress,
  })
  if (isAddressEqual(metadata.address, current.keyAddress)) return
  const scope = authorization.scopes?.find(
    (entry) => entry.selector?.toLowerCase() === approveSelector,
  )
  if (authorization.scopes?.length && !scope)
    throw new Error(
      'the access key is not on Tempo yet and none of its call scopes can carry its authorization: connect Tempo Wallet again',
    )
  const reasons: string[] = []
  for (const feeToken of feeTokens) {
    const balance = await Actions.token
      .getBalance(client, { account: current.address, token: feeToken })
      .then((found) => found.amount)
      .catch(() => 0n)
    if (balance === 0n) continue
    try {
      await Actions.token.approveSync(client, {
        account: signer,
        token: scope?.address ?? mach,
        spender: scope?.recipients?.[0] ?? current.address,
        amount: 0n,
        feeToken,
      })
      return
    } catch (error) {
      reasons.push(
        `fee in ${feeToken}: ${error instanceof BaseError ? (error.details ?? error.shortMessage) : error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  throw new Error(
    `the access key is not on Tempo yet, and authorizing it with a self-paid transaction failed: ${reasons.join('; ') || 'the account holds none of the fee tokens (pathUSD, USDC.e, MACH)'}`,
  )
}

export function create(options: Create.Options) {
  const { store } = options
  const servers = options.servers ?? Mcp.servers
  const endpoint = options.rpc ?? rpc
  const network = Egress.guard(options.fetch ?? ((input, init) => globalThis.fetch(input, init)))
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
    if (content.length > fileLimit) throw new Error(`files are limited to ${fileLimit} characters`)
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
    const keyAuthorizationManager = KeyAuthorizationManager.memory()
    const authorization = current.authorization
      ? KeyAuthorization.fromRpc(current.authorization)
      : undefined
    if (authorization)
      await keyAuthorizationManager.set(
        { accessKey: current.keyAddress, address: current.address, chainId: tempo.id },
        authorization,
      )
    const signer =
      current.keyType === 'p256'
        ? Account.fromP256(current.key, { access: current.address, keyAuthorizationManager })
        : Account.fromSecp256k1(current.key, { access: current.address, keyAuthorizationManager })
    const client = chainClient(endpoint)
    let landed: Promise<void> | undefined
    const landing = () => {
      if (!authorization) return Promise.resolve()
      landed ??= land(client, signer, current, authorization).catch((error: unknown) => {
        landed = undefined
        throw error
      })
      return landed
    }
    const lands = <method extends { createCredential: (options: never) => Promise<string> }>(
      method: method,
    ): method => {
      const create = method.createCredential
      method.createCredential = (async (options: never) => {
        await landing()
        return create.call(method, options)
      }) as method['createCredential']
      return method
    }
    const prefix = `channel:${current.keyAddress.toLowerCase()}:`
    const cap = parseUnits(maxDeposit, tokenDecimals)
    const mppx = Mppx.create({
      onChallenge: async (challenge) => {
        if (challenge.intent !== 'session') return undefined
        for (const [key, value] of await store.list<string>(`${prefix}chan:`)) {
          const channel = (() => {
            try {
              return JSON.parse(value) as Channel
            } catch {
              return undefined
            }
          })()
          if (channel && exhausted(channel, { cap, request: challenge.request as Session }))
            await store.delete(key)
        }
        return undefined
      },
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
        lands(
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
            maxDeposit,
            topUpAmount: topUp,
          }),
        ),
        lands(
          payments.charge({
            account: signer,
            allowedChainIds: [tempo.id],
            getClient: () => client,
          }),
        ),
      ],
      orderChallenges: (candidates) => {
        const rank = (candidate: (typeof candidates)[number]) => {
          const request = candidate.challenge.request as {
            currency?: Address
            methodDetails?: { machineTokenEnabled?: boolean }
          }
          const isMach = !!request.currency && isAddressEqual(request.currency, mach)
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

  async function warm(): Promise<boolean> {
    if (!(await record())) return false
    await pay()
    return true
  }

  async function send(kind: 'model' | 'pay', target: string, init: Init): Promise<Response> {
    if (kind === 'pay' && !new Headers(init.headers).has('user-agent'))
      init = { ...init, headers: [...new Headers(init.headers), ['user-agent', 'nanocode-ts']] }
    if (kind === 'pay' && !(await record()))
      return Payment.locked(servers, { fetch: network, scripts: options.scripts })(target, {
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
        context: { depositRaw: opening },
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
    warm,
    writeFile,
  }
}

export async function verify(
  body:
    | {
        address?: string
        key_authorization?: KeyAuthorization.Rpc
        key_type?: string
        private_key?: string
      }
    | undefined,
  endpoint = rpc,
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
  const client = createClient({ chain: tempo, transport: http(endpoint) })
  for (const keyType of types) {
    const keyAddress = (
      keyType === 'p256'
        ? Account.fromP256(key, { access: address as Address })
        : Account.fromSecp256k1(key, { access: address as Address })
    ).accessKeyAddress
    const metadata = await Actions.accessKey
      .getMetadata(client, { account: address as Address, accessKey: keyAddress })
      .catch(() => undefined)
    const onChain = !!metadata && isAddressEqual(metadata.address, keyAddress)
    if (onChain && metadata.isRevoked) return json({ error: 'the access key was revoked' }, 403)
    if (!onChain) {
      const authorization =
        body?.key_authorization &&
        AccessKey.verify({
          address: address as Address,
          authorization: body.key_authorization,
          chainId: tempo.id,
          keyAddress,
        })
      if (!authorization) continue
      return {
        address: address.toLowerCase() as Address,
        keyAddress,
        keyType,
        key,
        expiry: Number(authorization.expiry),
        authorization: body.key_authorization,
        spendPolicy: authorization.limits === undefined ? 'unlimited' : 'limited',
      }
    }
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
    {
      error: `this key is neither an active access key of ${address} on Tempo nor one that key_authorization authorizes`,
    },
    403,
  )
}

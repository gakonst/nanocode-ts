/**
 * Tempo Wallet access keys of nanocode machines: approval, publication on Tempo, balances, and
 * revocation. Wallet libraries load on first use.
 *
 * @module
 */
import type { KeyAuthorization } from 'ox/tempo'
import type { Address, Client, Hash, Hex, Transport } from 'viem'
import type * as Chains from 'viem/tempo/chains'
import type * as Tempo from 'viem/tempo'

const modules = () =>
  Promise.all([
    import('accounts'),
    import('accounts/deviceCode'),
    import('ox/tempo'),
    import('viem'),
    import('viem/accounts'),
    import('viem/actions'),
    import('viem/tempo'),
    import('viem/tempo/chains'),
  ])

let loaded: ReturnType<typeof modules> | undefined

function load() {
  return (loaded ??= modules())
}

/** Loads the wallet libraries when the browser is idle. */
export function preload() {
  const start = () =>
    void load().catch(() => {
      loaded = undefined
    })
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 3000 })
  else setTimeout(start, 1000)
}

/** MACH token on Tempo. */
export const mach = {
  address: '0x20c000000000000000000000f37de3740adec032',
  chainId: 4217,
  decimals: 6,
  symbol: 'MACH',
} as const

/** USDC.e token on Tempo, which pays transaction fees. */
export const usdc = {
  address: '0x20c000000000000000000000b9537d11c60e8b50',
  symbol: 'USDC.e',
} as const

/** MACH limit of a key in base units. */
export const allowance = 2_000_000n

/** USDC.e fee limit of a key in base units. */
export const feeAllowance = 100_000n

/** Lifetime of a key in seconds. */
export const lifetime = 86_400

/** RPC URL of Tempo. */
export const rpc = 'https://rpc.tempo.xyz'

const escrow: Address = '0x4d50500000000000000000000000000000000000'

const swapper: Address = '0xF72E5107c32C655ffA7539a3C8e97B7C3cE16A3F'

const selectors = {
  approve: '0x095ea7b3',
  open: '0xedc53b00',
  requestClose: '0x675402e5',
  swapTo: '0x34189fed',
  topUp: '0xdc48471e',
  transferWithMemo: '0x95777d59',
  withdraw: '0x41e2c664',
} as const

const storageKey = 'nanocode.machines.wallet'

/** Access key that Tempo Wallet approved, which `localStorage` keeps. */
export type AccessKey = {
  /** Address of the wallet. */
  address: Address
  /** Key authorization that the wallet signed. */
  authorization: KeyAuthorization.Rpc
  /** Expiry in seconds since the epoch. */
  expiry: number
  /** Private key. */
  key: Hex
  /** Address of the key. */
  keyAddress: Address
}

/** Device code that Tempo Wallet requests the user to approve. */
export type Prompt = {
  /** Code to enter. */
  userCode: string
  /** URL that accepts the code. */
  verificationUri: string
  /** URL that holds the code. */
  verificationUriFull: string | undefined
}

/** Wallet options of a page. */
export type Options = {
  /** Display name of the site in Tempo Wallet. */
  name: string
  /** Path of the device code relay. */
  relay: string
  /** URL of the site in Tempo Wallet. */
  websiteUrl: string
}

let options: Options = {
  name: 'nanocode machines',
  relay: 'api/device/',
  websiteUrl: 'https://nanocode.xyz/machines/',
}

/** Sets the wallet options of the page, and drops the current wallet provider. */
export function configure(next: Partial<Options>) {
  options = { ...options, ...next }
  provider = undefined
}

let provider: Promise<{ request(request: never): Promise<unknown> }> | undefined

let prompt: (prompt: Prompt) => void = () => {}

/** Whether the page runs in a frame that cannot open Tempo Wallet, such as X's player. */
export function framed() {
  return document.documentElement.hasAttribute('data-xframe')
}

let formsBlocked: boolean | undefined

/** Whether the frame's sandbox blocks form submission. */
export function sandboxed() {
  if (formsBlocked !== undefined) return formsBlocked
  const form = document.createElement('form')
  let submitted = false
  form.addEventListener('submit', (event) => {
    submitted = true
    event.preventDefault()
  })
  document.body.append(form)
  form.requestSubmit()
  form.remove()
  formsBlocked = !submitted
  return formsBlocked
}

/** Sets the receiver of device codes, and returns its removal. */
export function onPrompt(listener: (prompt: Prompt) => void) {
  prompt = listener
  return () => {
    prompt = () => {}
  }
}

function relay(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input instanceof Request ? input.url : input)
  const device = 'https://wallet.tempo.xyz/api/auth/device/'
  return fetch(
    url.startsWith(device)
      ? new URL(`${options.relay}${url.slice(device.length)}`, location.href)
      : input,
    init,
  )
}

function wallet() {
  return (provider ??= load().then(
    ([{ Provider, tempoWallet }, { tempoWallet: deviceWallet }]) =>
      Provider.create({
        adapter: framed()
          ? deviceWallet({
              fetch: relay as typeof fetch,
              meta: { name: options.name, websiteUrl: options.websiteUrl },
              onPrompt: (next) => prompt(next),
            })
          : tempoWallet(),
        mpp: false,
      }) as never,
  ))
}

/** Returns a client that reads Tempo. */
export async function reader(): Promise<Client<Transport, typeof Chains.tempo>> {
  const [, , , , , , { createClient, http }, { tempo }] = await load()
  return createClient({ chain: tempo, transport: http(rpc) })
}

/** Returns the saved key, or `undefined` when it is absent, expired, or has no fee limit. */
export function restore(): AccessKey | undefined {
  const saved = localStorage.getItem(storageKey)
  if (!saved) return undefined
  const parsed = JSON.parse(saved) as AccessKey
  const fees = parsed.authorization.limits?.some(
    (limit) => limit.token.toLowerCase() === usdc.address,
  )
  if (parsed.expiry * 1000 > Date.now() && fees) return parsed
  localStorage.removeItem(storageKey)
  return undefined
}

/** Requests a new key from Tempo Wallet, and saves and returns it. */
export async function connect(): Promise<AccessKey> {
  const [, , , { toHex }, { generatePrivateKey }, , { Account }, { tempo }] = await load()
  const key = generatePrivateKey()
  const access = Account.fromSecp256k1(key)
  const expiry = Math.floor(Date.now() / 1000) + lifetime
  const request = {
    address: access.address,
    chainId: toHex(tempo.id),
    expiry,
    keyType: 'secp256k1',
    limits: [
      { limit: toHex(allowance), token: mach.address },
      { limit: toHex(feeAllowance), token: usdc.address },
    ],
    publicKey: access.publicKey,
    scopes: [
      { address: mach.address, selector: selectors.transferWithMemo },
      { address: mach.address, recipients: [swapper], selector: selectors.approve },
      { address: swapper, selector: selectors.swapTo },
      ...[selectors.open, selectors.topUp, selectors.requestClose, selectors.withdraw].map(
        (selector) => ({ address: escrow, selector }),
      ),
    ],
  }
  const result = (await (
    await wallet()
  ).request({
    method: 'wallet_connect',
    params: [{ capabilities: { authorizeAccessKey: request }, chainId: tempo.id }],
  } as never)) as {
    accounts: readonly {
      address: Address
      capabilities?: { keyAuthorization?: KeyAuthorization.Rpc }
    }[]
  }
  const account = result.accounts[0]
  const authorization = account?.capabilities?.keyAuthorization
  if (!account || !authorization) throw new Error('Tempo Wallet returned no approval.')
  const connected: AccessKey = {
    address: account.address,
    authorization,
    expiry,
    key,
    keyAddress: access.address,
  }
  localStorage.setItem(storageKey, JSON.stringify(connected))
  return connected
}

/** Whether Tempo holds the key and has not revoked it. */
export async function published(connected: AccessKey) {
  const [, , , { isAddressEqual }, , , { Actions }] = await load()
  const metadata = await Actions.accessKey.getMetadata(await reader(), {
    accessKey: connected.keyAddress,
    account: connected.address,
  })
  return isAddressEqual(metadata.address, connected.keyAddress) && !metadata.isRevoked
}

/** Publishes the key on Tempo, and returns the transaction hash, or `undefined` when Tempo already holds it. */
export async function publish(connected: AccessKey): Promise<Hash | undefined> {
  if (await published(connected)) return undefined
  const [
    ,
    ,
    { KeyAuthorization },
    { encodeFunctionData },
    ,
    { prepareTransactionRequest, sendRawTransactionSync, signTransaction },
    { Abis },
  ] = await load()
  const client = await reader()
  const account = await signer(connected)
  const request = await prepareTransactionRequest(client, {
    account,
    calls: [
      {
        data: encodeFunctionData({ abi: Abis.tip20, args: [swapper, 0n], functionName: 'approve' }),
        to: mach.address,
      },
    ],
    feeToken: usdc.address,
    keyAuthorization: KeyAuthorization.fromRpc(connected.authorization),
    nonceKey: 'expiring',
  } as never)
  const receipt = await sendRawTransactionSync(client, {
    serializedTransaction: await signTransaction(client, request as never),
  })
  if (receipt.status !== 'success')
    throw new Error(`Tempo did not accept the key (transaction ${receipt.transactionHash}).`)
  return receipt.transactionHash
}

/** Requests Tempo Wallet to revoke the key. */
export async function revoke(connected: AccessKey) {
  const [, , , { toHex }, , , , { tempo }] = await load()
  await (
    await wallet()
  ).request({
    method: 'wallet_revokeAccessKey',
    params: [
      {
        accessKeyAddress: connected.keyAddress,
        address: connected.address,
        chainId: toHex(tempo.id),
      },
    ],
  } as never)
}

/** Removes the saved key. */
export function forget() {
  localStorage.removeItem(storageKey)
}

/** Opens the MACH checkout of Tempo Wallet. */
export async function fund(connected: AccessKey) {
  const [[{ Mach }], client] = await Promise.all([load(), wallet()])
  return Mach.fund(client as never, { address: connected.address, displayName: options.name })
}

/** Returns the URL of the MACH checkout in Tempo Wallet. */
export function fundingUrl(connected: AccessKey) {
  const url = new URL('https://wallet.tempo.xyz/agent')
  url.searchParams.set('action', 'fund')
  url.searchParams.set('intent', 'mach')
  url.searchParams.set('address', connected.address)
  url.searchParams.set('chainId', String(mach.chainId))
  return url.toString()
}

/** Returns an account that signs with the key for the wallet. */
export async function signer(
  connected: AccessKey,
): Promise<ReturnType<typeof Tempo.Account.fromSecp256k1>> {
  const [, , , , , , { Account }] = await load()
  return Account.fromSecp256k1(connected.key, { access: connected.address })
}

/** Returns the MACH and fee balances of the wallet, and the MACH that the key may still spend. */
export async function balances(connected: AccessKey) {
  const [, , , , , , { Actions }] = await load()
  const client = await reader()
  const [balance, fees, remaining] = await Promise.all([
    Actions.token.getBalance(client, { account: connected.address, token: mach.address }),
    Actions.token.getBalance(client, { account: connected.address, token: usdc.address }),
    Actions.accessKey
      .getRemainingLimit(client, {
        accessKey: connected.keyAddress,
        account: connected.address,
        token: mach.address,
      })
      .then(
        (limit) => limit.remaining,
        () => allowance,
      ),
  ])
  return { balance: balance.amount, fees: fees.amount, remaining }
}

/** Returns an address or hash cut to its start and end. */
export function short(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

/** Returns an amount in base units of a 6-decimal token as decimal text. */
export function format(atomics: bigint) {
  return `${atomics / 1_000_000n}.${(atomics % 1_000_000n).toString().padStart(6, '0')}`
}

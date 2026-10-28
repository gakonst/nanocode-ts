import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo'
import {
  type Address,
  type Client,
  type Hash,
  type Hex,
  http,
  InvalidParamsRpcError,
  isAddressEqual,
  type LocalAccount,
} from 'viem'
import { prepareTransactionRequest, sendRawTransactionSync, signTransaction } from 'viem/actions'
import { Actions, createClient, withRelay } from 'viem/tempo'
import { tempo } from 'viem/tempo/chains'

export const relay = 'https://wallet.tempo.xyz/api/relay'

export type Publish = {
  account: LocalAccount
  address: Address
  authorization: KeyAuthorization.Rpc
  call: { data: Hex; to: Address }
  feeToken: Address
  keyAddress: Address
  rpc: string
}

export async function published(options: { address: Address; keyAddress: Address; rpc: string }) {
  const metadata = await Actions.accessKey.getMetadata(
    createClient({ chain: tempo, transport: http(options.rpc) }),
    { accessKey: options.keyAddress, account: options.address },
  )
  return isAddressEqual(metadata.address, options.keyAddress) && !metadata.isRevoked
}

export async function publish(options: Publish): Promise<Hash | undefined> {
  if (await published(options)) return undefined
  const request = {
    account: options.account,
    calls: [options.call],
    keyAuthorization: KeyAuthorization.fromRpc(options.authorization),
    nonceKey: 'expiring',
  }
  try {
    return await send(
      createClient({ chain: tempo, transport: withRelay(http(options.rpc), http(relay)) }),
      {
        ...request,
        feePayer: true,
      },
    )
  } catch (error) {
    if (!(error instanceof InvalidParamsRpcError)) throw error
  }
  return await send(createClient({ chain: tempo, transport: http(options.rpc) }), {
    ...request,
    feeToken: options.feeToken,
  })
}

async function send(client: Client, request: Record<string, unknown>): Promise<Hash> {
  const prepared = await prepareTransactionRequest(client, request as never)
  const receipt = await sendRawTransactionSync(client, {
    serializedTransaction: await signTransaction(client, prepared as never),
  })
  if (receipt.status !== 'success')
    throw new Error(`Tempo did not accept the key (transaction ${receipt.transactionHash}).`)
  return receipt.transactionHash
}

export function verify(options: {
  address: Address
  authorization: KeyAuthorization.Rpc
  chainId: number
  keyAddress: Address
}): KeyAuthorization.Signed | undefined {
  try {
    const authorization = KeyAuthorization.fromRpc(options.authorization)
    if (!isAddressEqual(authorization.address, options.keyAddress)) return undefined
    if (Number(authorization.chainId) !== options.chainId) return undefined
    if (authorization.expiry == null || authorization.expiry * 1000 <= Date.now()) return undefined
    const valid = SignatureEnvelope.verify(authorization.signature, {
      address: options.address,
      payload: KeyAuthorization.getSignPayload(authorization),
    })
    return valid ? authorization : undefined
  } catch {
    return undefined
  }
}

import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo'
import { type Address, isAddressEqual } from 'viem'

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

/**
 * Hand tokens: bearer tokens that carry an account and a per-session secret, which a session mints
 * for the hands that attach to it.
 *
 * @module
 */

/** Pattern of a hand token. Group 1 is the hex-encoded account, and group 2 is the secret. */
export const pattern = /^nch_([0-9a-f]{2,512})_([0-9a-f]{64})$/

/** Returns the hand token of `options.account` with `options.secret`. */
export function encode(options: encode.Options): string {
  return `nch_${hex(new TextEncoder().encode(options.account))}_${options.secret}`
}

export declare namespace encode {
  type Options = {
    /** Account that the token authorizes. */
    account: string
    /** Secret of the session, from `secret()`. */
    secret: string
  }
}

/** Decodes the hex-encoded account of a hand token, or returns `null` when it is not UTF-8. */
export function account(encoded: string): string | null {
  if (encoded.length % 2) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(encoded.match(/../g)!, (pair) => parseInt(pair, 16)),
    )
  } catch {
    return null
  }
}

/** Returns a new random secret of 32 bytes as hex. */
export function secret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)))
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

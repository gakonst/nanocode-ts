export const pattern = /^nch_([0-9a-f]{2,512})_([0-9a-f]{64})$/

export function encode(options: encode.Options): string {
  return `nch_${hex(new TextEncoder().encode(options.account))}_${options.secret}`
}

export declare namespace encode {
  type Options = {
    account: string
    secret: string
  }
}

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

export function secret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)))
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

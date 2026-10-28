/**
 * Keyrings: a server's store of the connected key, which paid tools on that server use.
 *
 * @module
 */
import type { Status } from './Account.ts'
import type * as Wallet from './Wallet.ts'

/** `localStorage` key of the visitor identifier. */
export const visitorKey = 'nanocode.visitor'

/** Request header that carries the visitor identifier. */
export const visitorHeader = 'x-nanocode-visitor'

/** Returns the visitor identifier of this browser, and creates one when it has none. */
export function visitor(): string {
  const saved = localStorage.getItem(visitorKey)
  if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved
  const created = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  localStorage.setItem(visitorKey, created)
  return created
}

/** Returns the headers that carry the visitor identifier. */
export function visitorHeaders(): Record<string, string> {
  return { [visitorHeader]: visitor() }
}

/** Client of a server's keyring. */
export type Keyring = {
  /** Removes the key from the keyring. */
  logout(): Promise<void>
  /** Stores the key in the keyring once for each scope. */
  register(wallet: Wallet.AccessKey): Promise<void>
  /** Returns the key's status and spend, or `undefined` when the scope is not ready. */
  status(): Promise<Status | undefined>
}

async function failure(response: Response) {
  const text = await response.text()
  try {
    return new Error((JSON.parse(text) as { error?: string }).error ?? text)
  } catch {
    return new Error(`${response.status} ${text}`)
  }
}

/** Creates a client of the keyring at `options.url`. Calls run one at a time. */
export function create(options: create.Options): Keyring {
  const registered = new Set<string>()
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  const target = async () => {
    if (!options.scope) return options.url
    const scope = await options.scope()
    return scope ? `${options.url}?${new URLSearchParams(scope)}` : undefined
  }
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...options.headers?.() })

  return {
    register: (wallet) =>
      serial(async () => {
        const url = await target()
        if (!url) return
        const id = `${url} ${wallet.keyAddress}`
        if (registered.has(id)) return
        const response = await fetch(url, {
          body: JSON.stringify({
            address: wallet.address,
            key_type: 'secp256k1',
            private_key: wallet.key,
          }),
          headers: headers({ 'content-type': 'application/json' }),
          method: 'POST',
        })
        if (!response.ok) throw await failure(response)
        registered.add(id)
      }),
    status: () =>
      serial(async () => {
        const url = await target()
        if (!url) return undefined
        const response = await fetch(url, { headers: headers() })
        if (!response.ok) throw await failure(response)
        return (await response.json()) as Status
      }),
    logout: () =>
      serial(async () => {
        registered.clear()
        const url = await target()
        if (!url) return
        const response = await fetch(url, { headers: headers(), method: 'DELETE' })
        if (!response.ok) throw await failure(response)
      }),
  }
}

export declare namespace create {
  type Options = {
    /** Returns extra request headers. */
    headers?(): Record<string, string>
    /** Returns the query that scopes the key, or `undefined` while no scope is ready. */
    scope?(): Promise<Record<string, string> | undefined> | Record<string, string> | undefined
    /** URL of the keyring. */
    url: string
  }
}

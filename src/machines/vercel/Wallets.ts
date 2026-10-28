/**
 * Machine payment wallets of Vercel sessions, with each session's keys in a durable-harness document.
 *
 * @module
 */
import { defineDoc, type DurableSessions } from 'durable-harness'
import * as Egress from '../../vercel/internal/Egress.ts'
import * as Payment from '../payment.ts'
import { account, type Account, device, json, keys, paying, type Store } from '../account.ts'

// The document kind and version are durable.
const walletDoc = defineDoc<{ entries: Record<string, string | number> }>({
  kind: 'nanocode.wallet',
  version: 1,
  initial: () => ({ entries: {} }),
})

/** Returns the wallet routes, the paying `fetch` of each session, and the MCP payment servers. */
export function create(options: create.Options) {
  const { servers } = Payment.resolve({ inference: 'apiKey', ...options.payment })
  const holders = new Map<string, Account>()
  const holder = (sessionId: string) => {
    let found = holders.get(sessionId)
    if (!found) {
      found = account({
        store: store({ sessionId, sessions: options.sessions }),
        secret: options.secret,
        servers,
        scripts: options.scripts ?? false,
        fetch: Egress.guard(),
        ...(options.rpc ? { rpc: options.rpc } : {}),
      })
      holders.set(sessionId, found)
    }
    return found
  }
  const sessionOf = (request: Request) => new URL(request.url).searchParams.get('sessionId')
  const handlers = keys<undefined>({ holder, account: sessionOf, rpc: () => options.rpc })

  async function guarded(
    request: Request,
    run: (request: Request) => Promise<Response>,
  ): Promise<Response> {
    const sessionId = sessionOf(request)
    if (!sessionId) return json({ error: 'send ?sessionId=<the chat session>' }, 400)
    try {
      await options.authorize?.(request, sessionId)
    } catch (refusal) {
      if (refusal instanceof Response) return refusal
      throw refusal
    }
    try {
      return await run(request)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  }

  return {
    DELETE: (request: Request) =>
      guarded(request, (request) => handlers.logout(request, undefined)),
    GET: (request: Request) => guarded(request, (request) => handlers.me(request, undefined)),
    POST: (request: Request) =>
      guarded(request, (request) => handlers.register(request, undefined)),
    device,
    fetch: (sessionId: string) => paying(() => holder(sessionId), servers),
    mcp: {
      servers: [...servers],
      fetch: (sessionId: string) => paying(() => holder(sessionId), servers),
    },
    servers,
  }
}

export declare namespace create {
  type Options = {
    /** Authorizes a wallet request for a session. A thrown `Response` refuses it. */
    authorize?(request: Request, sessionId: string): Promise<void> | void
    /** Payment configuration. Inference defaults to `apiKey`. */
    payment?: Payment.Config
    /** Tempo RPC URL. */
    rpc?: string
    /** Whether wallets run scripts. Defaults to `false`. */
    scripts?: boolean
    /** Secret that seals the wallet keys. */
    secret: string | undefined
    /** Returns the durable sessions that hold the wallet documents. */
    sessions(): DurableSessions
  }
}

/** Returns a `Store` over the wallet document of one session, which caches reads for `maxAgeMs`. */
export function store(options: store.Options): Store {
  const { sessionId, sessions } = options
  const maxAgeMs = options.maxAgeMs ?? 1000
  let cached: { at: number; entries: Record<string, string | number> } | undefined
  const read = async () => {
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.entries
    const snapshot = await sessions().doc(sessionId, walletDoc)
    cached = { at: Date.now(), entries: { ...snapshot.value.entries } }
    return cached.entries
  }
  const write = async (mutate: (entries: Record<string, string | number>) => void) => {
    const snapshot = await sessions().updateDoc(sessionId, walletDoc, (draft) => {
      mutate(draft.entries)
    })
    cached = { at: Date.now(), entries: { ...snapshot.value.entries } }
  }
  return {
    get: async <T>(key: string) => (await read())[key] as T | undefined,
    put: (key, value) =>
      write((entries) => {
        entries[key] = value as string | number
      }),
    delete: async (key) => {
      let had = false
      await write((entries) => {
        had = key in entries
        delete entries[key]
      })
      return had
    },
    list: async <T>(prefix: string) =>
      Object.entries(await read()).filter(([key]) => key.startsWith(prefix)) as [string, T][],
    update: async <T>(key: string, change: (value: T | undefined) => T) => {
      let next: T | undefined
      await write((entries) => {
        next = change(entries[key] as T | undefined)
        entries[key] = next as string | number
      })
      return next as T
    },
  }
}

export declare namespace store {
  type Options = {
    /** Time in milliseconds that a read stays cached. Defaults to 1000. */
    maxAgeMs?: number
    /** Session whose document holds the store. */
    sessionId: string
    /** Returns the durable sessions. */
    sessions(): DurableSessions
  }
}

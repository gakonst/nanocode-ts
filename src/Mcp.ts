/**
 * Caches MCP `initialize` and `tools/list` responses for the configured servers.
 *
 * @module
 */
import type * as Contracts from './Contracts.ts'

type Request = {
  provider: unknown
  endpoint: string
  method: string
  headers: [string, string][]
  body: Uint8Array
}

type Send<R extends Request, A extends unknown[]> = (
  request: R,
  signal: AbortSignal,
  ...rest: A
) => Promise<Response>

type Tool = { name: string; [key: string]: unknown }

type Listing = {
  at: number
  init?: Promise<unknown>
  tools?: Promise<Tool[] | undefined>
  stateful?: boolean
}

/** Cache policy for MCP listings. */
export type Policy = NonNullable<Contracts.RuntimeOptions['mcp']>

const DEFAULT_CACHE_MS = 600_000

const encoder = new TextEncoder()

const decoder = new TextDecoder()

const listings = new Map<string, Listing>()

function key(endpoint: string) {
  const url = new URL(endpoint)
  return url.origin + url.pathname
}

function message(body: Uint8Array): { id?: unknown; method?: string } | undefined {
  try {
    return JSON.parse(decoder.decode(body)) as never
  } catch {
    return undefined
  }
}

async function payload(
  response: Response,
): Promise<{ result?: unknown; error?: unknown } | undefined> {
  const text = await response.text()
  const json = (response.headers.get('content-type') ?? '').includes('event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1)
    : text
  try {
    return JSON.parse(json ?? '') as never
  } catch {
    return undefined
  }
}

type Stored = { at: number; init: unknown; tools: Tool[] }

async function digest(url: string) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(url))
  return (
    'nanocode-mcp:' +
    Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  )
}

async function stored(store: Contracts.McpStore, url: string, ttl: number) {
  const value = await store.get(await digest(url)).catch(() => undefined)
  if (!value) return undefined

  const parsed = (() => {
    try {
      return JSON.parse(value) as Stored
    } catch {
      return undefined
    }
  })()
  if (!parsed || !Array.isArray(parsed.tools) || Date.now() - parsed.at > ttl) return undefined
  return parsed
}

function reply(id: unknown, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'content-type': 'application/json' },
  })
}

/** Wraps a dispatch so that MCP `initialize` and `tools/list` requests to `servers` reuse cached responses. */
export function defer<R extends Request, A extends unknown[]>(
  send: Send<R, A>,
  servers: readonly Contracts.McpServer[] | undefined,
  policy: Policy = {},
): Send<R, A> {
  if (!servers?.length) return send
  const urls = new Set(servers.map((server) => key(server.url)))
  const ttl = policy.cacheMs ?? DEFAULT_CACHE_MS
  return async (request, signal, ...rest) => {
    if (
      request.provider != null ||
      request.method !== 'POST' ||
      !URL.canParse(request.endpoint) ||
      !urls.has(key(request.endpoint))
    )
      return send(request, signal, ...rest)
    const url =
      key(request.endpoint) +
      '|' +
      JSON.stringify(
        request.headers
          .filter(
            ([name]) =>
              !/^(mcp-session-id|mcp-protocol-version|content-length|content-type|accept|user-agent|last-event-id)$/i.test(
                name,
              ),
          )
          .sort(),
      )
    const body = message(request.body)
    let listing = listings.get(url)
    if (listing && Date.now() - listing.at > ttl) {
      listings.delete(url)
      listing = undefined
    }
    if (listing?.stateful) return send(request, signal, ...rest)
    const list = () => {
      const fetched = send(
        {
          ...request,
          body: encoder.encode(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'nanocode-tools',
              method: 'tools/list',
              params: {},
            }),
          ),
        },
        new AbortController().signal,
        ...rest,
      )
        .then(async (response) => {
          const parsed = response.ok
            ? ((await payload(response)) as
                | { result?: { tools?: Tool[]; nextCursor?: unknown } }
                | undefined)
            : undefined
          return parsed?.result?.tools && !parsed.result.nextCursor
            ? parsed.result.tools
            : undefined
        })
        .catch(() => undefined)
      void fetched.then((tools) => {
        if (!tools && listings.get(url)?.tools === fetched) listings.delete(url)
      })
      return fetched
    }
    switch (body?.method) {
      case 'initialize': {
        if (listing?.init) {
          const result = await listing.init.catch(() => undefined)
          if (result) return reply(body.id, result)
        }

        const shared = !listing && policy.store ? await stored(policy.store, url, ttl) : undefined
        if (shared) {
          listings.set(url, {
            at: shared.at,
            init: Promise.resolve(shared.init),
            tools: Promise.resolve(shared.tools),
          })
          return reply(body.id, shared.init)
        }

        const fresh: Listing = { at: Date.now() }
        const response = await send(request, signal, ...rest)
        if (!response.ok || response.headers.has('mcp-session-id')) {
          if (response.headers.has('mcp-session-id'))
            listings.set(url, { at: Date.now(), stateful: true })
          return response
        }
        const parsed = await payload(response)
        if (!parsed || parsed.result === undefined)
          return new Response(JSON.stringify(parsed ?? {}), {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          })
        fresh.init = Promise.resolve(parsed.result)
        fresh.tools = listing?.tools ?? list()
        listings.set(url, fresh)

        const store = policy.store
        if (store)
          void fresh.tools
            .then(async (tools) => {
              if (!tools) return
              const value: Stored = { at: fresh.at, init: parsed.result, tools }
              await store.put(await digest(url), JSON.stringify(value), ttl)
            })
            .catch(() => undefined)
        return reply(body.id, parsed.result)
      }
      case 'notifications/initialized':
        return listing ? new Response(null, { status: 202 }) : send(request, signal, ...rest)
      case 'tools/list': {
        const tools = await (listing?.tools ??
          (listings.set(url, (listing = { at: Date.now(), tools: list() })), listing.tools))
        if (!tools) return send(request, signal, ...rest)
        return reply(body.id, { tools })
      }
      default:
        return send(request, signal, ...rest)
    }
  }
}

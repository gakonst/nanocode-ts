import * as Relay from '../client/Relay.ts'
import * as ServerEvents from '../client/ServerEvents.ts'
import type * as Contracts from '../Contracts.ts'
import type * as Payments from './Payments.ts'
import type * as Wallet from './Wallet.ts'

const storageKey = 'nanocode.machines.cloud'

const reconnectMs = 1000

export type Link = {
  address: string
  cursor: number
  expiresAt: number
  open?: string
  session: string
  token: string
}

export type Model = { model: string; provider: 'claude' | 'codex'; thinking: string }

const luna: Model = { model: 'gpt-6-luna', provider: 'codex', thinking: 'low' }

export type Handlers = { event: (logged: Contracts.LoggedEvent) => void; interrupted: () => void }

export function restore(): Link | undefined {
  const saved = localStorage.getItem(storageKey)
  if (!saved) return undefined
  const parsed = JSON.parse(saved) as Link
  if (parsed.expiresAt > Date.now()) return parsed
  localStorage.removeItem(storageKey)
  return undefined
}

function save(cloud: Link) {
  localStorage.setItem(storageKey, JSON.stringify(cloud))
}

export function forget() {
  localStorage.removeItem(storageKey)
}

export async function logout(cloud: Link) {
  const response = await fetch('v1/keys', { headers: headers(cloud), method: 'DELETE' })
  if (!response.ok && response.status !== 401) throw await failure(response)
}

function headers(cloud: Link, extra: Record<string, string> = {}) {
  return { ...extra, authorization: `Bearer ${cloud.token}` }
}

async function failure(response: Response) {
  const text = await response.text()
  try {
    return new Error((JSON.parse(text) as { error?: string }).error ?? text)
  } catch {
    return new Error(`${response.status} ${text}`)
  }
}

export async function enable(connected: Wallet.AccessKey): Promise<Link> {
  const response = await fetch('v1/keys', {
    body: JSON.stringify({ address: connected.address, private_key: connected.key }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw await failure(response)
  const body = (await response.json()) as { address: string; expires_at: number; token: string }
  const cloud: Link = {
    address: body.address,
    cursor: 0,
    expiresAt: body.expires_at,
    session: `web-${crypto.randomUUID()}`,
    token: body.token,
  }
  save(cloud)
  return cloud
}

export type Session = Pick<Link, 'cursor' | 'open' | 'session'>

export function snapshot(cloud: Link): Session {
  return { cursor: cloud.cursor, open: cloud.open, session: cloud.session }
}

export function adopt(cloud: Link, saved: unknown) {
  const session = saved as Partial<Session> | undefined
  Object.assign(
    cloud,
    typeof session?.session === 'string'
      ? { cursor: session.cursor ?? 0, open: session.open, session: session.session }
      : { cursor: 0, open: undefined, session: `web-${crypto.randomUUID()}` },
  )
  save(cloud)
}

export async function status(cloud: Link) {
  const response = await fetch('v1/me', { headers: headers(cloud) })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as {
    calls?: Record<string, number>
    spent: Record<string, string>
  }
}

async function follow(
  cloud: Link,
  response: Response,
  request: string,
  handlers: Handlers,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!response.ok || !response.body) {
    if (signal?.aborted) return true
    throw await failure(response)
  }
  try {
    for await (const message of ServerEvents.parse(response.body)) {
      if (signal?.aborted) break
      if (message.id) {
        cloud.cursor = Number(message.id)
        save(cloud)
      }
      if (!message.data) continue
      const logged = JSON.parse(message.data) as Contracts.LoggedEvent & {
        event?: { source?: string; type?: string }
      }
      const body = logged.event ?? {}
      if (body.source === 'agent') {
        handlers.event(logged)
        continue
      }
      if (logged.request_id !== request) continue
      if (body.type === 'interrupted') handlers.interrupted()
      if (body.type === 'retrying' || body.type === 'result') handlers.event(logged)
      if (body.type === 'result') return true
    }
  } catch {
    return Boolean(signal?.aborted)
  }
  if (signal?.aborted) void response.body.cancel().catch(() => undefined)
  return Boolean(signal?.aborted)
}

function pause(signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, reconnectMs)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done)
  })
}

async function reconnect(
  cloud: Link,
  session: string,
  request: string,
  handlers: Handlers,
  signal?: AbortSignal,
) {
  while (!signal?.aborted) {
    const response = await fetch(
      `sessions/${encodeURIComponent(session)}/events?live=1&after=${cloud.cursor}`,
      { headers: headers(cloud, { accept: 'text/event-stream' }), signal },
    ).catch(() => undefined)
    if (response?.status === 401 || response?.status === 403) throw await failure(response)
    if (response && (await follow(cloud, response, request, handlers, signal))) return
    await pause(signal)
  }
}

export async function ask(cloud: Link, options: ask.Options) {
  const { handlers, model = luna, prompt, signal } = options
  const request = `turn-${crypto.randomUUID()}`
  const session = cloud.session
  cloud.open = request
  save(cloud)
  try {
    const response = await fetch(
      `sessions/${encodeURIComponent(session)}/turns?live=1&after=${cloud.cursor}`,
      {
        body: JSON.stringify({
          model: model.model,
          prompt,
          provider: model.provider,
          request_id: request,
          thinking: model.thinking,
        }),
        headers: headers(cloud, {
          accept: 'text/event-stream',
          'content-type': 'application/json',
        }),
        method: 'POST',
        signal,
      },
    ).catch((error: unknown) => {
      if (signal?.aborted) return undefined
      throw error
    })
    if (response && !(await follow(cloud, response, request, handlers, signal)))
      await reconnect(cloud, session, request, handlers, signal)
  } finally {
    if (!signal?.aborted) {
      cloud.open = undefined
      save(cloud)
    }
  }
}

export declare namespace ask {
  type Options = {
    handlers: Handlers
    model?: Model | undefined
    prompt: string
    signal?: AbortSignal | undefined
  }
}

export async function resume(cloud: Link, options: resume.Options) {
  const { handlers, signal } = options
  const request = cloud.open
  if (!request) return
  try {
    await reconnect(cloud, cloud.session, request, handlers, signal)
  } finally {
    if (!signal?.aborted) {
      cloud.open = undefined
      save(cloud)
    }
  }
}

export declare namespace resume {
  type Options = {
    handlers: Handlers
    signal?: AbortSignal | undefined
  }
}

export async function steer(cloud: Link, options: steer.Options): Promise<'queued' | 'steered'> {
  const { model = luna, prompt } = options
  const response = await fetch(`sessions/${encodeURIComponent(cloud.session)}/turns`, {
    body: JSON.stringify({
      model: model.model,
      prompt,
      provider: model.provider,
      request_id: `steer-${crypto.randomUUID()}`,
      steer: true,
    }),
    headers: headers(cloud, { 'content-type': 'application/json' }),
    method: 'POST',
  })
  if (response.ok) return 'steered'
  if (response.status === 409) return 'queued'
  throw await failure(response)
}

export declare namespace steer {
  type Options = {
    model?: Model | undefined
    prompt: string
  }
}

export async function hand(cloud: Link): Promise<Relay.Access> {
  const path = `sessions/${encodeURIComponent(cloud.session)}/hands`
  const response = await fetch(path, { headers: headers(cloud), method: 'POST' })
  if (!response.ok) throw await failure(response)
  const { token } = (await response.json()) as { token: string }
  return { token, url: Relay.socketUrl(`${path}/machine`) }
}

export async function hands(cloud: Link): Promise<string[]> {
  const response = await fetch(`sessions/${encodeURIComponent(cloud.session)}/hands`, {
    cache: 'no-store',
    headers: headers(cloud),
  }).catch(() => undefined)
  if (!response?.ok) return []
  return ((await response.json()) as { hands?: string[] }).hands ?? []
}

export function meter(cloud: Link, options: meter.Options = {}) {
  const { interval = 1000 } = options
  let ledger: Payments.Ledger = { calls: 0, services: [], total: 0n }
  let seen: Record<string, { calls: number; spent: bigint }> | undefined
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined

  async function poll() {
    try {
      const { calls = {}, spent } = await status(cloud)
      const now = Date.now()
      const hosts = new Set([...Object.keys(spent), ...Object.keys(calls)])
      const first = seen === undefined
      const next: Record<string, { calls: number; spent: bigint }> = {}
      let changed = first
      const services = [...ledger.services]
      for (const host of hosts) {
        const current = { calls: calls[host] ?? 0, spent: BigInt(spent[host] ?? '0') }
        next[host] = current
        const before = seen?.[host] ?? { calls: 0, spent: 0n }
        const [domain = host, ...operation] = host.split(' · ')
        const name = [domain.split('.')[0] ?? domain, ...operation].join(' · ')
        const index = services.findIndex((service) => service.name === name)
        const previous = index >= 0 ? services[index]! : { calls: 0, charges: [], name, spent: 0n }
        const amount = current.spent - before.spent
        if (!first && amount === 0n && current.calls === before.calls) continue
        changed = true
        const service: Payments.Service = {
          calls: current.calls,
          charges: [
            ...previous.charges.filter((item) => now - item.at < 30_000),
            ...(first || amount <= 0n ? [] : [{ amount, at: now }]),
          ],
          name,
          spent: current.spent,
        }
        if (index >= 0) services[index] = service
        else services.push(service)
      }
      seen = next
      if (changed) {
        ledger = {
          calls: services.reduce((sum, service) => sum + service.calls, 0),
          services,
          total: services.reduce((sum, service) => sum + service.spent, 0n),
        }
        for (const listener of listeners) listener()
      }
    } catch {}
    if (listeners.size) timer = setTimeout(poll, interval)
  }

  return {
    ledger: () => ledger,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) void poll()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) clearTimeout(timer)
      }
    },
  }
}

export declare namespace meter {
  type Options = {
    interval?: number | undefined
  }
}

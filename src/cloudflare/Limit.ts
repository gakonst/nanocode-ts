/**
 * Rate limit of public requests: a Durable Object per client that admits a fixed number of requests
 * in each window, and the key of a client address.
 *
 * @module
 */
import { DurableObject } from 'cloudflare:workers'

/** Requests that one client may make in each window. */
export const publicRequests = 30

/** Length of a window in milliseconds. */
export const publicWindowMs = 60_000

type Window = { start: number; count: number }

/** Durable Object that counts the requests of one client in the current window. */
export class PublicLimit extends DurableObject {
  /** Counts one request, and returns whether the window admits it. */
  async admit(): Promise<boolean> {
    const now = Date.now()
    const saved = await this.ctx.storage.get<Window>('window')
    const window = saved && now - saved.start < publicWindowMs ? saved : { start: now, count: 0 }
    if (window.count >= publicRequests) return false

    await this.ctx.storage.put(
      'window',
      { start: window.start, count: window.count + 1 },
      { allowUnconfirmed: true },
    )
    return true
  }
}

/** Returns the rate-limit key of a client address: an IPv4 address, or the `/64` of an IPv6 one. */
export function client(address: string): string {
  if (!address.includes(':')) return address

  const [head, tail] = address.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  return `${groups.slice(0, 4).join(':')}::/64`
}

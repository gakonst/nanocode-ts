import { DurableObject } from 'cloudflare:workers'

export const publicRequests = 30

export const publicWindowMs = 60_000

type Window = { start: number; count: number }

export class PublicLimit extends DurableObject {
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

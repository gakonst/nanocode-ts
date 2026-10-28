import { DurableObject } from 'cloudflare:workers'

import type * as Contracts from '../Contracts.ts'

type Entry = { value: string; expires: number }

export class McpListings extends DurableObject {
  async read(key: string): Promise<string | null> {
    const entry = await this.ctx.storage.get<Entry>(key)
    if (!entry || entry.expires < Date.now()) return null
    return entry.value
  }

  async write(key: string, value: string, ttlMs: number): Promise<void> {
    await this.ctx.storage.put(key, { value, expires: Date.now() + ttlMs } satisfies Entry, {
      allowUnconfirmed: true,
    })
  }
}

export function store(namespace: DurableObjectNamespace<McpListings>): Contracts.McpStore {
  const listings = () => namespace.get(namespace.idFromName('listings'))
  return {
    get: (key) => listings().read(key),
    put: (key, value, ttlMs) => listings().write(key, value, ttlMs),
  }
}

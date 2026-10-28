/**
 * MCP listings shared by every session of a deployment: a Durable Object that keeps them, and the
 * `Contracts.McpStore` that reads and writes it.
 *
 * @module
 */
import { DurableObject } from 'cloudflare:workers'

import type * as Contracts from '../Contracts.ts'

type Entry = { value: string; expires: number }

/** Durable Object that keeps the MCP listings of a deployment until they expire. */
export class McpListings extends DurableObject {
  /** Returns the listing stored under `key`, or `null` when none is stored or it expired. */
  async read(key: string): Promise<string | null> {
    const entry = await this.ctx.storage.get<Entry>(key)
    if (!entry || entry.expires < Date.now()) return null
    return entry.value
  }

  /** Stores `value` under `key` for `ttlMs`. */
  async write(key: string, value: string, ttlMs: number): Promise<void> {
    await this.ctx.storage.put(key, { value, expires: Date.now() + ttlMs } satisfies Entry, {
      allowUnconfirmed: true,
    })
  }
}

/**
 * Returns the store of `namespace`'s one `McpListings` object, so that sessions in other isolates
 * open without asking their MCP servers for their listings again.
 */
export function store(namespace: DurableObjectNamespace<McpListings>): Contracts.McpStore {
  const listings = () => namespace.get(namespace.idFromName('listings'))
  return {
    get: (key) => listings().read(key),
    put: (key, value, ttlMs) => listings().write(key, value, ttlMs),
  }
}

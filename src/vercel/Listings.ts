import type * as Contracts from '../Contracts.ts'

export type Cache = {
  get(key: string): Promise<unknown>
  set(key: string, value: string, options: { ttl: number }): Promise<void>
}

export function store(cache: Cache): Contracts.McpStore {
  return {
    get: async (key) => {
      const value = await cache.get(key)
      return typeof value === 'string' ? value : null
    },
    put: (key, value, ttlMs) => cache.set(key, value, { ttl: Math.ceil(ttlMs / 1000) }),
  }
}

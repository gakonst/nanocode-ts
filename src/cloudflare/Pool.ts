import { DurableObject } from 'cloudflare:workers'

export type Env = {
  SESSIONS: DurableObjectNamespace
  SESSION_LOCATION_HINT?: DurableObjectLocationHint
  SESSION_POOL_KEEPALIVE_MS: string
  SESSION_POOL_SIZE: string
}

export class SessionPool extends DurableObject<Env> {
  private starting = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, id TEXT NOT NULL) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS legacy (id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS ready (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS sealed (at INTEGER NOT NULL)',
    )
  }

  async alarm(): Promise<void> {
    const ready = this.ctx.storage.sql
      .exec<{ id: string }>('SELECT id FROM ready')
      .toArray()
      .map((row) => row.id)
    const started = await Promise.all(ready.map((id) => this.start(id)))
    ready.forEach((id, index) => {
      if (!started[index]) this.ctx.storage.sql.exec('DELETE FROM ready WHERE id = ?', id)
    })

    await this.refill()
    await this.ctx.storage.setAlarm(
      Date.now() + positive(this.env.SESSION_POOL_KEEPALIVE_MS, 'SESSION_POOL_KEEPALIVE_MS'),
    )
  }

  async resolve(key: string): Promise<string> {
    const sql = this.ctx.storage.sql
    const bound = sql
      .exec<{ id: string }>('SELECT id FROM bindings WHERE key = ?', key)
      .toArray()[0]
    if (bound) return bound.id

    const named = this.env.SESSIONS.idFromName(key).toString()
    const id = (() => {
      if (!this.sealed()) return named
      if (sql.exec('SELECT 1 FROM legacy WHERE id = ?', named).toArray().length) return named
      const ready = sql
        .exec<{ id: string }>('SELECT id FROM ready ORDER BY at LIMIT 1')
        .toArray()[0]
      if (!ready) return named
      sql.exec('DELETE FROM ready WHERE id = ?', ready.id)
      return ready.id
    })()
    sql.exec('INSERT INTO bindings (key, id) VALUES (?, ?)', key, id)

    if (this.sealed()) this.ctx.waitUntil(this.refill())
    return id
  }

  async seal(ids: readonly string[]): Promise<number> {
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) sql.exec('INSERT OR IGNORE INTO legacy (id) VALUES (?)', id)
      if (!this.sealed()) sql.exec('INSERT INTO sealed (at) VALUES (?)', Date.now())
    })

    await this.refill()
    return sql.exec('SELECT 1 FROM ready').toArray().length
  }

  private async refill(): Promise<void> {
    const size = positive(this.env.SESSION_POOL_SIZE, 'SESSION_POOL_SIZE')
    const sql = this.ctx.storage.sql
    const ids = Array.from(
      { length: size - this.starting - sql.exec('SELECT 1 FROM ready').toArray().length },
      () => this.env.SESSIONS.newUniqueId().toString(),
    )
    this.starting += ids.length
    const started = await Promise.all(ids.map((id) => this.start(id))).finally(() => {
      this.starting -= ids.length
    })
    ids.forEach((id, index) => {
      if (started[index]) sql.exec('INSERT INTO ready (id, at) VALUES (?, ?)', id, Date.now())
    })
    if (ids.length > 0 && !started.some(Boolean))
      throw new Error('no pooled session object started')

    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(
        Date.now() + positive(this.env.SESSION_POOL_KEEPALIVE_MS, 'SESSION_POOL_KEEPALIVE_MS'),
      )
  }

  private sealed(): boolean {
    return this.ctx.storage.sql.exec('SELECT 1 FROM sealed').toArray().length > 0
  }

  private async start(id: string): Promise<boolean> {
    const response = await this.env.SESSIONS.get(this.env.SESSIONS.idFromString(id), {
      locationHint: this.env.SESSION_LOCATION_HINT,
    })
      .fetch('https://session.internal/internal/prestart', { method: 'POST' })
      .catch(() => undefined)
    await response?.body?.cancel()
    return response?.status === 204
  }
}

export function resolve(
  namespace: DurableObjectNamespace<SessionPool>,
  options: resolve.Options,
): Promise<string> {
  return namespace
    .get(namespace.idFromName('pool'), { locationHint: options.locationHint })
    .resolve(options.key)
}

export declare namespace resolve {
  type Options = {
    key: string
    locationHint?: DurableObjectLocationHint | undefined
  }
}

function positive(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`${name} must be a positive integer`)
  return number
}

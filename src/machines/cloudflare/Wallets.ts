import { DurableObject } from 'cloudflare:workers'
import * as GitHub from '../../bash/GitHub.ts'
import type * as App from '../../cloudflare/App.ts'
import {
  create as createAccount,
  type Account,
  envelope,
  json,
  type KeyRecord,
  type Store,
} from '../Account.ts'
import * as Mcp from '../Mcp.ts'
import * as Payment from '../Payment.ts'
import * as Env from './Env.ts'
import * as Keys from './internal/Keys.ts'

function kvStore(kv: SyncKvStorage): Store {
  return {
    get: async <T>(key: string) => kv.get<T>(key),
    put: async (key, value) => kv.put(key, value),
    delete: async (key) => kv.delete(key),
    list: async <T>(prefix: string) => [...kv.list<T>({ prefix })],
    update: async <T>(key: string, change: (value: T | undefined) => T) => {
      const next = change(kv.get<T>(key))
      kv.put(key, next)
      return next
    },
  }
}

export class Wallet extends DurableObject<Env.Env> {
  protected servers: readonly Mcp.Server[] = Mcp.servers
  protected scripts = true
  private holder?: Account

  private core(): Account {
    this.holder ??= createAccount({
      store: kvStore(this.ctx.storage.kv),
      secret: this.env.KEY_SECRET,
      servers: this.servers,
      scripts: this.scripts,
      ...(this.env.TEMPO_RPC ? { rpc: this.env.TEMPO_RPC } : {}),
    })
    return this.holder
  }

  register(record: KeyRecord, issue = true) {
    return this.core().register(record, issue)
  }
  authenticate(hash: string) {
    return this.core().authenticate(hash)
  }
  status() {
    return this.core().status()
  }
  logout() {
    return this.core().logout()
  }
  setSecret(name: string, value: string | null) {
    return this.core().setSecret(name, value)
  }
  secretNames() {
    return this.core().secretNames()
  }
  secrets(names: string[]) {
    return this.core().secrets(names)
  }
  files(session: string) {
    return this.core().files(session)
  }
  allFiles() {
    return this.core().allFiles()
  }
  readFile(session: string, path: string) {
    return this.core().readFile(session, path)
  }
  writeFile(session: string, path: string, content: string) {
    return this.core().writeFile(session, path, content)
  }
  deleteFile(session: string, path: string) {
    return this.core().deleteFile(session, path)
  }

  async fetch(request: Request): Promise<Response> {
    const parsed = await envelope(request, this.servers)
    if (!parsed) return json({ error: 'not_found' }, 404)
    return this.core().send(parsed.kind, parsed.target, parsed.init)
  }
}

export function subclass(options: subclass.Options): typeof Wallet {
  const scripts = options.scripts ?? true
  return class extends Wallet {
    protected override servers = options.servers
    protected override scripts = scripts
  }
}

export declare namespace subclass {
  type Options = {
    scripts?: boolean | undefined
    servers: readonly Mcp.Server[]
  }
}

export function create<E extends Env.Env>(options: create.Options<E>) {
  const { servers } = Payment.resolve({ inference: 'apiKey', ...options.payment })
  const scripts = options.scripts ?? false
  const handlers = Keys.handlers<E>(options.account)
  const nanocode: Pick<App.create.Options<E>, 'codeMode' | 'mcp'> = {
    ...(scripts
      ? {
          codeMode: {
            fetch: (authority: App.SessionAuthority, env: E) =>
              Env.paying(env, { account: authority.account_id }),
          },
        }
      : { codeMode: { fetch: () => GitHub.archives() } }),
    ...(servers.length
      ? {
          mcp: {
            servers: [...servers],
            fetch: (authority: App.SessionAuthority, env: E) =>
              Env.paying(env, { account: authority.account_id }),
          },
        }
      : {}),
  }

  async function fetch(request: Request, env: E): Promise<Response | undefined> {
    const { pathname } = new URL(request.url)
    return Keys.relay(request, pathname) ?? Keys.routes(handlers, request, env, pathname)
  }

  return { Wallet: subclass({ scripts, servers }), fetch, nanocode, servers, scripts }
}

export declare namespace create {
  type Options<E extends Env.Env> = {
    account: Keys.Account<E>
    payment?: Payment.Config
    scripts?: boolean
  }
}

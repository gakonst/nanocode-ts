/**
 * Wallets of nanocode machines: the `Wallet` Durable Object that holds an account's keys, secrets,
 * and files and pays for its requests, and a Worker that serves only wallets.
 *
 * @module
 */
import { DurableObject } from 'cloudflare:workers'
import { githubArchives } from '../../bash/index.ts'
import type * as App from '../../cloudflare/App.ts'
import { account, type Account, envelope, json, type KeyRecord, type Store } from '../account.ts'
import * as Mcp from '../mcp.ts'
import * as Payment from '../payment.ts'
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

/** Durable Object of one account's wallet. Its methods serve the RPC of the machines Worker. */
export class Wallet extends DurableObject<Env.Env> {
  protected servers: readonly Mcp.Server[] = Mcp.servers
  protected scripts = true
  private holder?: Account

  private core(): Account {
    this.holder ??= account({
      store: kvStore(this.ctx.storage.kv),
      secret: this.env.KEY_SECRET,
      servers: this.servers,
      scripts: this.scripts,
      ...(this.env.TEMPO_RPC ? { rpc: this.env.TEMPO_RPC } : {}),
    })
    return this.holder
  }

  /** Registers a key, and returns a new token unless `issue` is `false`. */
  register(record: KeyRecord, issue = true) {
    return this.core().register(record, issue)
  }
  /** Returns the expiry in milliseconds of the token whose hash is `hash`, or `null`. */
  authenticate(hash: string) {
    return this.core().authenticate(hash)
  }
  /** Returns the wallet address, the access key expiry, and the spend per service. */
  status() {
    return this.core().status()
  }
  /** Deletes the key and its tokens, and returns whether a key existed. */
  logout() {
    return this.core().logout()
  }
  /** Stores a secret, or deletes it when `value` is `null`. */
  setSecret(name: string, value: string | null) {
    return this.core().setSecret(name, value)
  }
  /** Returns the names of the secrets. */
  secretNames() {
    return this.core().secretNames()
  }
  /** Returns the values of the named secrets that exist. */
  secrets(names: string[]) {
    return this.core().secrets(names)
  }
  /** Returns the paths and sizes of the files of `session`. */
  files(session: string) {
    return this.core().files(session)
  }
  /** Returns the files of every session. */
  allFiles() {
    return this.core().allFiles()
  }
  /** Returns the content of a file, or `undefined` when it does not exist. */
  readFile(session: string, path: string) {
    return this.core().readFile(session, path)
  }
  /** Writes a file. */
  writeFile(session: string, path: string, content: string) {
    return this.core().writeFile(session, path, content)
  }
  /** Deletes a file, and returns whether it existed. */
  deleteFile(session: string, path: string) {
    return this.core().deleteFile(session, path)
  }

  /** Sends a paid request that the envelope of `request` describes. */
  async fetch(request: Request): Promise<Response> {
    const parsed = await envelope(request, this.servers)
    if (!parsed) return json({ error: 'not_found' }, 404)
    return this.core().send(parsed.kind, parsed.target, parsed.init)
  }
}

/** Returns a `Wallet` class that pays for `options.servers` and runs scripts per `options.scripts`. */
export function subclass(options: subclass.Options): typeof Wallet {
  const scripts = options.scripts ?? true
  return class extends Wallet {
    protected override servers = options.servers
    protected override scripts = scripts
  }
}

export declare namespace subclass {
  type Options = {
    /** Whether Code Mode scripts may pay with the wallet. Defaults to `true`. */
    scripts?: boolean | undefined
    /** MCP servers that the wallet pays for. */
    servers: readonly Mcp.Server[]
  }
}

/**
 * Returns the `Wallet` class and the Worker handler of a wallet-only deployment, with the runtime
 * options that route Code Mode and MCP payments through the wallets.
 */
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
      : { codeMode: { fetch: () => githubArchives() } }),
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
    /** Returns the account of a request from the host's own authentication. */
    account: Keys.Account<E>
    /** Payment configuration of tools and MCP servers. */
    payment?: Payment.Config
    /** Whether Code Mode scripts may pay with the wallet. Defaults to `false`. */
    scripts?: boolean
  }
}

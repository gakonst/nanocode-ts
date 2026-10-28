/**
 * Bindings of a nanocode machines Worker, and the wallet of an account that pays for its requests.
 *
 * @module
 */
import type * as App from '../../cloudflare/App.ts'
import * as Egress from '../../internal/Egress.ts'
import { forward } from '../account.ts'
import type { Wallet } from './Wallets.ts'

/** Bindings and variables of a nanocode machines Worker. */
export type Env = App.Env & {
  /** Namespace of the `Wallet` Durable Object. */
  WALLETS: DurableObjectNamespace<Wallet>
  /** Secret that seals the keys of the wallets. */
  KEY_SECRET: string
  /** Tempo RPC URL. Defaults to the public Tempo RPC. */
  TEMPO_RPC?: string
  /** Static assets of the site. */
  ASSETS?: Fetcher
}

/** Returns the wallet stub of `options.account`. */
export function wallet(env: Env, options: wallet.Options) {
  return env.WALLETS.get(env.WALLETS.idFromName(options.account.toLowerCase()))
}

export declare namespace wallet {
  type Options = {
    /** Account address of the wallet, in any letter case. */
    account: string
  }
}

/** Returns a `fetch` whose requests the wallet of `options.account` pays for. */
export function paying(env: Env, options: paying.Options): typeof fetch {
  return Egress.mark((input, init) =>
    forward((request) => wallet(env, options).fetch(request), input, init),
  )
}

export declare namespace paying {
  type Options = {
    /** Account address of the paying wallet. */
    account: string
  }
}

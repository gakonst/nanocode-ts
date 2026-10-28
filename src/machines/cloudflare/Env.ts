import type * as App from '../../cloudflare/App.ts'
import * as Egress from '../../internal/Egress.ts'
import { forward } from '../Account.ts'
import type { Wallet } from './Wallets.ts'

export type Env = App.Env & {
  WALLETS: DurableObjectNamespace<Wallet>
  KEY_SECRET: string
  TEMPO_RPC?: string
  ASSETS?: Fetcher
}

export function wallet(env: Env, options: wallet.Options) {
  return env.WALLETS.get(env.WALLETS.idFromName(options.account.toLowerCase()))
}

export declare namespace wallet {
  type Options = {
    account: string
  }
}

export function paying(env: Env, options: paying.Options): typeof fetch {
  return Egress.mark((input, init) =>
    forward((request) => wallet(env, options).fetch(request), { init, input }),
  )
}

export declare namespace paying {
  type Options = {
    account: string
  }
}

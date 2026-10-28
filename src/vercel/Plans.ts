import type { Store } from 'nanocode-egress'
import { Egress, Redis } from 'nanocode-egress/vercel'
import * as Client from '../client/Plans.ts'
import type * as Harness from './Harness.ts'

export type Options = {
  store?: Store.Store
  secret?: string
  prefix?: string
  account?(request: Request): string | null | undefined | Promise<string | null | undefined>
}

export type Routes = {
  GET(request: Request): Promise<Response>
  POST(request: Request): Promise<Response>
  DELETE(request: Request): Promise<Response>
}

export function create(options: Options, account: Options['account']): create.ReturnType {
  const owner = options.account ?? account
  if (!owner) throw new Error('plans need an account: pass App.create an account, or plans one')
  let accounts: ReturnType<typeof Egress.plans> | undefined
  const plans = (name: string) => {
    accounts ??= Egress.plans({ store: options.store ?? Redis.store(), secret: options.secret })
    return accounts(name)
  }
  const routes = Egress.routes({ plans, account: owner, prefix: options.prefix ?? '/api/plans' })
  const handle = async (request: Request) =>
    (await routes(request)) ?? Response.json({ error: 'plan route not found' }, { status: 404 })
  const subscription = Egress.subscription(plans)
  return {
    subscription: async (session) =>
      Client.serves(session.provider, session.model) ? await subscription(session) : undefined,
    routes: { GET: handle, POST: handle, DELETE: handle },
  }
}

export declare namespace create {
  type ReturnType = {
    subscription: NonNullable<Harness.create.Options['subscription']>
    routes: Routes
  }
}

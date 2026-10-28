/**
 * ChatGPT and Claude plans of a Vercel deployment's accounts: the `subscription` that sends a signed-in account's
 * model requests on its plan, and the sign-in route handlers, over nanocode-egress's sealed record store.
 *
 * @module
 */
import type { Store } from 'nanocode-egress'
import { Egress, Redis } from 'nanocode-egress/vercel'
import type * as Harness from './Harness.ts'

/** Plans of a deployment, as `App.create` takes them. */
export type Options = {
  /** Store of the sealed plan records. Defaults to Upstash Redis through `KV_REST_API_URL` and `KV_REST_API_TOKEN`. */
  store?: Store.Store
  /** Secret of at least 32 characters that seals the records. Defaults to `PLAN_SECRET`. */
  secret?: string
  /** Path of the sign-in routes. Defaults to `/api/plans`, the route `app/api/plans/[[...path]]/route.ts` serves. */
  prefix?: string
  /**
   * Returns the account whose plans a request signs in and uses, the same one its sessions run as, or `null` to
   * refuse it. Defaults to `App.create`'s `account`. Return `null` for an account that several people share.
   */
  account?(request: Request): string | null | undefined | Promise<string | null | undefined>
}

/** Route handlers of the sign-in routes. */
export type Routes = {
  GET(request: Request): Promise<Response>
  POST(request: Request): Promise<Response>
  DELETE(request: Request): Promise<Response>
}

/**
 * Returns the `subscription` of the harness and the sign-in route handlers of `options`. The store and the secret are
 * read when the first request needs them, so a build without them still loads the module.
 */
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
  return {
    subscription: Egress.subscription(plans),
    routes: { GET: handle, POST: handle, DELETE: handle },
  }
}

export declare namespace create {
  type ReturnType = {
    /** `subscription` of the harness: the session's plan while its account is signed in. */
    subscription: NonNullable<Harness.create.Options['subscription']>
    /** Route handlers of the sign-in routes. */
    routes: Routes
  }
}

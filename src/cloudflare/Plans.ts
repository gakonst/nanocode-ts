/**
 * ChatGPT and Claude plans of a Cloudflare deployment's accounts: the egress that sends a signed-in account's model
 * requests on its plan, the `subscription` switch, and the sign-in routes under `/plans`, over nanocode-egress's
 * `PlanVault` and `RelayContainer`.
 *
 * @module
 */
import { Egress, PlanVault } from 'nanocode-egress/cloudflare'
import { RelayContainer, relay } from 'nanocode-egress/cloudflare/container'

export { PlanVault, RelayContainer }

/** Bindings and variables of a Worker whose accounts use their plans. */
export type Env = {
  /** Secret of at least 32 characters that seals plan credentials and derives the relay container's secret. */
  PLAN_SECRET: string
}

/** Private binding of model requests, as `App.create`'s `egress` returns it. */
export type PrivateBinding = { fetch(request: Request): Promise<Response> }

/** Plans of a deployment, as `App.create` takes them. */
export type Options<E> = {
  /** Returns the namespace of the `PlanVault` Durable Object, one object per account. */
  vault(env: E): DurableObjectNamespace<PlanVault>
  /**
   * Returns the namespace of the `RelayContainer`, which ChatGPT plans need because chatgpt.com refuses requests
   * from Workers. Without it, ChatGPT-plan requests fail with a message that names it; Claude plans need none.
   */
  relay?(env: E): DurableObjectNamespace<RelayContainer>
  /**
   * Returns the account whose plans a request signs in and uses, the same one its sessions run as, or `null` to
   * refuse it. Defaults to `authenticate`'s account unless it is read-only. Return `null` for an account that
   * several people share, so that one person's plan never serves another.
   */
  account?(request: Request, env: E): string | null | undefined | Promise<string | null | undefined>
}

/** Account that `App.create`'s `authenticate` returns. */
type Authenticated = string | { account: string; read_only?: boolean } | null

/** Returns the egress, the `subscription` switch and the sign-in routes of `options`. */
export function create<E extends Env>(
  options: Options<E> & {
    egress(env: E): PrivateBinding
    authenticate(request: Request, env: E): Promise<Authenticated> | Authenticated
  },
) {
  const plans = Egress.durable<E>((env) => options.vault(env) as never)
  const account =
    options.account ??
    (async (request: Request, env: E) => {
      const principal = await options.authenticate(request, env)
      if (!principal || (typeof principal === 'object' && principal.read_only)) return null
      return typeof principal === 'string' ? principal : principal.account
    })
  return {
    egress: Egress.binding<E>({
      plans,
      fallback: options.egress,
      relay: (env) => {
        const namespace = options.relay?.(env)
        return namespace ? relay(namespace, { secret: env.PLAN_SECRET }) : undefined
      },
    }),
    subscription: Egress.subscription<E>({ plans }),
    routes: Egress.routes<E>({ plans, account }),
  }
}

import { Egress, PlanVault } from 'nanocode-egress/cloudflare'
import { RelayContainer, relay } from 'nanocode-egress/cloudflare/container'

export { PlanVault, RelayContainer }

export type Env = {
  PLAN_SECRET: string
}

export type PrivateBinding = { fetch(request: Request): Promise<Response> }

export type Options<E> = {
  vault(env: E): DurableObjectNamespace<PlanVault>
  relay?(env: E): DurableObjectNamespace<RelayContainer>
  account?(request: Request, env: E): string | null | undefined | Promise<string | null | undefined>
}

type Authenticated = string | { account: string; read_only?: boolean } | null

export type Provider = 'claude' | 'codex'

export function create<E extends Env>(
  options: Options<E> & {
    egress(env: E): PrivateBinding
    authenticate(request: Request, env: E): Promise<Authenticated> | Authenticated
  },
): create.ReturnType<E> {
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

export declare namespace create {
  type ReturnType<E> = {
    egress(env: E): PrivateBinding
    subscription(account: string, env: E, provider: Provider): Promise<boolean>
    routes(request: Request, env: E): Promise<Response | undefined>
  }
}

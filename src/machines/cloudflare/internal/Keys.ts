import { device, type Holder, keys } from '../../Account.ts'
import * as Env from '../Env.ts'

export type Account<E> = (
  request: Request,
  env: E,
) => Promise<string | null | undefined> | string | null | undefined

export function handlers<E extends Env.Env>(account?: Account<E>) {
  return keys<E>({
    holder: (owner, env) => Env.wallet(env, { account: owner }) as unknown as Holder,
    rpc: (env) => env.TEMPO_RPC,
    extra: async (owner, env) => ({
      secrets: await Env.wallet(env, { account: owner }).secretNames(),
    }),
    ...(account ? { account } : {}),
  })
}

export type Handlers<E extends Env.Env> = ReturnType<typeof handlers<E>>

export async function routes<E extends Env.Env>(
  keys: Handlers<E>,
  request: Request,
  env: E,
  pathname: string,
): Promise<Response | undefined> {
  if (pathname === '/v1/keys' && request.method === 'POST') return keys.register(request, env)
  if (pathname === '/v1/keys' && request.method === 'DELETE') return keys.logout(request, env)
  if ((pathname === '/v1/me' || pathname === '/v1/keys') && request.method === 'GET')
    return keys.me(request, env)
  return undefined
}

export function relay(request: Request, pathname: string): Promise<Response> | undefined {
  if (
    request.method !== 'POST' ||
    (pathname !== '/api/device/register' && pathname !== '/api/device/token')
  )
    return undefined
  return device(request, pathname.slice('/api/device/'.length))
}

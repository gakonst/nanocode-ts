import { mark } from "../../egress.ts";
import type { NanocodeEnv } from "../../cloudflare/runtime.ts";
import { forward, json } from "../account.ts";
import type { Wallet } from "./wallet.ts";

export { json };

export interface MachinesEnv extends NanocodeEnv {
  WALLETS: DurableObjectNamespace<Wallet>;
  KEY_SECRET: string;
  TEMPO_RPC?: string;
  ASSETS?: Fetcher;
}

export function wallet(env: MachinesEnv, account: string) {
  return env.WALLETS.get(env.WALLETS.idFromName(account.toLowerCase()));
}

export function paying(env: MachinesEnv, account: string): typeof fetch {
  return mark((input, init) => forward(request => wallet(env, account).fetch(request), input, init));
}

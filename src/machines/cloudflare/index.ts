import { createNanocode, type NanocodeOptions } from "../../cloudflare/runtime.ts";
import { type Address, isAddressEqual, isHex } from "viem";
import { Account, Actions, createClient, http } from "viem/tempo";
import { tempo } from "viem/tempo/chains";
import * as Payment from "../payment.ts";
import { egress } from "./egress.ts";
import { json, type MachinesEnv, paying, wallet } from "./env.ts";
import { tools } from "./tools.ts";
import { digest, type KeyRecord, RPC, walletClass } from "./wallet.ts";

export { egress, PROXIES } from "./egress.ts";
export { json, type MachinesEnv, paying, wallet } from "./env.ts";
export { tools } from "./tools.ts";
export { digest, type KeyRecord, MACH, RPC, Wallet, walletClass } from "./wallet.ts";

const TOKEN = /^(0x[0-9a-f]{40})\.[0-9a-f]{64}$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

export async function principal(request: Request, env: MachinesEnv) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : new URL(request.url).searchParams.get("token") ?? "";
  const match = TOKEN.exec(token);
  if (!match) return null;
  const expires = await wallet(env, match[1]!).authenticate(await digest(token));
  return expires ? { account: match[1]!, expires_at: expires } : null;
}

export async function register(request: Request, env: MachinesEnv): Promise<Response> {
  const body = await request.json().catch(() => undefined) as { address?: string; key_type?: string; private_key?: string } | undefined;
  const address = body?.address;
  const key = body?.private_key;
  const types: ("secp256k1" | "p256")[] = body?.key_type === "p256" ? ["p256"] : body?.key_type === "secp256k1" ? ["secp256k1"] : ["secp256k1", "p256"];
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || !key || !isHex(key) || key.length !== 66) return json({ error: "send {address, private_key, key_type?: secp256k1 | p256}" }, 400);
  const client = createClient({ chain: tempo, transport: http(RPC) });
  let found: { keyType: "secp256k1" | "p256"; keyAddress: Address; expiry: bigint; spendPolicy: string } | undefined;
  for (const keyType of types) {
    const keyAddress = (keyType === "p256" ? Account.fromP256(key, { access: address as Address }) : Account.fromSecp256k1(key, { access: address as Address })).accessKeyAddress;
    const metadata = await Actions.accessKey.getMetadata(client, { account: address as Address, accessKey: keyAddress }).catch(() => undefined);
    if (metadata && isAddressEqual(metadata.address, keyAddress) && !metadata.isRevoked) {
      found = { keyType, keyAddress, expiry: metadata.expiry, spendPolicy: metadata.spendPolicy };
      break;
    }
  }
  if (!found) return json({ error: `this key is not an active access key of ${address} on Tempo; publish it first` }, 403);
  const { keyType, keyAddress, spendPolicy } = found;
  const metadata = { expiry: found.expiry, spendPolicy };
  const expiry = Number(metadata.expiry);
  if (expiry * 1000 <= Date.now()) return json({ error: "the access key has expired" }, 403);
  const record: KeyRecord = { address: address.toLowerCase() as Address, keyAddress, keyType, key, expiry };
  const token = await wallet(env, address).register(record);
  return json({ token, address: record.address, key_address: keyAddress, expires_at: expiry * 1000, spend_policy: metadata.spendPolicy });
}

export async function api(request: Request, env: MachinesEnv, pathname: string): Promise<Response> {
  if (pathname === "/v1/keys" && request.method === "POST") return register(request, env);
  const caller = await principal(request, env);
  if (!caller) return json({ error: "send Authorization: Bearer <token> from POST /v1/keys" }, 401);
  const stub = wallet(env, caller.account);
  if (pathname === "/v1/me" && request.method === "GET") return json({ ...(await stub.status()), secrets: await stub.secretNames() });
  const secret = /^\/v1\/secrets\/([^/]+)$/.exec(pathname);
  if (secret) {
    const name = decodeURIComponent(secret[1]!);
    if (!SECRET_NAME.test(name)) return json({ error: "secret names are [A-Z_][A-Z0-9_]{0,63}" }, 400);
    if (request.method === "DELETE") return await stub.setSecret(name, null), json({ deleted: name });
    if (request.method !== "PUT") return json({ error: "PUT or DELETE" }, 405);
    const value = (await request.json().catch(() => undefined) as { value?: unknown } | undefined)?.value;
    if (typeof value !== "string" || !value || value.length > 8192) return json({ error: "send {value}" }, 400);
    await stub.setSecret(name, value);
    return json({ stored: name });
  }
  if (pathname === "/v1/files" && request.method === "GET") return json({ sessions: await stub.allFiles() });
  const file = /^\/v1\/files\/([^/]+)\/(.+)$/.exec(pathname);
  if (file && request.method === "GET") {
    const content = await stub.readFile(decodeURIComponent(file[1]!), decodeURIComponent(file[2]!));
    return content === undefined ? json({ error: "no such file" }, 404) : new Response(content, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  return json({ error: "not_found" }, 404);
}

const DEVICE = "https://wallet.tempo.xyz/api/auth/device";

const ARCHIVE = /^\/api\/github\/([\w.-]+)\/([\w.-]+)\/(.+)$/;

async function archive(pathname: string): Promise<Response> {
  const match = ARCHIVE.exec(pathname);
  if (!match) return json({ error: "use /api/github/OWNER/REPO/REF" }, 404);
  const upstream = await fetch(`https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${match[3]}`, { headers: { "user-agent": "nanocode-machines-web" } });
  return new Response(upstream.body, { headers: { "cache-control": "public, max-age=300", "content-type": upstream.headers.get("content-type") ?? "application/x-gzip" }, status: upstream.status });
}

async function relay(request: Request, pathname: string): Promise<Response> {
  const response = await fetch(`${DEVICE}${pathname.slice("/api/device".length)}`, {
    body: await request.text(),
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "POST",
  });
  return new Response(response.body, { headers: { "cache-control": "no-store", "content-type": response.headers.get("content-type") ?? "application/json" }, status: response.status });
}

export type MachinesOptions<E extends MachinesEnv> = Partial<NanocodeOptions<E>> & {
  payment?: Payment.Config;
  fallback?(request: Request, env: E): Promise<Response> | Response;
};

export function createMachines<E extends MachinesEnv = MachinesEnv>(options: MachinesOptions<E> = {}) {
  const { fallback, payment, ...rest } = options;
  const { inference, servers, tools: paid } = Payment.resolve(payment);
  if (inference === "apiKey" && !rest.egress) throw new Error("payment.inference apiKey needs the host's egress");
  const nanocode = createNanocode<E>({
    authenticate: principal,
    egress,
    tools,
    subagents: true,
    streamToolInput: true,
    codeMode: paid === "tempo" ? { fetch: (authority, env) => paying(env, authority.account_id) } : {},
    ...(servers.length ? { mcp: { servers: [...servers], fetch: (authority: { account_id: string }, env: E) => paying(env, authority.account_id) } } : {}),
    ...rest,
  });

  async function fetch(request: Request, env: E): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && (pathname === "/api/device/register" || pathname === "/api/device/token")) return relay(request, pathname);
    if (request.method === "GET" && pathname.startsWith("/api/github/")) return archive(pathname);
    if (pathname.startsWith("/v1/")) return api(request, env, pathname);
    if (pathname.startsWith("/sessions/") || pathname === "/health") return nanocode.fetch(request, env);
    if (fallback) return fallback(request, env);
    return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "not_found" }, 404);
  }

  return { AgentSession: nanocode.AgentSession, Wallet: walletClass(servers), fetch, nanocode };
}

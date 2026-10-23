import { DurableObject } from "cloudflare:workers";
import { createJsonChannelStore, Mppx, tempo as payments } from "mppx/client";
import { type Address, type Hex, isAddressEqual } from "viem";
import { Account, createClient, http } from "viem/tempo";
import { tempo } from "viem/tempo/chains";
import * as Mcp from "../mcp.ts";
import * as Payment from "../payment.ts";
import type { MachinesEnv } from "./env.ts";

export const MACH: Address = "0x20c000000000000000000000f37de3740adec032";
export const RPC = "https://rpc.tempo.xyz";
const OPENING = "200000";
const TOP_UP = "0.2";
const MAX_DEPOSIT = "2";
const FILE_LIMIT = 1_000_000;

export type KeyRecord = { address: Address; keyAddress: Address; keyType: "secp256k1" | "p256"; key: Hex; expiry: number };

type Payer = { fetch: (input: string, init: RequestInit & { context?: unknown }) => Promise<Response> };

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function digest(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export class Wallet extends DurableObject<MachinesEnv> {
  protected servers: readonly Mcp.Server[] = Mcp.servers;
  private payer?: Payer;
  private sealing?: Promise<CryptoKey>;

  private secretKey(): Promise<CryptoKey> {
    this.sealing ??= (async () => {
      if (!this.env.KEY_SECRET || this.env.KEY_SECRET.length < 32) throw new Error("KEY_SECRET is not set");
      const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.env.KEY_SECRET), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("nanocode-machines-cloud"), info: new TextEncoder().encode("wallet-v1") }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    })();
    return this.sealing;
  }

  private async seal(text: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.secretKey(), new TextEncoder().encode(text));
    return `${hex(iv)}.${hex(sealed)}`;
  }

  private async open(value: string): Promise<string> {
    const [iv, sealed] = value.split(".").map(part => Uint8Array.from(part!.match(/../g)!, byte => parseInt(byte, 16)));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv! }, await this.secretKey(), sealed!));
  }

  private async record(): Promise<KeyRecord | undefined> {
    const sealed = this.ctx.storage.kv.get<string>("key");
    if (!sealed) return undefined;
    const record = JSON.parse(await this.open(sealed)) as KeyRecord;
    return record.expiry * 1000 > Date.now() ? record : undefined;
  }

  async register(record: KeyRecord): Promise<string> {
    const current = await this.record();
    if (current && !isAddressEqual(current.address, record.address)) throw new Error("this wallet object belongs to another account");
    this.ctx.storage.kv.put("key", await this.seal(JSON.stringify(record)));
    this.payer = undefined;
    const token = `${record.address.toLowerCase()}.${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
    this.ctx.storage.kv.put(`token:${await digest(token)}`, record.expiry);
    return token;
  }

  async authenticate(hash: string): Promise<number | null> {
    const expiry = this.ctx.storage.kv.get<number>(`token:${hash}`);
    if (!expiry || expiry * 1000 <= Date.now()) return null;
    const record = await this.record();
    return record ? Math.min(expiry, record.expiry) * 1000 : null;
  }

  async status() {
    const record = await this.record();
    const spent: Record<string, string> = {};
    for (const [key, value] of this.ctx.storage.kv.list<string>({ prefix: "spent:" })) spent[key.slice("spent:".length)] = value;
    const calls: Record<string, number> = {};
    for (const [key, value] of this.ctx.storage.kv.list<number>({ prefix: "calls:" })) calls[key.slice("calls:".length)] = value;
    return record ? { address: record.address, key_address: record.keyAddress, key_type: record.keyType, expires_at: record.expiry * 1000, spent, calls } : { spent, calls };
  }

  async setSecret(name: string, value: string | null) {
    if (value === null) this.ctx.storage.kv.delete(`secret:${name}`);
    else this.ctx.storage.kv.put(`secret:${name}`, await this.seal(value));
  }

  async secretNames(): Promise<string[]> {
    return [...this.ctx.storage.kv.list({ prefix: "secret:" })].map(([key]) => key.slice("secret:".length));
  }

  async secrets(names: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of names) {
      const sealed = this.ctx.storage.kv.get<string>(`secret:${name}`);
      if (sealed) out[name] = await this.open(sealed);
    }
    return out;
  }

  files(session: string): { path: string; chars: number }[] {
    const prefix = `file:${session}:`;
    return [...this.ctx.storage.kv.list<string>({ prefix })].map(([key, value]) => ({ path: key.slice(prefix.length), chars: value.length }));
  }

  allFiles(): Record<string, { path: string; chars: number }[]> {
    const out: Record<string, { path: string; chars: number }[]> = {};
    for (const [key, value] of this.ctx.storage.kv.list<string>({ prefix: "file:" })) {
      const [, session, ...rest] = key.split(":");
      (out[session!] ??= []).push({ path: rest.join(":"), chars: value.length });
    }
    return out;
  }

  readFile(session: string, path: string): string | undefined {
    return this.ctx.storage.kv.get<string>(`file:${session}:${path}`);
  }

  writeFile(session: string, path: string, content: string) {
    if (content.length > FILE_LIMIT) throw new Error(`files are limited to ${FILE_LIMIT} characters`);
    this.ctx.storage.kv.put(`file:${session}:${path}`, content);
  }

  deleteFile(session: string, path: string) {
    return this.ctx.storage.kv.delete(`file:${session}:${path}`);
  }

  private route(url: string) {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  }

  private label(url: string) {
    const description = this.ctx.storage.kv.get<string>(`label:${this.route(url)}`);
    const host = new URL(url).hostname;
    return description ? `${host} · ${description}` : host;
  }

  private describe(url: string, description: string | undefined) {
    if (description) this.ctx.storage.kv.put(`label:${this.route(url)}`, description.slice(0, 80));
  }

  private count(url: string) {
    const key = `calls:${this.label(url)}`;
    this.ctx.storage.kv.put(key, (this.ctx.storage.kv.get<number>(key) ?? 0) + 1);
  }

  private charge(url: string, amount: bigint) {
    if (amount === 0n) return;
    const key = `spent:${this.label(url)}`;
    const total = BigInt(this.ctx.storage.kv.get<string>(key) ?? "0") + amount;
    this.ctx.storage.kv.put(key, (total > 0n ? total : 0n).toString());
  }

  private receipt(url: string, text: string) {
    let parsed: { channelId?: string; intent?: string; spent?: string };
    try { parsed = JSON.parse(text); } catch { return false; }
    if (parsed.intent !== "session" || !parsed.channelId || parsed.spent === undefined) return false;
    const key = `seen:${parsed.channelId}`;
    const before = BigInt(this.ctx.storage.kv.get<string>(key) ?? "0");
    const spent = BigInt(parsed.spent);
    this.ctx.storage.kv.put(key, spent.toString());
    this.charge(url, spent - before);
    return true;
  }

  private async tool(call: Mcp.Call | undefined, response: Response) {
    if (!call) return;
    const result = await Mcp.outcome(response);
    this.describe(call.url, result.description ?? call.challenge?.description);
    if (result.required || !call.challenge) return;
    this.count(call.url);
    if (call.challenge.intent === "charge") return this.charge(call.url, BigInt(call.challenge.request?.amount ?? "0"));
    if (result.receipt) this.receipt(call.url, JSON.stringify(result.receipt));
  }

  private metered(url: string, body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          if (!/^event: ?payment-receipt$/m.test(event)) continue;
          const data = event.match(/^data: ?(.*)$/m)?.[1];
          if (data) this.receipt(url, data);
        }
      },
    }));
  }

  private async pay(): Promise<Payer> {
    if (this.payer) return this.payer;
    const record = await this.record();
    if (!record) throw new Error("no access key is registered for this account, or it expired: connect Tempo Wallet again");
    const account = record.keyType === "p256" ? Account.fromP256(record.key, { access: record.address }) : Account.fromSecp256k1(record.key, { access: record.address });
    const client = createClient({ chain: tempo, transport: http(RPC) });
    const kv = this.ctx.storage.kv;
    const prefix = `channel:${record.keyAddress.toLowerCase()}:`;
    const mppx = Mppx.create({
      fetch: async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (Mcp.server(url, this.servers)) {
          const call = await Mcp.call(input, init);
          const response = await fetch(input, init);
          await this.tool(call, response);
          return response;
        }
        const response = await fetch(input, init);
        if (response.status === 402) {
          this.describe(url, response.headers.get("www-authenticate")?.match(/description="([^"]*)"/)?.[1]);
          return response;
        }
        this.count(url);
        const header = response.headers.get("payment-receipt");
        if (header) this.receipt(url, atob(header.replace(/-/g, "+").replace(/_/g, "/")));
        if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) return response;
        return new Response(this.metered(url, response.body), { headers: response.headers, status: response.status, statusText: response.statusText });
      },
      methods: [
        payments.session({
          account,
          allowedChainIds: [tempo.id],
          channelStore: createJsonChannelStore({
            delete: key => { kv.delete(prefix + key); },
            get: key => kv.get<string>(prefix + key) ?? undefined,
            set: (key, value) => kv.put(prefix + key, value),
          }),
          getClient: () => client,
          maxDeposit: MAX_DEPOSIT,
          topUpAmount: TOP_UP,
        }),
        payments.charge({ account, allowedChainIds: [tempo.id], getClient: () => client }),
      ],
      orderChallenges: candidates => {
        const rank = (candidate: (typeof candidates)[number]) => {
          const request = candidate.challenge.request as { currency?: Address; methodDetails?: { machineTokenEnabled?: boolean } };
          const isMach = !!request.currency && isAddressEqual(request.currency, MACH);
          if (candidate.challenge.intent === "session") return isMach ? 0 : -1;
          if (candidate.challenge.intent !== "charge") return -1;
          if (request.methodDetails?.machineTokenEnabled === true) return 1;
          return isMach ? 2 : -1;
        };
        return candidates.filter(candidate => rank(candidate) >= 0).sort((a, b) => rank(a) - rank(b)).slice(0, 1);
      },
      polyfill: false,
    });
    mppx.onPaymentResponse(payment => {
      const url = String(payment.input instanceof Request ? payment.input.url : payment.input);
      if (Mcp.server(url, this.servers)) return;
      this.describe(url, (payment.challenge as { description?: string }).description);
      if (payment.challenge.intent !== "charge") return;
      const request = payment.challenge.request as { amount?: string };
      this.charge(url, BigInt(request.amount ?? "0"));
    });
    this.payer = { fetch: (input, init) => mppx.fetch(input, init as never) };
    return this.payer;
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const target = request.headers.get("x-target");
    if (!target || (pathname !== "/model" && pathname !== "/pay")) return Response.json({ error: "not_found" }, { status: 404 });
    const headers = JSON.parse(request.headers.get("x-headers") ?? "[]") as [string, string][];
    const method = request.headers.get("x-method") ?? request.method;
    const body = method === "GET" || method === "HEAD" ? undefined : Mcp.server(target, this.servers) ? await request.text() : await request.arrayBuffer();
    if (pathname === "/pay" && !(await this.record())) return Payment.locked(this.servers)(target, { method, headers, body, signal: request.signal });
    try {
      const payer = await this.pay();
      return await payer.fetch(target, { method, headers, body, signal: request.signal, context: { depositRaw: OPENING } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json(pathname === "/model" ? { type: "error", error: { type: "payment_error", message } } : { error: message }, { status: 402 });
    }
  }
}

export function walletClass(servers: readonly Mcp.Server[]): typeof Wallet {
  return class extends Wallet {
    protected override servers = servers;
  };
}

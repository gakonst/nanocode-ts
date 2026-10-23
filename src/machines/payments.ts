import { createJsonChannelStore, Mppx, tempo as payments } from "mppx/client";
import { type Address, isAddressEqual } from "viem";
import * as Mcp from "./mcp.ts";
import * as Wallet from "./wallet.ts";

const topUp = "0.05";
const opening = "50000";
const maxDeposit = "0.5";

export const window = 30_000;

const send = globalThis.fetch.bind(globalThis);

export type Service = { calls: number; charges: readonly { amount: bigint; at: number }[]; name: string; spent: bigint };

export type Ledger = { calls: number; services: readonly Service[]; total: bigint };

export function create(connected: Wallet.Wallet, options: { servers?: readonly Mcp.Server[] } = {}) {
  const servers = options.servers ?? Mcp.servers;
  const account = Wallet.signer(connected);
  const client = Wallet.reader();
  const prefix = `nanocode.machines.${connected.keyAddress.toLowerCase()}.`;
  let ledger: Ledger = { calls: 0, services: [], total: 0n };
  const listeners = new Set<() => void>();

  const labels = new Map<string, string>();

  function route(url: string) {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  }

  function charge(url: string, amount: bigint, paid: boolean) {
    if (amount === 0n && !paid) return;
    const host = new URL(url).hostname.split(".")[0] ?? url;
    const description = labels.get(route(url));
    const name = description ? `${host} · ${description}` : host;
    const now = Date.now();
    const found = ledger.services.find(service => service.name === name);
    const previous = found ?? { calls: 0, charges: [], name, spent: 0n };
    const next: Service = {
      calls: previous.calls + (paid ? 1 : 0),
      charges: [...previous.charges.filter(item => now - item.at < window), ...(amount > 0n ? [{ amount, at: now }] : [])],
      name,
      spent: previous.spent + amount > 0n ? previous.spent + amount : 0n,
    };
    ledger = {
      calls: ledger.calls + (paid ? 1 : 0),
      services: found ? ledger.services.map(service => (service === found ? next : service)) : [...ledger.services, next],
      total: ledger.total + amount,
    };
    for (const listener of listeners) listener();
  }

  function receipt(origin: string, text: string, paid: boolean) {
    let parsed: { channelId?: string; intent?: string; spent?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    if (parsed.intent !== "session" || !parsed.channelId || parsed.spent === undefined) return false;
    const key = `${prefix}spent.${parsed.channelId}`;
    const before = BigInt(localStorage.getItem(key) ?? "0");
    const spent = BigInt(parsed.spent);
    localStorage.setItem(key, spent.toString());
    charge(origin, spent - before, paid);
    return true;
  }

  async function tool(call: Mcp.Call | undefined, response: Response) {
    if (!call) return;
    const result = await Mcp.outcome(response);
    const description = result.description ?? call.challenge?.description;
    if (description) labels.set(route(call.url), description.slice(0, 80));
    if (result.required || !call.challenge) return;
    if (call.challenge.intent === "charge") return charge(call.url, BigInt(call.challenge.request?.amount ?? "0"), true);
    if (!result.receipt || !receipt(call.url, JSON.stringify(result.receipt), true)) charge(call.url, 0n, true);
  }

  function metered(origin: string, body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          if (!/^event: ?payment-receipt$/m.test(event)) continue;
          const data = event.match(/^data: ?(.*)$/m)?.[1];
          if (data) receipt(origin, data, false);
        }
      },
    }));
  }

  const mppx = Mppx.create({
    fetch: async (input, init) => {
      const origin = String(input instanceof Request ? input.url : input);
      if (Mcp.server(origin, servers)) {
        const call = await Mcp.call(input, init);
        const response = await send(input, Mcp.crossOrigin(init));
        await tool(call, response);
        return response;
      }
      const response = await send(input, init);
      const description = response.status === 402 ? response.headers.get("www-authenticate")?.match(/description="([^"]*)"/)?.[1] : undefined;
      if (description) labels.set(route(origin), description.slice(0, 80));
      const header = response.headers.get("payment-receipt");
      if (header) receipt(origin, atob(header.replace(/-/g, "+").replace(/_/g, "/")), true);
      if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) return response;
      const wrapped = new Response(metered(origin, response.body), { headers: response.headers, status: response.status, statusText: response.statusText });
      return Object.defineProperty(wrapped, "url", { value: response.url });
    },
    methods: [
      payments.session({
        account,
        allowedChainIds: [Wallet.mach.chainId],
        channelStore: createJsonChannelStore({
          delete: key => localStorage.removeItem(prefix + key),
          get: key => localStorage.getItem(prefix + key) ?? undefined,
          set: (key, value) => localStorage.setItem(prefix + key, value),
        }),
        getClient: () => client,
        maxDeposit,
        topUpAmount: topUp,
      }),
      payments.charge({ account, allowedChainIds: [Wallet.mach.chainId], getClient: () => client }),
    ],
    orderChallenges: candidates => {
      const rank = (candidate: (typeof candidates)[number]) => {
        const request = candidate.challenge.request as { currency?: Address; methodDetails?: { machineTokenEnabled?: boolean } };
        const isMach = !!request.currency && isAddressEqual(request.currency, Wallet.mach.address);
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
    const origin = String(payment.input instanceof Request ? payment.input.url : payment.input);
    if (payment.challenge.intent !== "charge" || Mcp.server(origin, servers)) return;
    const request = payment.challenge.request as { amount?: string };
    charge(origin, BigInt(request.amount ?? "0"), true);
  });

  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => mppx.fetch(input, { ...init, context: { depositRaw: opening } })) as typeof fetch,
    ledger: () => ledger,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type Payments = ReturnType<typeof create>;

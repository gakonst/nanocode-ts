import * as Mcp from "./mcp.ts";

export type Inference = "apiKey" | "tempo";

export type Tools = "tempo" | "off";

export type Config = { inference?: Inference; tools?: Tools; servers?: readonly Mcp.Server[] | false };

export type Payment = { inference: Inference; tools: Tools; servers: readonly Mcp.Server[] };

export const required = "tempo_wallet_required";

export const unlocked: Record<string, string> = { gateway: "gateway storage, AI and compute", mercator: "Mercator's paid APIs" };

export function resolve(config: Config = {}): Payment {
  const inference = config.inference ?? "tempo";
  const tools = config.tools ?? "tempo";
  const servers = tools === "tempo" && config.servers !== false ? config.servers ?? Mcp.servers : [];
  return { inference, servers, tools };
}

export function unlocks(servers: readonly Mcp.Server[], scripts = true) {
  return [...servers.map(server => unlocked[server.name] ?? server.name), ...(scripts ? ["every MPP service a script fetches"] : [])].join(", ");
}

export function explanation(servers: readonly Mcp.Server[], scripts = true) {
  return `${required}: this tool is paid with Tempo machine payments, and the user has not connected a Tempo Wallet, so nothing was paid or done. Tell the user to connect their Tempo Wallet with the Connect button in the chat, which unlocks ${unlocks(servers, scripts)}; then retry the call. Do not retry it before they connect.`;
}

export function needsWallet(text: string | undefined) {
  return Boolean(text?.includes(required));
}

export function locked(servers: readonly Mcp.Server[], send: typeof fetch = globalThis.fetch.bind(globalThis), scripts = true): typeof fetch {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const mcp = Mcp.server(url, servers);
    const response = await send(input, mcp ? Mcp.crossOrigin(init) : init);
    if (response.status === 402) return Response.json({ error: required, message: explanation(servers, scripts) }, { status: 402 });
    if (!mcp) return response;
    const call = await Mcp.call(input, init);
    if (!call || !(await Mcp.outcome(response)).required) return response;
    const id = await response.clone().text().then(text => (JSON.parse(text.match(/^data: ?(.*)$/m)?.[1] ?? text) as { id?: unknown }).id, () => null);
    return Response.json({ id, jsonrpc: "2.0", result: { content: [{ text: explanation(servers, scripts), type: "text" }], isError: true } });
  };
}

const RECEIPT = /^event: ?payment-receipt\r?$/m;
const DATA = /^data: ?(.*?)\r?$/m;
const SEPARATOR = /\r?\n\r?\n/g;
const FINAL = /^(event: ?(response\.(completed|failed|incomplete)|message_stop)|data: ?\[DONE\])\r?$/m;
const DRAIN_MS = 10_000;

export function receipts(body: ReadableStream<Uint8Array>, onReceipt: (data: string) => unknown): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = body.getReader();
  let buffer = "";
  let final = false;
  let pending: Promise<unknown> = Promise.resolve();
  const take = (event: string) => {
    if (FINAL.test(event)) final = true;
    if (!RECEIPT.test(event)) return false;
    const data = DATA.exec(event)?.[1];
    if (data) pending = pending.then(() => onReceipt(data)).catch(() => undefined);
    return true;
  };
  const scan = (chunk: Uint8Array | undefined) => {
    buffer += chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    let out = "";
    let start = 0;
    for (const match of buffer.matchAll(SEPARATOR)) {
      const end = match.index + match[0].length;
      if (!take(buffer.slice(start, match.index))) out += buffer.slice(start, end);
      start = end;
    }
    buffer = buffer.slice(start);
    if (!chunk && buffer && !take(buffer)) out += buffer;
    if (!chunk) buffer = "";
    return out;
  };
  const drain = async () => {
    const timer = setTimeout(() => void reader.cancel().catch(() => undefined), DRAIN_MS);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        scan(value);
      }
      scan(undefined);
    } catch {
    } finally {
      clearTimeout(timer);
    }
    await pending;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          const rest = scan(undefined);
          if (rest) controller.enqueue(encoder.encode(rest));
          await pending;
          controller.close();
          return;
        }
        const out = scan(value);
        if (out) {
          controller.enqueue(encoder.encode(out));
          return;
        }
      }
    },
    cancel(reason) {
      if (final) return drain();
      return reader.cancel(reason);
    },
  });
}

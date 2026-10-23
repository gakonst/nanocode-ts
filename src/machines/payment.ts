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

export function unlocks(servers: readonly Mcp.Server[]) {
  return [...servers.map(server => unlocked[server.name] ?? server.name), "every MPP service a script fetches"].join(", ");
}

export function explanation(servers: readonly Mcp.Server[]) {
  return `${required}: this tool is paid with Tempo machine payments, and the user has not connected a Tempo Wallet, so nothing was paid or done. Tell the user to connect their Tempo Wallet with the Connect button in the chat, which unlocks ${unlocks(servers)}; then retry the call. Do not retry it before they connect.`;
}

export function needsWallet(text: string | undefined) {
  return Boolean(text?.includes(required));
}

export function locked(servers: readonly Mcp.Server[], send: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const mcp = Mcp.server(url, servers);
    const response = await send(input, mcp ? Mcp.crossOrigin(init) : init);
    if (response.status === 402) return Response.json({ error: required, message: explanation(servers) }, { status: 402 });
    if (!mcp) return response;
    const call = await Mcp.call(input, init);
    if (!call || !(await Mcp.outcome(response)).required) return response;
    const id = await response.clone().text().then(text => (JSON.parse(text.match(/^data: ?(.*)$/m)?.[1] ?? text) as { id?: unknown }).id, () => null);
    return Response.json({ id, jsonrpc: "2.0", result: { content: [{ text: explanation(servers), type: "text" }], isError: true } });
  };
}

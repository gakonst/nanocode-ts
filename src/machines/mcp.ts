const decoder = new TextDecoder();

export type Server = { name: string; url: string };

export const servers: readonly Server[] = [
  { name: "mercator", url: "https://mercator.sh/mcp" },
  { name: "gateway", url: "https://gateway.tempo-dev.workers.dev/mcp" },
];

type Challenge = { description?: string; intent?: string; request?: { amount?: string } };

type Message = {
  error?: { code?: number; data?: { challenges?: Challenge[] } };
  method?: string;
  params?: { _meta?: Record<string, { challenge?: Challenge } | undefined>; name?: unknown };
  result?: { _meta?: Record<string, unknown> };
};

export type Call = { challenge?: Challenge; url: string };

export type Outcome = { description?: string; receipt?: { channelId?: string; intent?: string; spent?: string }; required: boolean };

export function server(url: string, list: readonly Server[] = servers) {
  if (!URL.canParse(url)) return false;
  const { origin, pathname } = new URL(url);
  return list.some(entry => entry.url === origin + pathname);
}

function parse(text: string | undefined): Message | undefined {
  try {
    return JSON.parse(text ?? "") as Message;
  } catch {
    return undefined;
  }
}

export async function call(input: RequestInfo | URL, init?: RequestInit): Promise<Call | undefined> {
  const url = String(input instanceof Request ? input.url : input);
  const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  const text = typeof body === "string" ? body : body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? decoder.decode(body) : undefined;
  const message = parse(text);
  if (message?.method !== "tools/call" || typeof message.params?.name !== "string") return undefined;
  return { challenge: message.params._meta?.["org.paymentauth/credential"]?.challenge, url: `${url.replace(/\/$/, "")}/${message.params.name}` };
}

export async function outcome(response: Response): Promise<Outcome> {
  const type = response.headers.get("content-type") ?? "";
  if (!response.body || !(type.includes("json") || type.includes("event-stream"))) return { required: false };
  const text = await response.clone().text().catch(() => "");
  const message = parse(type.includes("event-stream") ? text.match(/^data: ?(.*)$/m)?.[1] : text);
  const required = message?.error?.code === -32042 || message?.error?.code === -32043 ? message.error.data : message?.result?._meta?.["org.paymentauth/payment-required"] as { challenges?: Challenge[] } | undefined;
  return { description: required?.challenges?.[0]?.description, receipt: message?.result?._meta?.["org.paymentauth/receipt"] as Outcome["receipt"], required: !!required };
}

export function body(request: { body: Uint8Array; endpoint: string; method: string }, list: readonly Server[] = servers) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  return server(request.endpoint, list) ? decoder.decode(request.body) : request.body as Uint8Array<ArrayBuffer>;
}

export function crossOrigin(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  headers.delete("accept-payment");
  headers.delete("user-agent");
  return { ...init, headers };
}

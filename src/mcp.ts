import type { McpServer, RuntimeOptions } from "./contracts.ts";

type Request = { provider: unknown; endpoint: string; method: string; headers: [string, string][]; body: Uint8Array };

type Send<R extends Request, A extends unknown[]> = (request: R, signal: AbortSignal, ...rest: A) => Promise<Response>;

type Tool = { name: string; description?: string; inputSchema?: Schema; [key: string]: unknown };

type Schema = { type?: unknown; properties?: Record<string, Schema>; required?: unknown; items?: Schema; enum?: unknown[]; anyOf?: Schema[]; oneOf?: Schema[]; [key: string]: unknown };

type Listing = { at: number; init?: Promise<unknown>; tools?: Promise<Tool[] | undefined>; stateful?: boolean };

export type McpPolicy = NonNullable<RuntimeOptions["mcp"]>;

export const DESCRIBE_TOOLS = "describe_tools";

const DEFAULT_CACHE_MS = 600_000;

const BRIEF_CHARACTERS = 240;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const listings = new Map<string, Listing>();

function key(endpoint: string) {
  const url = new URL(endpoint);
  return url.origin + url.pathname;
}

function message(body: Uint8Array): { id?: unknown; method?: string; params?: { name?: unknown; arguments?: { names?: unknown } } } | undefined {
  try {
    return JSON.parse(decoder.decode(body)) as never;
  } catch {
    return undefined;
  }
}

async function payload(response: Response): Promise<{ result?: unknown; error?: unknown } | undefined> {
  const text = await response.text();
  const json = (response.headers.get("content-type") ?? "").includes("event-stream")
    ? text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean).at(-1)
    : text;
  try {
    return JSON.parse(json ?? "") as never;
  } catch {
    return undefined;
  }
}

function reply(id: unknown, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
}

function brief(text: string | undefined) {
  if (!text) return "";
  let out = "";
  for (const sentence of text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/)) {
    if (out && (out.length >= 60 || out.length + sentence.length > BRIEF_CHARACTERS)) break;
    out = out ? out + " " + sentence : sentence;
  }
  return out.length > BRIEF_CHARACTERS ? out.slice(0, BRIEF_CHARACTERS - 1) + "…" : out;
}

function slim(schema: Schema | undefined): Schema {
  if (!schema || typeof schema !== "object") return {};
  const out: Schema = {};
  if (schema.type !== undefined) out.type = schema.type;
  if (Array.isArray(schema.enum) && JSON.stringify(schema.enum).length <= 160) out.enum = schema.enum;
  if (schema.items && typeof schema.items === "object" && schema.items.type !== undefined) out.items = { type: schema.items.type };
  for (const variant of ["anyOf", "oneOf"] as const) if (Array.isArray(schema[variant])) out[variant] = schema[variant].map(entry => (entry && typeof entry === "object" && entry.type !== undefined ? { type: entry.type } : {}));
  return out;
}

function compact(tool: Tool): Tool {
  const schema = tool.inputSchema ?? {};
  const properties = schema.properties && typeof schema.properties === "object" ? Object.fromEntries(Object.entries(schema.properties).map(([name, value]) => [name, slim(value)])) : undefined;
  return { name: tool.name, description: brief(tool.description), inputSchema: { type: "object", ...(properties ? { properties } : {}), ...(Array.isArray(schema.required) ? { required: schema.required } : {}) } };
}

const describer: Tool = {
  name: DESCRIBE_TOOLS,
  description: "Free and local. Tools here list only a summary and argument names; call this with the names of the tools you will use to get each one's full description and JSON input schema before calling a tool whose arguments or workflow you do not know.",
  inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] },
};

function described(tools: Tool[], names: unknown) {
  const wanted = Array.isArray(names) ? names.map(String) : tools.map(tool => tool.name);
  const found = tools.filter(tool => wanted.includes(tool.name)).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) }));
  const missing = wanted.filter(name => !found.some(tool => tool.name === name));
  const text = JSON.stringify(missing.length ? { tools: found, unknown: missing, available: tools.map(tool => tool.name) } : { tools: found });
  return { content: [{ type: "text", text }], isError: found.length === 0 };
}

export function deferMcp<R extends Request, A extends unknown[]>(send: Send<R, A>, servers: readonly McpServer[] | undefined, policy: McpPolicy = {}): Send<R, A> {
  if (!servers?.length) return send;
  const urls = new Set(servers.map(server => key(server.url)));
  const ttl = policy.cacheMs ?? DEFAULT_CACHE_MS;
  const deferred = policy.deferred ?? true;
  return async (request, signal, ...rest) => {
    if (request.provider != null || request.method !== "POST" || !URL.canParse(request.endpoint) || !urls.has(key(request.endpoint))) return send(request, signal, ...rest);
    const url = key(request.endpoint) + "|" + JSON.stringify(request.headers.filter(([name]) => !/^(mcp-session-id|mcp-protocol-version|content-length|content-type|accept|user-agent|last-event-id)$/i.test(name)).sort());
    const body = message(request.body);
    let listing = listings.get(url);
    if (listing && Date.now() - listing.at > ttl) {
      listings.delete(url);
      listing = undefined;
    }
    if (listing?.stateful) return send(request, signal, ...rest);
    const list = () => {
      const fetched = send({ ...request, body: encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: "nanocode-tools", method: "tools/list", params: {} })) }, new AbortController().signal, ...rest)
        .then(async response => {
          const parsed = response.ok ? await payload(response) as { result?: { tools?: Tool[]; nextCursor?: unknown } } | undefined : undefined;
          return parsed?.result?.tools && !parsed.result.nextCursor ? parsed.result.tools : undefined;
        })
        .catch(() => undefined);
      void fetched.then(tools => { if (!tools && listings.get(url)?.tools === fetched) listings.delete(url); });
      return fetched;
    };
    switch (body?.method) {
      case "initialize": {
        if (listing?.init) {
          const result = await listing.init.catch(() => undefined);
          if (result) return reply(body.id, result);
        }
        const fresh: Listing = { at: Date.now() };
        const response = await send(request, signal, ...rest);
        if (!response.ok || response.headers.has("mcp-session-id")) {
          if (response.headers.has("mcp-session-id")) listings.set(url, { at: Date.now(), stateful: true });
          return response;
        }
        const parsed = await payload(response);
        if (!parsed || parsed.result === undefined) return new Response(JSON.stringify(parsed ?? {}), { status: response.status, headers: { "content-type": "application/json" } });
        fresh.init = Promise.resolve(parsed.result);
        fresh.tools = listing?.tools ?? list();
        listings.set(url, fresh);
        return reply(body.id, parsed.result);
      }
      case "notifications/initialized":
        return listing ? new Response(null, { status: 202 }) : send(request, signal, ...rest);
      case "tools/list": {
        const tools = await (listing?.tools ?? (listings.set(url, listing = { at: Date.now(), tools: list() }), listing.tools));
        if (!tools) return send(request, signal, ...rest);
        return reply(body.id, { tools: deferred ? [...tools.map(compact), describer] : tools });
      }
      case "tools/call": {
        if (!deferred || body.params?.name !== DESCRIBE_TOOLS) return send(request, signal, ...rest);
        const tools = await (listing?.tools ?? list());
        return reply(body.id, tools ? described(tools, body.params.arguments?.names) : { content: [{ type: "text", text: "the server's tool list is unavailable" }], isError: true });
      }
      default:
        return send(request, signal, ...rest);
    }
  };
}

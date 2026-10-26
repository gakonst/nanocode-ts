import type { ModelProvider } from "../index.ts";
import type { ModelDispatch, PrivateBinding } from "./contracts.ts";

const HEADERS: Record<ModelProvider, RegExp> = {
  claude: /^(accept|content-type|anthropic-version|anthropic-beta)$/,
  codex: /^(accept|content-type|x-session-affinity)$/,
};
const RESPONSE_HEADER = /^(content-type|request-id|x-request-id|retry-after|x-should-retry|anthropic-ratelimit-[a-z0-9-]+|x-ratelimit-[a-z0-9-]+|openai-model|openai-processing-ms|cf-aig-[a-z0-9-]+)$/;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function shape(query: unknown): { input_items: number; continued: boolean; model?: unknown; effort?: unknown } {
  const body = typeof query === "object" && query !== null ? query as { input?: unknown; messages?: unknown; previous_response_id?: unknown; model?: unknown; output_config?: { effort?: unknown }; reasoning?: { effort?: unknown }; thinking?: { type?: unknown } } : {};
  const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  return { input_items: items.length, continued: typeof body.previous_response_id === "string", model: body.model, effort: body.output_config?.effort ?? body.reasoning?.effort ?? (body.thinking?.type === "disabled" ? "none" : undefined) };
}

function modelError(provider: ModelProvider, status: number, type: string, message: string): Response {
  if (provider === "codex") return json({ error: { type, message } }, status);
  return json({ type: "error", error: { type, message } }, status);
}

async function firstByte(start: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal, firstByteMs: number): Promise<{ response: Response; first?: Uint8Array; reader?: ReadableStreamDefaultReader<Uint8Array> } | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort("first byte timeout"); resolve(undefined); }, firstByteMs); });
  try {
    return await Promise.race([expired, (async () => {
      const response = await start(controller.signal);
      if (!response.body) return { response };
      const reader = response.body.getReader();
      const chunk = await reader.read();
      return chunk.done ? { response, reader } : { response, first: chunk.value, reader };
    })()]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function replay(first: Uint8Array | undefined, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let pending = first;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending) {
        controller.enqueue(pending);
        pending = undefined;
        return;
      }
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function catalogModel(model: string): string {
  return `anthropic/${model.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
}

async function model(ai: Ai, gateway: string, serviceTier: string, firstByteMs: number, request: Request): Promise<Response> {
  let dispatch: ModelDispatch;
  try { dispatch = JSON.parse(request.headers.get("x-nanocode-model") ?? ""); } catch { return modelError("claude", 400, "invalid_request_error", "invalid model dispatch"); }
  const provider = dispatch.provider ?? "claude";
  const allowed = HEADERS[provider];
  if (!allowed) return modelError("claude", 400, "invalid_request_error", "unsupported model provider");
  if (dispatch.subscription) return modelError(provider, 409, "invalid_request_error", "AI Gateway uses API-key authentication; set MODEL_AUTH to api_key");
  const headers: Record<string, string> = {};
  for (const [name, value] of dispatch.headers) if (allowed.test(name.toLowerCase())) headers[name.toLowerCase()] = value;
  const body = await request.arrayBuffer();
  let query: Record<string, unknown>;
  try { query = JSON.parse(new TextDecoder().decode(body)); } catch { return modelError(provider, 400, "invalid_request_error", "model request body is not JSON"); }
  if (provider === "claude" && typeof query.model !== "string") return modelError(provider, 400, "invalid_request_error", "model request names no model");
  const start = async (signal: AbortSignal): Promise<Response> => {
    if (provider === "claude") {
      const catalog = catalogModel(String(query.model));
      return await ai.run(catalog, { ...query, model: catalog }, { gateway: { id: gateway }, returnRawResponse: true, extraHeaders: headers, signal }) as unknown as Response;
    }
    const gatewayRun = ai.gateway(gateway);
    try {
      const images = /\/(images\/(?:generations|edits))$/.exec(dispatch.endpoint)?.[1];
      return await gatewayRun.run(dispatch.endpoint.endsWith("/chat/completions") ? { provider: "workers-ai", endpoint: "v1/chat/completions", headers, query } : images ? { provider: "openai", endpoint: images, headers, query } : { provider: "openai", endpoint: "responses", headers, query: serviceTier ? { ...query, service_tier: serviceTier } : query }, { signal });
    } finally {
      (gatewayRun as Partial<Disposable>)[Symbol.dispose]?.();
    }
  };
  const started = Date.now();
  const first = await firstByte(start, request.signal, firstByteMs);
  if (!first) {
    const response = modelError(provider, 504, "timeout_error", "the model sent no response within " + Math.round(firstByteMs / 1000) + " s; retrying");
    response.headers.set("x-should-retry", "true");
    response.headers.set("x-nanocode-model-diagnostic", JSON.stringify({ provider, transport: provider === "claude" ? "unified" : "gateway", status: 504, first_byte_timeout_ms: firstByteMs, waited_ms: Date.now() - started, body_bytes: body.byteLength, ...shape(query) }));
    return response;
  }
  const upstream = first.response;
  const forwarded = new Headers({ "cache-control": "no-store" });
  for (const [name, value] of upstream.headers) if (RESPONSE_HEADER.test(name)) forwarded.set(name, value);
  forwarded.set("x-nanocode-model-diagnostic", JSON.stringify({ provider, transport: provider === "claude" ? "unified" : "gateway", status: upstream.status, body_bytes: body.byteLength, ...shape(query) }));
  return new Response(first.reader ? replay(first.first, first.reader) : upstream.body, { status: upstream.status, headers: forwarded });
}

async function warm(ai: Ai, gateway: string, serviceTier: string, request: Request): Promise<Response> {
  let dispatch: { provider?: unknown; model?: unknown };
  try { dispatch = JSON.parse(request.headers.get("x-nanocode-model") ?? ""); } catch { return json({ error: "invalid model dispatch" }, 400); }
  if (typeof dispatch.model !== "string") return json({ error: "warm-up names no model" }, 400);
  let upstream: Response;
  if (dispatch.provider === "codex") {
    const opened = ai.gateway(gateway);
    try {
      upstream = await opened.run({ provider: "openai", endpoint: "responses", headers: { "content-type": "application/json" }, query: { model: dispatch.model, input: "ok", max_output_tokens: 16, reasoning: { effort: "low" }, store: false, ...(serviceTier ? { service_tier: serviceTier } : {}) } });
    } finally {
      (opened as Partial<Disposable>)[Symbol.dispose]?.();
    }
  } else {
    const catalog = catalogModel(dispatch.model);
    upstream = await ai.run(catalog, { model: catalog, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }, { gateway: { id: gateway }, returnRawResponse: true, extraHeaders: { "anthropic-version": "2023-06-01", "content-type": "application/json" } }) as unknown as Response;
  }
  await upstream.body?.cancel();
  return new Response(null, { status: upstream.ok ? 204 : 502, headers: { "cache-control": "no-store" } });
}

export function aiGateway(ai: Ai, gateway: string, serviceTier = "", firstByteMs = 45_000): PrivateBinding {
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === "/model" && request.method === "POST") return model(ai, gateway, serviceTier, firstByteMs, request);
      if (pathname === "/warm" && request.method === "POST") return warm(ai, gateway, serviceTier, request);
      if (pathname === "/socket") return json({ error: { type: "invalid_request_error", message: "AI Gateway carries model requests over HTTPS only" } }, 426);
      if (pathname === "/remote") return json({ error: "this deployment has no remote executors; attach a hand instead" }, 501);
      if (pathname === "/metrics") return json({ ok: true, egress: "ai-gateway" });
      return json({ error: "not_found" }, 404);
    },
  };
}

import type { ModelProvider } from "../index.ts";
import { chatSearch, type SearchQuery, type WebSearch } from "../search.ts";

export type Dispatch = (request: { endpoint: string; method: string; headers: [string, string][]; body: Uint8Array }, signal: AbortSignal) => Promise<Response>;

export const gatewayUrl = () => process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh";

export function gatewayEndpoint(provider: ModelProvider): string {
  return provider === "codex" ? `${gatewayUrl()}/v1` : `${gatewayUrl()}/v1/messages`;
}

export async function gatewayCredential(): Promise<string> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (key) return key;
  const { getVercelOidcToken } = await import("@vercel/oidc");
  try {
    return await getVercelOidcToken();
  } catch (error) {
    throw new Error(`no AI Gateway credential: set AI_GATEWAY_API_KEY, or run \`vercel env pull\` for VERCEL_OIDC_TOKEN (${error instanceof Error ? error.message : String(error)})`);
  }
}

export function gatewayDispatch(credential: () => Promise<string> = gatewayCredential): Dispatch {
  return async (request, signal) => {
    const origin = new URL(gatewayUrl()).origin;
    if (new URL(request.endpoint).origin !== origin) throw new Error(`model request to ${request.endpoint} is not for the AI Gateway at ${origin}`);
    const key = await credential();
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${key}`);
    headers.set("x-api-key", key);
    return fetch(request.endpoint, { method: "POST", headers, body: request.body as Uint8Array<ArrayBuffer>, signal, redirect: "manual" });
  };
}

export type GatewaySearchTool = "parallel" | "perplexity" | "exa" | "tako" | "browserbase";

function searchConfig(tool: GatewaySearchTool, query: SearchQuery): Record<string, unknown> {
  const allowed = query.allowed_domains ?? [];
  const blocked = query.blocked_domains ?? [];
  if (tool === "parallel") return { max_results: 8, ...(allowed.length || blocked.length ? { source_policy: { ...(allowed.length ? { include_domains: allowed } : {}), ...(blocked.length ? { exclude_domains: blocked } : {}) } } : {}) };
  if (tool === "perplexity") return { max_results: 8, ...(allowed.length || blocked.length ? { search_domain_filter: allowed.length ? allowed : blocked.map(domain => "-" + domain) } : {}) };
  if (tool === "exa") return { num_results: 8, ...(allowed.length ? { include_domains: allowed } : {}), ...(blocked.length ? { exclude_domains: blocked } : {}) };
  return {};
}

export function gatewaySearch(options: { tool?: GatewaySearchTool; model?: string; config?: Record<string, unknown>; credential?: () => Promise<string> } = {}): WebSearch {
  const tool = options.tool ?? "parallel";
  const credential = options.credential ?? gatewayCredential;
  return chatSearch({
    model: options.model ?? "openai/gpt-5.4-mini",
    tool: query => ({ type: "vercel:" + tool + "_search", config: { ...searchConfig(tool, query), ...options.config } }),
    post: async (body, signal) => {
      const key = await credential();
      return fetch(gatewayUrl() + "/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(body), signal });
    },
  });
}

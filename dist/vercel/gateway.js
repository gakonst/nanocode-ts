export const gatewayUrl = () => process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh";
export function gatewayEndpoint(provider) {
    return provider === "codex" ? `${gatewayUrl()}/v1` : `${gatewayUrl()}/v1/messages`;
}
export async function gatewayCredential() {
    const key = process.env.AI_GATEWAY_API_KEY;
    if (key)
        return key;
    const { getVercelOidcToken } = await import("@vercel/oidc");
    try {
        return await getVercelOidcToken();
    }
    catch (error) {
        throw new Error(`no AI Gateway credential: set AI_GATEWAY_API_KEY, or run \`vercel env pull\` for VERCEL_OIDC_TOKEN (${error instanceof Error ? error.message : String(error)})`);
    }
}
export function gatewayDispatch(credential = gatewayCredential) {
    return async (request, signal) => {
        const origin = new URL(gatewayUrl()).origin;
        if (new URL(request.endpoint).origin !== origin)
            throw new Error(`model request to ${request.endpoint} is not for the AI Gateway at ${origin}`);
        const key = await credential();
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${key}`);
        headers.set("x-api-key", key);
        return fetch(request.endpoint, { method: "POST", headers, body: request.body, signal, redirect: "manual" });
    };
}

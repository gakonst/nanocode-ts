import type { ModelProvider } from "../index.ts";
export type Dispatch = (request: {
    endpoint: string;
    headers: [string, string][];
    body: Uint8Array;
}, signal: AbortSignal) => Promise<Response>;
export declare const gatewayUrl: () => string;
export declare function gatewayEndpoint(provider: ModelProvider): string;
export declare function gatewayCredential(): Promise<string>;
export declare function gatewayDispatch(credential?: () => Promise<string>): Dispatch;

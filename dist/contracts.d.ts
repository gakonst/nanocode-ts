export type ModelProvider = "claude" | "codex";
export declare function sessionUuid(): string;
export type HostTool = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
};
export type AgentConfiguration = {
    scope: string;
    provider?: ModelProvider;
    model?: string;
    thinking?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
    instructions?: string;
    session_id: string;
    subscription: boolean;
    endpoint: string;
    gateway?: "vercel" | "workers_ai";
    cloudflare_account_id?: string;
    max_tokens?: number;
    remote?: boolean;
    executor?: string;
    hands?: boolean;
    event_coalesce_ms?: number;
    tools?: HostTool[];
};
export type TurnReport = Record<string, unknown> & {
    request_id: string;
    status: string;
};
export declare class HostFailure extends Error {
    readonly kind: string;
    readonly permanent: boolean;
    constructor(message: string, kind: string, permanent: boolean);
}
export declare class RemoteRefusal extends Error {
}
export type TurnView = {
    report: TurnReport;
    first_seq: number;
    last_seq: number | null;
    cancel_requested: boolean;
    metadata: unknown;
};
export type Submitted = {
    submitted: "accepted" | "existing" | "conflict";
    turn: TurnView;
} | {
    submitted: "too_large";
    bytes: number;
    limit: number;
};
export type LoggedEvent = {
    seq: number;
    request_id: string | null;
    created_at: number;
    event: unknown;
};
export type LogPage = {
    events: LoggedEvent[];
    next_cursor: number;
    has_more: boolean;
};
export type Driven = {
    idle?: boolean;
    busy?: boolean;
    waiting?: boolean;
    retry?: boolean;
    request_id?: string;
    resumed?: string;
    finished?: TurnView;
};
export declare const RECENT_MODEL_LIMIT = 64;
export type ModelTiming = {
    dispatch_id: number;
    transport?: "websocket";
    started_ms: number;
    headers_ms?: number;
    first_byte_ms?: number;
    last_byte_ms?: number;
    body_read_wait_ms: number;
    body_reads: number;
    bytes: number;
    max_chunk_gap_ms: number;
    sends?: number;
    duration_ms?: number;
    status?: number;
    outcome?: "eof" | "closed" | "cancelled" | "failed";
    diagnostic?: unknown;
};
export type RuntimeTiming = ModelTiming & {
    runtime_id: string;
};
export type SqlValue = string | number | null | ArrayBuffer;
export type Statement = [string, ...SqlValue[]];
export type SqlKind = "store" | "log";
export interface SqlHost {
    readonly value_limit?: number;
    transaction(kind: SqlKind, operation: string, statements: Statement[]): SqlValue[][][] | Promise<SqlValue[][][]>;
}
export interface MessageSocket {
    send(message: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "message" | "close" | "error", listener: (event: any) => void): void;
}
export type SocketHandshake = {
    status: number;
    headers: Iterable<[string, string]>;
    socket?: MessageSocket;
    idle_ms?: number;
    text(): Promise<string>;
};
export type RemoteRequest = {
    op: string;
    connection?: string | null;
    frames?: string[];
    durable?: boolean;
    dispatches?: boolean;
    reason?: string;
};
export type HostOptions = {
    published(events: LoggedEvent[], bytes: number[]): void;
    wake?(): void;
};
export type RuntimeOptions = {
    dispatch(request: {
        endpoint: string;
        headers: [string, string][];
        body: Uint8Array;
    }, signal: AbortSignal, timing: RuntimeTiming): Promise<Response>;
    finishing?(request_id: string): Record<string, unknown> | Promise<Record<string, unknown>>;
    socket?: {
        open(request: {
            headers: [string, string][];
        }, signal: AbortSignal, timing: RuntimeTiming): Promise<SocketHandshake>;
        admit(): Promise<void>;
    };
    tools?: {
        call(name: string, input: unknown, signal: AbortSignal, context: {
            call_id: string;
        }): Promise<unknown>;
    };
    remote?: {
        failed?(): boolean;
        execute(request: RemoteRequest, id: number): Promise<unknown>;
        cancel(id: number): void;
        dispose(): Promise<void>;
    };
};

import { type Harness, type HostTool, type SessionState } from "durable-harness";
import { type AgentConfiguration, type LoggedEvent, type ModelProvider } from "../index.ts";
import { type Dispatch } from "./gateway.ts";
import { type Durability, type JournalStats } from "./journal.ts";
export declare const SCOPE = "session";
export declare const SESSION_KEY = "nanocode.session";
export declare const WAIT_POLL_MS = 250;
export declare const DEFAULT_EVENT_COALESCE_MS = 50;
export type NanocodeSession = {
    session_id: string;
    provider: ModelProvider;
    model?: string;
    thinking?: AgentConfiguration["thinking"];
};
export type ModelCall = {
    index: number;
    replayed: boolean;
    first_output_ms: number | null;
    duration_ms: number;
    input_tokens: number;
    cached_tokens: number;
    output_tokens: number;
};
export type DriveReport = {
    run_id: string;
    attempt: number;
    durability: Durability;
    opened: boolean;
    duration_ms: number;
    replay_ms: number;
    open_ms: number;
    journal: JournalStats;
    model_requests: number;
    tool_calls: number;
    models: ModelCall[];
    outcome: "idle" | "settled" | "stopped" | "failed";
    error?: string;
};
export interface NanocodeHarnessOptions {
    name?: string;
    provider?: ModelProvider;
    model?: string;
    thinking?: AgentConfiguration["thinking"];
    instructions?: string;
    tools?: HostTool[];
    durability?: Durability;
    dispatch?: Dispatch;
    endpoint?: string;
    gateway?: "vercel";
    eventCoalesceMs?: number;
    module?: () => Promise<WebAssembly.Module>;
    report?: (report: DriveReport) => void;
}
export declare function isIdle(state: SessionState, batches: number): boolean;
export declare function nanocodeHarness(options?: NanocodeHarnessOptions): Harness;
export declare function liveEvent(logged: LoggedEvent): Record<string, unknown> | undefined;

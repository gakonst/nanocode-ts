import type { SessionState } from "durable-harness";
import { type LogPage, type TurnView } from "../index.ts";
export type NanocodeReader = {
    turn(request_id: string): Promise<TurnView | null>;
    page(after: number, limit: number, request_id?: string): Promise<LogPage>;
    close(): Promise<void>;
};
export declare function openReader(state: SessionState, module?: () => Promise<WebAssembly.Module>): Promise<NanocodeReader>;

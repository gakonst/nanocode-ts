import type { LoggedEvent, LogPage } from "./contracts.ts";
type Event = LoggedEvent & {
    [key: string]: unknown;
};
export declare class EventHub {
    private readonly listeners;
    private revision;
    private highest;
    private tail;
    private sizes;
    private bytes;
    private readonly retained;
    private readonly retainedBytes;
    constructor(retained: () => number, retainedBytes: () => number);
    get version(): number;
    notify(): void;
    publish(events: LoggedEvent[], bytes: number[]): void;
    recent(after: number, requestId?: string): LogPage | undefined;
    wait(milliseconds: number, version?: number): Promise<void>;
    stream(after: number, interval: number, read: (after: number) => Promise<LogPage>, finished?: (event: Event) => boolean): Response;
}
export {};

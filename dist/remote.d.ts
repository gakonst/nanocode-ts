import { type MessageSocket, type RemoteRequest } from "./contracts.ts";
export type RemotePolicy = {
    max_frame_bytes: number;
    timeout_ms: number;
};
export declare class RemoteExecutor<S extends MessageSocket = MessageSocket> {
    #private;
    readonly closed: Promise<string>;
    private constructor();
    static accept<S extends MessageSocket>(socket: S, policy: RemotePolicy): RemoteExecutor<S>;
    static restore<S extends MessageSocket>(socket: S, policy: RemotePolicy, catalog: string): RemoteExecutor<S>;
    ready(): Promise<void>;
    static connect<S extends MessageSocket>(open: (signal: AbortSignal) => Promise<S>, policy: RemotePolicy): Promise<RemoteExecutor<S>>;
    get failure(): string | undefined;
    get catalog(): string | undefined;
    get socket(): S;
    disconnected(reason?: string): void;
    reject(reason: string): void;
    refuse(reason: string): void;
    execute(request: RemoteRequest, id: number): Promise<unknown>;
    claim(owner: object): void;
    release(): void;
    owns(owner: object): boolean;
    cancel(id: number): void;
    dispose(): Promise<void>;
    receive(data: unknown): void;
}

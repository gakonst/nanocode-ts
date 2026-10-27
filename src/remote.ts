import { RemoteRefusal, type MessageSocket, type RemoteRequest, type RuntimeOptions } from "./contracts.ts";

export type RemotePolicy = { max_frame_bytes: number; timeout_ms: number; resumes?: boolean };

export const HAND_LEFT = 4001;

export const BRAIN_REPLACED = 4002;

export function bearerProtocols(token: string): string[] {
  return ["bearer", token];
}

export function bearerToken(request: Request): string | undefined {
  const header = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (header) return header;
  const [scheme, token] = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map(value => value.trim());
  return scheme === "bearer" && token ? token : undefined;
}

export function bearerAccepted(request: Request): Record<string, string> {
  return /^\s*bearer\s*,/.test(request.headers.get("sec-websocket-protocol") ?? "") ? { "sec-websocket-protocol": "bearer" } : {};
}

const encoder = new TextEncoder();

function validate(policy: RemotePolicy) {
  for (const key of ["max_frame_bytes", "timeout_ms"] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new Error(`remote ${key} must be a positive integer`);
  }
}

export class RemoteExecutor<S extends MessageSocket = MessageSocket> {
  #socket: S;
  #policy: RemotePolicy;
  #catalog: string | undefined;
  #catalogWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  #frames: string[] = [];
  #waiter: { id: number; resolve(value: unknown): void } | undefined;
  #failure: string | undefined;
  #owner: object | undefined;
  #parked: ReturnType<typeof setTimeout> | undefined;
  #queued: string[] = [];
  #closed!: (reason: string) => void;
  readonly closed = new Promise<string>(resolve => { this.#closed = resolve; });

  private constructor(socket: S, policy: RemotePolicy, listen: boolean) {
    this.#socket = socket;
    this.#policy = policy;
    if (!listen) return;
    socket.addEventListener("message", event => this.receive(event.data));
    socket.addEventListener("close", () => this.disconnected());
    socket.addEventListener("error", () => this.disconnected("runner connection failed"));
  }

  static accept<S extends MessageSocket>(socket: S, policy: RemotePolicy): RemoteExecutor<S> {
    validate(policy);
    return new RemoteExecutor(socket, policy, false);
  }

  static restore<S extends MessageSocket>(socket: S, policy: RemotePolicy, catalog: string): RemoteExecutor<S> {
    const executor = RemoteExecutor.accept(socket, policy);
    executor.#catalog = catalog;
    return executor;
  }

  async ready(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.#catalogReady(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("hand catalog deadline elapsed")), this.#policy.timeout_ms); })]);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error), 1011);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  static async connect<S extends MessageSocket>(open: (signal: AbortSignal) => Promise<S>, policy: RemotePolicy): Promise<RemoteExecutor<S>> {
    validate(policy);
    const controller = new AbortController();
    let expire!: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => { expire = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      expire(new Error("remote executor connection deadline elapsed"));
    }, policy.timeout_ms);
    let executor: RemoteExecutor<S> | undefined;
    try {
      const socket = await Promise.race([open(controller.signal), deadline]);
      executor = new RemoteExecutor(socket, policy, true);
      await Promise.race([executor.#catalogReady(), deadline]);
      return executor;
    } catch (error) {
      if (executor) executor.#fail(error instanceof Error ? error.message : String(error), 1011);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  get failure(): string | undefined {
    return this.#failure;
  }

  host(): NonNullable<RuntimeOptions["remote"]> {
    const owner = {};
    this.claim(owner);
    return {
      failed: () => this.#failure !== undefined,
      execute: async (request, id) => {
        if (this.owns(owner)) return this.execute(request, id);
        if (request.op === "remote_send") throw new RemoteRefusal("hand connection moved to a newer runtime");
        return request.op === "remote_poll" ? { closed: "connection moved to a newer runtime" } : null;
      },
      cancel: id => this.cancel(id),
      dispose: async () => {},
    };
  }

  get catalog(): string | undefined {
    return this.#catalog;
  }

  get socket(): S {
    return this.#socket;
  }

  disconnected(reason = "runner disconnected"): void {
    this.#fail(reason, reason === "runner disconnected" ? 1000 : 1011);
  }

  park(reason = "runner disconnected"): void {
    if (!this.#policy.resumes || this.#catalog === undefined || this.#failure !== undefined) return this.disconnected(reason);
    if (this.#parked !== undefined) return;
    this.#parked = setTimeout(() => this.disconnected(reason), this.#policy.timeout_ms);
  }

  get parked(): boolean {
    return this.#parked !== undefined;
  }

  rebind(socket: S, catalog: string): boolean {
    if (this.#failure !== undefined) return false;
    if (this.#parked !== undefined) clearTimeout(this.#parked);
    this.#parked = undefined;
    this.#socket = socket;
    this.receive(catalog);
    const frames = this.#queued;
    this.#queued = [];
    for (const frame of frames) socket.send(frame);
    return true;
  }

  reject(reason: string): void {
    this.#fail(reason, 1002);
  }

  refuse(reason: string): void {
    this.#fail(reason, 1008, reason);
  }

  async execute(request: RemoteRequest, id: number): Promise<unknown> {
    switch (request.op) {
      case "remote_catalog":
        return { frame: this.#catalog, max_frame_bytes: this.#policy.max_frame_bytes, timeout_ms: this.#policy.timeout_ms, ...(this.#policy.resumes ? { resumes: true } : {}) };
      case "remote_send": {
        if (this.#failure !== undefined) throw new RemoteRefusal(this.#failure);
        const refused = new Set(request.refused);
        if (this.#parked !== undefined) {
          for (const [index, frame] of (request.frames ?? []).entries()) if (!refused.has(index)) this.#queued.push(frame);
          return refused.size ? { refused: [...refused], reason: request.reason } : null;
        }
        let sent = 0;
        try {
          for (const [index, frame] of (request.frames ?? []).entries()) if (!refused.has(index)) { this.#socket.send(frame); sent++; }
        } catch (error) {
          throw sent ? error : new RemoteRefusal(error instanceof Error ? error.message : String(error));
        }
        return refused.size ? { refused: [...refused], reason: request.reason } : null;
      }
      case "remote_poll":
        if (this.#frames.length) return { frames: this.#frames.splice(0) };
        if (this.#failure !== undefined) return { closed: this.#failure };
        if (this.#waiter) throw new Error("remote_poll is already pending");
        return new Promise(resolve => { this.#waiter = { id, resolve }; });
      case "remote_close":
        this.#fail(String(request.reason), 1000);
        return null;
      default:
        throw new Error(`unsupported remote operation ${request.op}`);
    }
  }

  claim(owner: object): void {
    if (this.#owner === owner) return;
    this.#owner = owner;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.resolve({ closed: "connection moved to a newer runtime" });
  }

  release(): void {
    this.#owner = {};
  }

  owns(owner: object): boolean {
    return this.#owner === owner;
  }

  cancel(id: number): void {
    if (this.#waiter?.id !== id) return;
    this.#waiter.resolve(null);
    this.#waiter = undefined;
  }

  async dispose(): Promise<void> {
    this.#fail("remote executor disposed", 1000);
  }

  #catalogReady(): Promise<void> {
    if (this.#catalog !== undefined) return Promise.resolve();
    if (this.#failure !== undefined) return Promise.reject(new Error(this.#failure));
    return new Promise((resolve, reject) => { this.#catalogWaiter = { resolve, reject }; });
  }

  receive(data: unknown): void {
    if (this.#failure !== undefined) return;
    if (typeof data !== "string") return this.#fail("remote code mode requires JSON text frames", 1003);
    if (encoder.encode(data).byteLength > this.#policy.max_frame_bytes) return this.#fail("remote code mode frame exceeds caller max_frame_bytes policy", 1009);
    if (this.#catalog === undefined) {
      this.#catalog = data;
      this.#catalogWaiter?.resolve();
      this.#catalogWaiter = undefined;
      return;
    }
    this.#frames.push(data);
    const waiter = this.#waiter;
    if (!waiter) return;
    this.#waiter = undefined;
    waiter.resolve({ frames: this.#frames.splice(0) });
  }

  #fail(reason: string, code: number, told?: string) {
    if (this.#failure !== undefined) return;
    this.#failure = reason;
    if (this.#parked !== undefined) clearTimeout(this.#parked);
    this.#parked = undefined;
    this.#queued = [];
    this.#closed(reason);
    try { this.#socket.close(code, told); } catch {}
    this.#catalogWaiter?.reject(new Error(reason));
    this.#catalogWaiter = undefined;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.resolve({ closed: reason });
  }
}

import { AgentRuntime } from "./host.ts";
import type { WorkspaceHost } from "./contracts.ts";

export type HandOptions = {
  url: string;
  name?: string;
  workspace: WorkspaceHost & { cwd?: string };
  cwd?: string;
  fetch?(input: string, init: RequestInit): Promise<Response>;
  protocols?: string | string[];
  maxFrameBytes?: number;
  WebSocket?: typeof WebSocket;
  onStatus?(status: HandStatus): void;
};

export type HandStatus = { state: "connecting" | "attached" | "closed"; reason?: string };

export type Hand = { closed: Promise<HandStatus>; close(): void };

const NO_SQL = { transaction() { throw new Error("a hand runs no SQL"); } };

export async function connectHand(module: WebAssembly.Module, options: HandOptions): Promise<Hand> {
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  const runtime = await AgentRuntime.instantiate(module, NO_SQL, { published() {} });
  options.onStatus?.({ state: "connecting" });
  const socket = new Socket(options.url, options.protocols);
  let done!: (status: HandStatus) => void;
  const closed = new Promise<HandStatus>(resolve => { done = resolve; });
  let queue = Promise.resolve();
  const serving = runtime.serveHand({
    workspace: options.workspace,
    cwd: options.cwd ?? "/workspace",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.maxFrameBytes ? { max_frame_bytes: options.maxFrameBytes } : {}),
    send: text => { if (socket.readyState === 1) socket.send(text); },
  });
  socket.addEventListener("open", () => {
    void serving.then(hand => {
      socket.send(hand.catalog);
      options.onStatus?.({ state: "attached" });
    });
  });
  socket.addEventListener("message", event => {
    const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
    queue = queue.then(async () => (await serving).receive(text)).catch(() => {});
  });
  const finish = (reason: string) => {
    void serving.then(hand => hand.closed()).finally(() => void runtime.dispose().catch(() => {}));
    const status: HandStatus = { state: "closed", reason };
    options.onStatus?.(status);
    done(status);
  };
  socket.addEventListener("close", event => finish(event.reason || "closed with code " + event.code));
  socket.addEventListener("error", () => finish("the connection failed"));
  return { closed, close: () => socket.close(1000, "the hand closed") };
}


import { AgentRuntime } from "./host.ts";
import type { HostTool, McpServer, RuntimeOptions, WorkspaceHost } from "./contracts.ts";

export type HandOptions = {
  url: string;
  name?: string;
  workspace: WorkspaceHost;
  cwd?: string;
  fetch?(input: string, init: RequestInit): Promise<Response>;
  tools?: { definitions: HostTool[]; call(name: string, input: unknown, signal: AbortSignal): Promise<unknown> };
  mcpServers?: McpServer[];
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
  const send = options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
  const dispatch: RuntimeOptions["dispatch"] = (request, signal) => send(request.endpoint, { method: request.method, headers: request.headers, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body as Uint8Array<ArrayBuffer> }), signal });
  options.onStatus?.({ state: "connecting" });
  let done!: (status: HandStatus) => void;
  const closed = new Promise<HandStatus>(resolve => { done = resolve; });
  let finished = false;
  let socket: WebSocket | undefined;
  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    void runtime.dispose().catch(() => {});
    const status: HandStatus = { state: "closed", reason };
    options.onStatus?.(status);
    done(status);
  };
  const serving = runtime.serveHand({
    workspace: options.workspace,
    cwd: options.cwd ?? "/workspace",
    fetch: send,
    dispatch,
    ...(options.tools ? { tools: { definitions: options.tools.definitions, call: (name, input, signal) => options.tools!.call(name, input, signal) } } : {}),
    ...(options.mcpServers?.length ? { mcp_servers: options.mcpServers } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.maxFrameBytes ? { max_frame_bytes: options.maxFrameBytes } : {}),
    send: text => { if (socket?.readyState === 1) socket.send(text); },
  });
  let hand: Awaited<typeof serving>;
  try {
    hand = await serving;
  } catch (error) {
    finish(error instanceof Error ? error.message : String(error));
    throw error;
  }
  socket = new Socket(options.url, options.protocols);
  let queue = Promise.resolve();
  const opened = new Promise<void>((resolve, reject) => {
    socket!.addEventListener("open", () => {
      socket!.send(hand.catalog);
      options.onStatus?.({ state: "attached" });
      resolve();
    });
    void closed.then(status => reject(new Error(status.reason ?? "the hand closed")));
  });
  socket.addEventListener("message", event => {
    const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
    queue = queue.then(() => hand.receive(text)).catch(() => {});
  });
  socket.addEventListener("close", event => {
    void hand.closed().catch(() => {});
    finish(event.reason || "closed with code " + event.code);
  });
  socket.addEventListener("error", () => finish("the connection failed"));
  await opened;
  return { closed, close: () => socket!.close(1000, "the hand closed") };
}

export type HandKeeperOptions = Omit<HandOptions, "url" | "workspace" | "cwd"> & {
  url(session: string): string;
  listed?(session: string): Promise<boolean>;
  module(): Promise<WebAssembly.Module>;
  workspace(session: string): Promise<{ workspace: WorkspaceHost; cwd: string }>;
  name?: string;
  attachMs?: number;
};

export function handKeeper(options: HandKeeperOptions) {
  const name = options.name ?? "browser";
  let current: { session: string; hand: Promise<Hand | undefined>; open: boolean } | undefined;
  const listeners = new Set<(status: HandStatus & { session?: string }) => void>();
  let status: HandStatus & { session?: string } = { state: "closed" };
  const emit = (next: HandStatus & { session?: string }) => {
    status = next;
    options.onStatus?.(next);
    for (const listener of listeners) listener(next);
  };
  const open = (session: string) => {
    const entry = { session, open: false, hand: undefined as unknown as Promise<Hand | undefined> };
    entry.hand = (async () => {
      const [module, place] = await Promise.all([options.module(), options.workspace(session)]);
      const hand = await connectHand(module, { ...options, name, url: options.url(session), workspace: place.workspace, cwd: place.cwd, onStatus: next => {
        entry.open = next.state === "attached";
        if (current === entry) emit({ ...next, session });
      } });
      const deadline = Date.now() + (options.attachMs ?? 5000);
      while (options.listed && Date.now() < deadline && entry.open && !(await options.listed(session).catch(() => false))) await new Promise(resolve => setTimeout(resolve, 150));
      return hand;
    })().catch(error => {
      if (current === entry) emit({ state: "closed", reason: error instanceof Error ? error.message : String(error), session });
      return undefined;
    });
    current = entry;
    return entry;
  };
  return {
    name,
    status: () => status,
    subscribe(listener: (status: HandStatus & { session?: string }) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async attach(session: string): Promise<string | undefined> {
      if (current?.session !== session) {
        void current?.hand.then(hand => hand?.close());
        open(session);
      } else if (!current.open) {
        const settled = await current.hand;
        if (!current.open) {
          settled?.close();
          open(session);
        }
      }
      const entry = current!;
      const hand = await entry.hand;
      return hand && entry.open ? name : undefined;
    },
    close() {
      void current?.hand.then(hand => hand?.close());
      current = undefined;
    },
  };
}


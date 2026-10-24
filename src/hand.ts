import { serverEvents } from "./client.ts";
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
  transport?: "websocket" | "stream";
  reconnectMs?: number;
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
  let link: { send(text: string): void; close(): void } | undefined;
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
    send: text => link?.send(text),
  });
  let hand: Awaited<typeof serving>;
  try {
    hand = await serving;
  } catch (error) {
    finish(error instanceof Error ? error.message : String(error));
    throw error;
  }
  let queue = Promise.resolve();
  const receive = (text: string) => {
    queue = queue.then(() => hand.receive(text)).catch(() => {});
  };
  const gone = (reason: string) => {
    void hand.closed().catch(() => {});
    finish(reason);
  };
  if (options.transport === "stream") {
    link = await streamLink(options, hand.catalog, receive, gone, closed);
    options.onStatus?.({ state: "attached" });
    return { closed, close: () => link!.close() };
  }
  const socket = new Socket(options.url, options.protocols);
  link = { send: text => { if (socket.readyState === 1) socket.send(text); }, close: () => socket.close(1000, "the hand closed") };
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(hand.catalog);
      options.onStatus?.({ state: "attached" });
      resolve();
    });
    void closed.then(status => reject(new Error(status.reason ?? "the hand closed")));
  });
  socket.addEventListener("message", event => receive(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)));
  socket.addEventListener("close", event => gone(event.reason || "closed with code " + event.code));
  socket.addEventListener("error", () => finish("the connection failed"));
  await opened;
  return { closed, close: () => link!.close() };
}

async function streamLink(options: HandOptions, catalog: string, receive: (text: string) => void, gone: (reason: string) => void, closed: Promise<HandStatus>) {
  const connection = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const reconnectMs = options.reconnectMs ?? 500;
  const stop = new AbortController();
  let ended = false;
  void closed.then(() => { ended = true; stop.abort(); });
  const post = (body: Record<string, unknown>, keepalive = false) => globalThis.fetch(options.url, Object.assign({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, connection }) }, keepalive ? { keepalive } : { signal: stop.signal }));
  const attached = await post({ catalog });
  if (!attached.ok) {
    const reason = attached.status + " " + await attached.text();
    gone(reason);
    throw new Error(reason);
  }
  let brain: string | undefined;
  let cursor = 0;
  let pending: string[] = [];
  let sending = Promise.resolve();
  const flush = () => {
    const frames = pending;
    pending = [];
    if (!frames.length || ended) return;
    sending = sending.then(async () => {
      const response = await post({ brain, frames });
      if (!response.ok) throw new Error(response.status + " " + await response.text());
    }).catch((error: unknown) => {
      if (!ended) gone(error instanceof Error ? error.message : String(error));
    });
  };
  const close = () => {
    if (ended) return;
    ended = true;
    stop.abort();
    void post({ close: true }, true).catch(() => {});
    gone("the hand closed");
  };
  const target = globalThis as { addEventListener?(type: string, listener: () => void): void };
  target.addEventListener?.("pagehide", close);
  void (async () => {
    while (!ended) {
      try {
        const separator = options.url.includes("?") ? "&" : "?";
        const response = await globalThis.fetch(options.url + separator + new URLSearchParams({ connection, cursor: String(cursor) }), { headers: { accept: "text/event-stream" }, signal: stop.signal });
        if (response.status >= 400 && response.status < 500) {
          gone(response.status + " " + await response.text());
          return;
        }
        if (response.ok && response.body) {
          for await (const message of serverEvents(response.body)) {
            if (message.id) cursor = Number(message.id);
            if (!message.data) continue;
            const line = JSON.parse(message.data) as { brain?: string; frames?: string[] };
            if (line.brain) brain = line.brain;
            for (const frame of line.frames ?? []) receive(frame);
          }
        }
      } catch {}
      if (!ended) await new Promise(resolve => setTimeout(resolve, reconnectMs));
    }
  })();
  return {
    send(text: string) {
      if (!pending.length) queueMicrotask(flush);
      pending.push(text);
    },
    close,
  };
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


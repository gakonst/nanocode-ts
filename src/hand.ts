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
  batchMs?: number;
  onStatus?(status: HandStatus): void;
};

export type HandStatus = { state: "connecting" | "attached" | "closed"; reason?: string };

export type Hand = { closed: Promise<HandStatus>; close(): void };

export type PreparedHand = { cwd: string; connect(url: string, onStatus?: (status: HandStatus) => void): Promise<Hand>; dispose(): void };

const NO_SQL = { transaction() { throw new Error("a hand runs no SQL"); } };

type ModuleCache = { match(key: string): Promise<Response | undefined>; put(key: string, response: Response): Promise<void>; delete(key: string | Request): Promise<boolean>; keys(): Promise<readonly Request[]> };

type Compiler = { compileStreaming(source: Response): Promise<WebAssembly.Module>; compile(bytes: ArrayBuffer): Promise<WebAssembly.Module> };

export async function compileModule(url: string, options: { cache?: string | false; key?: string } = {}): Promise<WebAssembly.Module> {
  const key = options.key ? url + (url.includes("?") ? "&" : "?") + "nanocode-key=" + encodeURIComponent(options.key) : url;
  const caches = options.cache === false ? undefined : (globalThis as { caches?: { open(name: string): Promise<ModuleCache> } }).caches;
  const store = await caches?.open(options.cache || "nanocode-wasm").catch(() => undefined);
  const compiler = WebAssembly as unknown as Compiler;
  const compile = async (response: Response) => {
    if (!response.ok) throw new Error(url + " answered " + response.status);
    if (response.headers.get("content-type")?.startsWith("application/wasm")) return compiler.compileStreaming(response);
    return compiler.compile(await response.arrayBuffer());
  };
  const hit = await store?.match(key).catch(() => undefined);
  if (hit) {
    try {
      return await compile(hit);
    } catch {
      await store!.delete(key).catch(() => false);
    }
  }
  const response = await fetch(url);
  if (store && response.ok) {
    const copy = response.clone();
    const stored = new Request(key).url;
    void store.put(key, copy).then(async () => {
      for (const request of await store.keys()) if (request.url !== stored) await store.delete(request);
    }).catch(() => {});
  }
  return compile(response);
}

export async function prepareHand(module: WebAssembly.Module, options: Omit<HandOptions, "url" | "onStatus">): Promise<PreparedHand> {
  const runtime = await AgentRuntime.instantiate(module, NO_SQL, { published() {} });
  const send = options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
  const dispatch: RuntimeOptions["dispatch"] = (request, signal) => send(request.endpoint, { method: request.method, headers: request.headers, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body as Uint8Array<ArrayBuffer> }), signal });
  const cwd = options.cwd ?? "/workspace";
  let link: { send(text: string): void; close(): void } | undefined;
  let hand: Awaited<ReturnType<AgentRuntime["serveHand"]>>;
  try {
    hand = await runtime.serveHand({
      workspace: options.workspace,
      cwd,
      fetch: send,
      dispatch,
      ...(options.tools ? { tools: { definitions: options.tools.definitions, call: (name, input, signal) => options.tools!.call(name, input, signal) } } : {}),
      ...(options.mcpServers?.length ? { mcp_servers: options.mcpServers } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.maxFrameBytes ? { max_frame_bytes: options.maxFrameBytes } : {}),
      send: text => link?.send(text),
    });
  } catch (error) {
    void runtime.dispose().catch(() => {});
    throw error;
  }
  let used = false;
  return {
    cwd,
    dispose() {
      if (used) return;
      used = true;
      void runtime.dispose().catch(() => {});
    },
    async connect(url, onStatus) {
      if (used) throw new Error("a prepared hand connects once");
      used = true;
      const Socket = options.WebSocket ?? globalThis.WebSocket;
      let done!: (status: HandStatus) => void;
      const closed = new Promise<HandStatus>(resolve => { done = resolve; });
      let finished = false;
      const finish = (reason: string) => {
        if (finished) return;
        finished = true;
        void runtime.dispose().catch(() => {});
        const status: HandStatus = { state: "closed", reason };
        onStatus?.(status);
        done(status);
      };
      let queue = Promise.resolve();
      const receive = (text: string) => {
        queue = queue.then(() => hand.receive(text)).catch(() => {});
      };
      const gone = (reason: string) => {
        void hand.closed().catch(() => {});
        finish(reason);
      };
      if (options.transport === "stream") {
        link = await streamLink({ ...options, url }, hand.catalog, receive, gone, closed);
        onStatus?.({ state: "attached" });
        return { closed, close: () => link!.close() };
      }
      const socket = new Socket(url, options.protocols);
      link = { send: text => { if (socket.readyState === 1) socket.send(text); }, close: () => socket.close(1000, "the hand closed") };
      const opened = new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => {
          socket.send(hand.catalog);
          onStatus?.({ state: "attached" });
          resolve();
        });
        void closed.then(status => reject(new Error(status.reason ?? "the hand closed")));
      });
      socket.addEventListener("message", event => receive(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)));
      socket.addEventListener("close", event => gone(event.reason || "closed with code " + event.code));
      socket.addEventListener("error", () => finish("the connection failed"));
      await opened;
      return { closed, close: () => link!.close() };
    },
  };
}

export async function connectHand(module: WebAssembly.Module, options: HandOptions): Promise<Hand> {
  options.onStatus?.({ state: "connecting" });
  let prepared: PreparedHand;
  try {
    prepared = await prepareHand(module, options);
  } catch (error) {
    options.onStatus?.({ state: "closed", reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  return prepared.connect(options.url, options.onStatus);
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
  let sending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (sending || !pending.length || ended) return;
    const frames = pending;
    pending = [];
    sending = true;
    void (async () => {
      try {
        const response = await post({ brain, frames });
        if (!response.ok) throw new Error(response.status + " " + await response.text());
      } catch (error) {
        if (!ended) gone(error instanceof Error ? error.message : String(error));
      } finally {
        sending = false;
        flush();
      }
    })();
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
      pending.push(text);
      if (!sending && timer === undefined) timer = setTimeout(flush, options.batchMs ?? 20);
    },
    close,
  };
}

export type HandKeeperOptions = Omit<HandOptions, "url" | "workspace" | "cwd"> & {
  url(session: string): string;
  listed?(session: string): Promise<boolean>;
  module(): Promise<WebAssembly.Module>;
  workspace(session: string): Promise<{ workspace: WorkspaceHost; cwd: string }>;
  cwd?: string;
  name?: string;
  attachMs?: number;
};

type Spare = { prepared: PreparedHand; slot: { workspace?: WorkspaceHost } };

function deferred(slot: Spare["slot"]): WorkspaceHost {
  const target = () => {
    if (!slot.workspace) throw new Error("the hand has no workspace yet");
    return slot.workspace;
  };
  return {
    read: path => target().read(path),
    write: (path, contents) => target().write(path, contents),
    remove: path => target().remove(path),
    run: (request, signal) => target().run(request, signal),
    wasm: (request, signal) => {
      const workspace = target();
      if (!workspace.wasm) throw new Error("this workspace does not run WebAssembly");
      return workspace.wasm(request, signal);
    },
  };
}

export function handKeeper(options: HandKeeperOptions) {
  const name = options.name ?? "browser";
  const cwd = options.cwd ?? "/workspace";
  let current: { session: string; hand: Promise<Hand | undefined>; open: boolean } | undefined;
  let spare: Promise<Spare | undefined> | undefined;
  const listeners = new Set<(status: HandStatus & { session?: string }) => void>();
  let status: HandStatus & { session?: string } = { state: "closed" };
  const emit = (next: HandStatus & { session?: string }) => {
    status = next;
    options.onStatus?.(next);
    for (const listener of listeners) listener(next);
  };
  const prepare = async (): Promise<Spare> => {
    const slot: Spare["slot"] = {};
    const prepared = await prepareHand(await options.module(), { ...options, name, workspace: deferred(slot), cwd });
    return { prepared, slot };
  };
  const take = async (): Promise<Spare> => {
    const ready = spare;
    spare = undefined;
    return (await ready?.catch(() => undefined)) ?? prepare();
  };
  const open = (session: string) => {
    const entry = { session, open: false, hand: undefined as unknown as Promise<Hand | undefined> };
    entry.hand = (async () => {
      let [ready, place] = await Promise.all([take(), options.workspace(session)]);
      if (place.cwd !== ready.prepared.cwd) {
        ready.prepared.dispose();
        ready = await prepareHand(await options.module(), { ...options, name, workspace: place.workspace, cwd: place.cwd }).then(prepared => ({ prepared, slot: {} }));
      }
      ready.slot.workspace = place.workspace;
      if (current !== entry) {
        ready.prepared.dispose();
        return undefined;
      }
      const hand = await ready.prepared.connect(options.url(session), next => {
        entry.open = next.state === "attached";
        if (current === entry) emit({ ...next, session });
      });
      const deadline = Date.now() + (options.attachMs ?? 5000);
      while (options.listed && Date.now() < deadline && entry.open && !(await options.listed(session).catch(() => false))) await new Promise(resolve => setTimeout(resolve, 150));
      return hand;
    })().catch(error => {
      if (current === entry) emit({ state: "closed", reason: error instanceof Error ? error.message : String(error), session });
      return undefined;
    });
    current = entry;
    emit({ state: "connecting", session });
    return entry;
  };
  const attach = async (session: string): Promise<string | undefined> => {
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
  };
  return {
    name,
    status: () => status,
    subscribe(listener: (status: HandStatus & { session?: string }) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    prewarm(session?: string): Promise<unknown> {
      if (session) return attach(session).catch(() => undefined);
      if (!spare && !current) spare = prepare().catch(() => undefined);
      return spare ?? Promise.resolve(undefined);
    },
    attach,
    close() {
      void current?.hand.then(hand => hand?.close());
      current = undefined;
    },
  };
}

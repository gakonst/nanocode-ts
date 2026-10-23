import { type EntryKind, type LiveEvent, liveEvent, serverEvents, type Transport, type TransportParameters } from "../client.ts";
import type { LoggedEvent } from "../contracts.ts";

export type CloudflareSession = { id?: string; cursor?: number; open?: string };

export type CloudflareModel = { provider: string; model: string; thinking?: string };

export type CloudflareTransportOptions = {
  url?: string;
  model(): CloudflareModel;
  headers?(): Record<string, string>;
  session?: { load(): CloudflareSession; save(session: CloudflareSession): void };
  reconnectMs?: number;
  warmMs?: number;
};

export type CloudflareTransport = Transport & {
  session(): CloudflareSession;
  warm(): void;
  crash(afterMs?: number): Promise<Response>;
  forget(): void;
  health(): Promise<Response | undefined>;
};

type Sink = { push(event: LiveEvent): void; note(kind: EntryKind, text: string): void };

function identifier(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function cloudflare(options: CloudflareTransportOptions): CloudflareTransport {
  const base = options.url ?? "";
  const reconnectMs = options.reconnectMs ?? 1000;
  const warmMs = options.warmMs ?? 10_000;
  let state: CloudflareSession = options.session?.load() ?? {};
  let warmed: string | undefined;
  let used = 0;
  const queued: string[] = [];

  const save = () => options.session?.save(state);
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...options.headers?.() });
  const path = (suffix: string) => `${base}sessions/${encodeURIComponent(state.id!)}/${suffix}`;

  const receive = (logged: LoggedEvent, requestId: string, sink: Sink): boolean => {
    const body = (logged.event ?? {}) as { source?: string; type?: string };
    if (body.source === "agent") {
      const event = liveEvent(logged);
      if (event) sink.push(event);
      return false;
    }
    if (logged.request_id !== requestId) return false;
    if (body.type === "interrupted") sink.note("tool", "The session object reset. Its alarm started it again, and the turn continues from its checkpoint.");
    if (body.type !== "retrying" && body.type !== "result") return false;
    const event = liveEvent(logged);
    if (event) sink.push(event);
    return body.type === "result";
  };

  const follow = async (response: Response, requestId: string, sink: Sink): Promise<boolean> => {
    if (!response.ok || !response.body) {
      sink.note("error", `${response.status} ${await response.text()}`);
      return true;
    }
    let settled = false;
    try {
      for await (const message of serverEvents(response.body)) {
        if (message.id) {
          state.cursor = Number(message.id);
          save();
        }
        if (message.data && receive(JSON.parse(message.data) as LoggedEvent, requestId, sink)) {
          settled = true;
          break;
        }
      }
    } catch {
      sink.note("tool", "The stream dropped. Reconnecting from the last event.");
      return false;
    }
    if (settled) void response.body.cancel().catch(() => undefined);
    return settled;
  };

  const reconnect = async (requestId: string, sink: Sink) => {
    for (;;) {
      const response = await fetch(path(`events?after=${state.cursor ?? 0}`), { headers: headers({ accept: "text/event-stream" }) }).catch(() => undefined);
      if (response && await follow(response, requestId, sink)) return;
      await new Promise(resolve => setTimeout(resolve, reconnectMs));
    }
  };

  const turn = async (prompt: string, sink: Sink) => {
    state.id ??= warmed ?? identifier("web");
    used = performance.now();
    const requestId = identifier("turn");
    state.open = requestId;
    save();
    const model = options.model();
    try {
      const response = await fetch(path(`turns?after=${state.cursor ?? 0}`), { method: "POST", headers: headers({ accept: "text/event-stream", "content-type": "application/json" }), body: JSON.stringify({ request_id: requestId, prompt, provider: model.provider, model: model.model, ...(model.thinking ? { thinking: model.thinking } : {}) }) });
      if (!(await follow(response, requestId, sink))) await reconnect(requestId, sink);
    } finally {
      state.open = undefined;
      used = performance.now();
      save();
    }
  };

  return {
    async send({ prompt, push, note }: TransportParameters) {
      await turn(prompt, { push, note });
      for (let next = queued.shift(); next; next = queued.shift()) await turn(next, { push, note });
    },
    async steer({ prompt }: TransportParameters) {
      if (!state.id) return false;
      const model = options.model();
      const response = await fetch(path("turns"), { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ request_id: identifier("steer"), prompt, provider: model.provider, model: model.model, steer: true }) });
      if (response.ok) return true;
      if (response.status === 409) {
        queued.push(prompt);
        return false;
      }
      throw new Error(`${response.status} ${await response.text()}`);
    },
    async resume({ push, note }) {
      if (!state.open || !state.id) return;
      try {
        await reconnect(state.open, { push, note });
      } finally {
        state.open = undefined;
        save();
      }
    },
    session: () => state,
    snapshot: () => ({ ...state }),
    restore(saved) {
      state = saved && typeof saved === "object" ? { ...(saved as CloudflareSession) } : {};
      warmed = undefined;
      used = 0;
      queued.length = 0;
    },
    warm() {
      if (used && performance.now() - used < warmMs) return;
      used = performance.now();
      const id = state.id ?? (warmed ??= identifier("web"));
      const model = options.model();
      void fetch(`${base}sessions/${encodeURIComponent(id)}/warm`, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ provider: model.provider, model: model.model }) }).catch(() => undefined);
    },
    crash(afterMs = 1500) {
      return fetch(path("crash"), { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ after_ms: afterMs }) });
    },
    forget() {
      state = {};
      warmed = undefined;
      used = 0;
      queued.length = 0;
      save();
    },
    async health() {
      const open = await fetch(`${base}health`).catch(() => undefined);
      return open?.ok ? open : await fetch(`${base}health`, { headers: headers() }).catch(() => undefined);
    },
  };
}

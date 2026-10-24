import { type LiveEvent, serverEvents, type Transport, type TransportParameters } from "../client.ts";

export type VercelSession = { id?: string; cursor?: string; open?: boolean };

export type VercelSelection = { harness: string; model: string; effort?: string };

export type VercelTransportOptions = {
  url?: string;
  chaosUrl?: string;
  selection(): VercelSelection;
  headers?(): Record<string, string>;
  session?: { load(): VercelSession; save(session: VercelSession): void };
  reconnectMs?: number;
  hand?(): Promise<string | undefined>;
};

export type VercelTransport = Transport & {
  session(): VercelSession;
  warm(): void;
  open(): Promise<string | undefined>;
  crash(options?: { at?: "tool" | "any"; afterMs?: number }): Promise<Response>;
  forget(): void;
};

export function vercel(options: VercelTransportOptions): VercelTransport {
  const url = options.url ?? "/api/chat";
  const reconnectMs = options.reconnectMs ?? 1000;
  let state: VercelSession = options.session?.load() ?? {};
  let warmed: { key: string; session: Promise<string | undefined> } | undefined;

  const save = (session = state) => {
    if (session === state) options.session?.save(state);
  };
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...options.headers?.() });
  const key = () => {
    const selection = options.selection();
    return `${selection.harness}/${selection.model}/${selection.effort ?? ""}`;
  };
  const chosen = () => {
    const selection = options.selection();
    return { harness: selection.harness, model: selection.model, ...(selection.effort ? { effort: selection.effort } : {}) };
  };
  const pause = (signal: AbortSignal | undefined) => new Promise<void>(resolve => {
    const timer = setTimeout(done, reconnectMs);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });

  const follow = async (response: Response, parameters: Omit<TransportParameters, "prompt">, session: VercelSession): Promise<boolean> => {
    const { signal } = parameters;
    if (!response.ok || !response.body) {
      if (signal?.aborted) return true;
      parameters.note("error", `${response.status} ${await response.text()}`);
      return true;
    }
    try {
      for await (const message of serverEvents(response.body)) {
        if (signal?.aborted) break;
        if (message.id) {
          session.cursor = message.id;
          save(session);
        }
        if (message.event === "end") return true;
        if (message.data) parameters.push(JSON.parse(message.data) as LiveEvent);
      }
    } catch {
      if (signal?.aborted) return true;
      parameters.note("tool", "The stream dropped. Reconnecting from the last event.");
      return false;
    }
    if (signal?.aborted) {
      void response.body.cancel().catch(() => undefined);
      return true;
    }
    return false;
  };

  const reconnect = async (id: string, parameters: Omit<TransportParameters, "prompt">, session: VercelSession) => {
    const { signal } = parameters;
    while (session.cursor && !signal?.aborted) {
      const settled = await fetch(`${url}?sessionId=${encodeURIComponent(id)}&cursor=${encodeURIComponent(session.cursor)}`, { headers: headers(), signal }).then(response => follow(response, parameters, session), () => false);
      if (settled) return;
      await pause(signal);
    }
  };

  return {
    async send({ prompt, push, note, signal }: TransportParameters) {
      const session = state;
      session.open = true;
      save(session);
      const started = !session.id && warmed?.key === key() ? await warmed.session : undefined;
      warmed = undefined;
      const existing = session.id ?? started;
      try {
        const hand = await options.hand?.();
        if (signal?.aborted) return;
        const response = await fetch(url, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(existing ? { sessionId: existing, text: prompt } : { ...chosen(), ...(hand ? { hand } : {}), text: prompt }), signal }).catch((error: unknown) => {
          if (signal?.aborted) return undefined;
          throw error;
        });
        if (!response) return;
        const id = response.headers.get("x-session-id") ?? existing;
        if (id && id !== session.id) {
          session.id = id;
          save(session);
        }
        if (!(await follow(response, { push, note, signal }, session)) && id) await reconnect(id, { push, note, signal }, session);
      } finally {
        if (!signal?.aborted) {
          session.open = false;
          save(session);
        }
      }
    },
    async steer({ prompt }: TransportParameters) {
      if (!state.id) return false;
      const kind = /^\/effort\s/.test(prompt) ? "prompt" : "steer";
      const response = await fetch(url, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ kind, sessionId: state.id, text: prompt }) });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      void response.body?.cancel();
      return false;
    },
    async resume({ push, note, signal }) {
      const session = state;
      if (!session.open || !session.id) return;
      try {
        await reconnect(session.id, { push, note, signal }, session);
      } finally {
        if (!signal?.aborted) {
          session.open = false;
          save(session);
        }
      }
    },
    session: () => state,
    snapshot: () => ({ ...state }),
    restore(saved) {
      state = saved && typeof saved === "object" ? { ...(saved as VercelSession) } : {};
      warmed = undefined;
    },
    warm() {
      if (state.id || warmed?.key === key()) return;
      const session = (async () => {
        const hand = await options.hand?.().catch(() => undefined);
        const response = await fetch(url, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ ...chosen(), ...(hand ? { hand } : {}), warm: true }) });
        return response.ok ? (await response.json() as { sessionId?: string }).sessionId : undefined;
      })().catch(() => undefined);
      warmed = { key: key(), session };
    },
    async open() {
      const session = state;
      if (session.id) return session.id;
      const pending = warmed?.key === key() ? warmed.session : fetch(url, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ ...chosen(), warm: true }) }).then(async response => response.ok ? (await response.json() as { sessionId?: string }).sessionId : undefined, () => undefined);
      warmed = { key: key(), session: pending };
      const id = await pending;
      if (warmed?.session === pending) warmed = undefined;
      if (id && !session.id) {
        session.id = id;
        save(session);
      }
      return session.id;
    },
    crash(crash = {}) {
      return fetch(options.chaosUrl ?? url.replace(/chat$/, "chaos"), { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ sessionId: state.id, at: crash.at ?? "tool", afterMs: crash.afterMs ?? 1500 }) });
    },
    forget() {
      state = {};
      warmed = undefined;
      save();
    },
  };
}

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
};

export type VercelTransport = Transport & {
  session(): VercelSession;
  warm(): void;
  crash(options?: { at?: "tool" | "any"; afterMs?: number }): Promise<Response>;
  forget(): void;
};

export function vercel(options: VercelTransportOptions): VercelTransport {
  const url = options.url ?? "/api/chat";
  const reconnectMs = options.reconnectMs ?? 1000;
  let state: VercelSession = options.session?.load() ?? {};
  let warmed: { key: string; session: Promise<string | undefined> } | undefined;

  const save = () => options.session?.save(state);
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...options.headers?.() });
  const key = () => {
    const selection = options.selection();
    return `${selection.harness}/${selection.model}/${selection.effort ?? ""}`;
  };
  const chosen = () => {
    const selection = options.selection();
    return { harness: selection.harness, model: selection.model, ...(selection.effort ? { effort: selection.effort } : {}) };
  };

  const follow = async (response: Response, parameters: Omit<TransportParameters, "prompt">): Promise<boolean> => {
    if (!response.ok || !response.body) {
      parameters.note("error", `${response.status} ${await response.text()}`);
      return true;
    }
    try {
      for await (const message of serverEvents(response.body)) {
        if (message.id) {
          state.cursor = message.id;
          save();
        }
        if (message.event === "end") return true;
        if (message.data) parameters.push(JSON.parse(message.data) as LiveEvent);
      }
    } catch {
      parameters.note("tool", "The stream dropped. Reconnecting from the last event.");
      return false;
    }
    return false;
  };

  const reconnect = async (id: string, parameters: Omit<TransportParameters, "prompt">) => {
    while (state.cursor) {
      const settled = await fetch(`${url}?sessionId=${encodeURIComponent(id)}&cursor=${encodeURIComponent(state.cursor)}`, { headers: headers() }).then(response => follow(response, parameters), () => false);
      if (settled) return;
      await new Promise(resolve => setTimeout(resolve, reconnectMs));
    }
  };

  return {
    async send({ prompt, push, note }: TransportParameters) {
      state.open = true;
      save();
      const started = !state.id && warmed?.key === key() ? await warmed.session : undefined;
      warmed = undefined;
      const existing = state.id ?? started;
      try {
        const response = await fetch(url, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(existing ? { sessionId: existing, text: prompt } : { ...chosen(), text: prompt }) });
        const id = response.headers.get("x-session-id") ?? existing;
        if (id && id !== state.id) {
          state.id = id;
          save();
        }
        if (!(await follow(response, { push, note })) && id) await reconnect(id, { push, note });
      } finally {
        state.open = false;
        save();
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
    async resume({ push, note }) {
      if (!state.open || !state.id) return;
      try {
        await reconnect(state.id, { push, note });
      } finally {
        state.open = false;
        save();
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
      const session = fetch(url, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ ...chosen(), warm: true }) }).then(async response => response.ok ? (await response.json() as { sessionId?: string }).sessionId : undefined, () => undefined);
      warmed = { key: key(), session };
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

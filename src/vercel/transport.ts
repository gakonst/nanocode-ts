import { type Attachment, attachedPrompt, type LiveEvent, serverEvents, type Transport, type TransportParameters } from "../client.ts";
import { safeName, sniff } from "../files.ts";

export const VERCEL_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export const FIRST_CURSOR = "0.0";

export type VercelSession = { id?: string; cursor?: string; open?: boolean };

export type VercelSelection = { harness: string; model: string; effort?: string };

export type VercelTransportOptions = {
  url?: string;
  chaosUrl?: string;
  selection(): VercelSelection;
  headers?(): Record<string, string>;
  session?: { load(): VercelSession; save(session: VercelSession): void };
  reconnectMs?: number;
  hand?(session?: string): Promise<string | undefined>;
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
  const pending = new Map<string, { bytes: Uint8Array; type: string }>();

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
  const pause = (signal: AbortSignal | undefined, ms = reconnectMs) => new Promise<void>(resolve => {
    const timer = setTimeout(done, ms);
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

  const begin = async (hand: string | undefined, signal?: AbortSignal) => {
    const response = await fetch(url, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ ...chosen(), ...(hand ? { hand } : {}), warm: true }), ...(signal ? { signal } : {}) });
    return response.ok ? (await response.json() as { sessionId?: string }).sessionId : undefined;
  };

  const prepare = async () => {
    const hand = await options.hand?.().catch(() => undefined);
    const id = await begin(hand).catch(() => undefined);
    if (id && hand) await options.hand!(id).catch(() => undefined);
    return id;
  };

  const reconnect = async (id: string, parameters: Omit<TransportParameters, "prompt">, session: VercelSession) => {
    const { signal } = parameters;
    let delay = reconnectMs;
    session.cursor ??= FIRST_CURSOR;
    while (!signal?.aborted) {
      const response = await fetch(`${url}?sessionId=${encodeURIComponent(id)}&cursor=${encodeURIComponent(session.cursor)}`, { headers: headers(), signal }).catch(() => undefined);
      if (response && (response.status === 408 || response.status === 429 || response.status >= 500)) {
        const after = Number(response.headers.get("retry-after"));
        void response.body?.cancel().catch(() => undefined);
        await pause(signal, after > 0 ? after * 1000 : delay);
        delay = Math.min(delay * 2, 15_000);
        continue;
      }
      if (response && await follow(response, parameters, session)) return;
      delay = response ? reconnectMs : Math.min(delay * 2, 15_000);
      await pause(signal, delay);
    }
  };

  const encoded = (attachments: readonly Attachment[] = []) => {
    const files = attachments.flatMap(item => {
      const found = pending.get(item.path);
      if (!found) return [];
      let binary = "";
      for (let index = 0; index < found.bytes.length; index += 0x8000) binary += String.fromCharCode(...found.bytes.subarray(index, index + 0x8000));
      return [{ path: item.path, data: btoa(binary) }];
    });
    return files.length ? { attachments: files } : {};
  };

  return {
    files: {
      maxBytes: VERCEL_ATTACHMENT_BYTES,
      scope: () => state.id,
      async upload(file, name) {
        if (file.size > VERCEL_ATTACHMENT_BYTES) throw new Error(`attachments are at most ${VERCEL_ATTACHMENT_BYTES} bytes here`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const safe = safeName(name);
        const dot = safe.lastIndexOf(".");
        const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)), byte => byte.toString(16).padStart(2, "0")).join("");
        const chosen = dot > 0 ? `${safe.slice(0, dot)}-${suffix}${safe.slice(dot)}` : `${safe}-${suffix}`;
        const type = sniff(bytes).split(";")[0]!;
        const path = `/workspace/uploads/${chosen}`;
        pending.set(path, { bytes, type });
        return { name: chosen, path, type, size: bytes.length };
      },
      async read(file, signal) {
        const local = pending.get(file);
        if (local) return new Blob([local.bytes.slice().buffer as ArrayBuffer], { type: local.type });
        if (!state.id) throw new Error("no session yet");
        const response = await fetch(`${url}?sessionId=${encodeURIComponent(state.id)}&file=${encodeURIComponent(file)}`, { headers: headers(), ...(signal ? { signal } : {}) });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        return await response.blob();
      },
    },
    async send({ prompt: typed, attachments, push, note, changed, signal }: TransportParameters) {
      const prompt = attachedPrompt(typed, attachments);
      const total = (attachments ?? []).reduce((sum, item) => sum + (pending.get(item.path)?.bytes.length ?? 0), 0);
      if (total > VERCEL_ATTACHMENT_BYTES) throw new Error(`a message carries at most ${VERCEL_ATTACHMENT_BYTES} bytes of attachments here`);
      const carried = encoded(attachments);
      const session = state;
      session.open = true;
      save(session);
      const started = !session.id && warmed?.key === key() ? await warmed.session : undefined;
      warmed = undefined;
      let existing = session.id ?? started;
      try {
        let hand = await options.hand?.(existing);
        if (signal?.aborted) return;
        if (!existing) {
          existing = await begin(hand, signal).catch(() => undefined);
          if (signal?.aborted) return;
          if (existing && hand) hand = await options.hand!(existing);
        }
        if (existing && existing !== session.id) {
          session.id = existing;
          save(session);
          changed?.();
        }
        const response = await fetch(url, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(existing ? { sessionId: existing, text: prompt, ...carried } : { ...chosen(), ...(hand ? { hand } : {}), text: prompt, ...carried }), signal }).catch((error: unknown) => {
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
    async cancel() {
      if (!state.open || !state.id) return;
      const response = await fetch(url, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ kind: "cancel", sessionId: state.id }) });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
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
      const session = prepare();
      warmed = { key: key(), session };
    },
    async open() {
      const session = state;
      if (session.id) return session.id;
      const pending = warmed?.key === key() ? warmed.session : prepare();
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

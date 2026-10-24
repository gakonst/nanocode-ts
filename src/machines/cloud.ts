import { serverEvents } from "../client.ts";
import type { LoggedEvent } from "../contracts.ts";
import type * as Payments from "./payments.ts";
import type * as Wallet from "./wallet.ts";

const storageKey = "nanocode.machines.cloud";

const reconnectMs = 1000;

export type Cloud = { address: string; cursor: number; expiresAt: number; open?: string; session: string; token: string };

export type Model = { model: string; provider: "claude" | "codex"; thinking: string };

const luna: Model = { model: "gpt-6-luna", provider: "codex", thinking: "low" };

export type Handlers = { event: (logged: LoggedEvent) => void; interrupted: () => void };

export function restore(): Cloud | undefined {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return undefined;
  const parsed = JSON.parse(saved) as Cloud;
  if (parsed.expiresAt > Date.now()) return parsed;
  localStorage.removeItem(storageKey);
  return undefined;
}

function save(cloud: Cloud) {
  localStorage.setItem(storageKey, JSON.stringify(cloud));
}

export function forget() {
  localStorage.removeItem(storageKey);
}

export async function logout(cloud: Cloud) {
  const response = await fetch("v1/keys", { headers: headers(cloud), method: "DELETE" });
  if (!response.ok && response.status !== 401) throw await failure(response);
}

function headers(cloud: Cloud, extra: Record<string, string> = {}) {
  return { ...extra, authorization: `Bearer ${cloud.token}` };
}

async function failure(response: Response) {
  const text = await response.text();
  try {
    return new Error((JSON.parse(text) as { error?: string }).error ?? text);
  } catch {
    return new Error(`${response.status} ${text}`);
  }
}

export async function enable(connected: Wallet.Wallet): Promise<Cloud> {
  const response = await fetch("v1/keys", { body: JSON.stringify({ address: connected.address, private_key: connected.key }), headers: { "content-type": "application/json" }, method: "POST" });
  if (!response.ok) throw await failure(response);
  const body = await response.json() as { address: string; expires_at: number; token: string };
  const cloud: Cloud = { address: body.address, cursor: 0, expiresAt: body.expires_at, session: `web-${crypto.randomUUID()}`, token: body.token };
  save(cloud);
  return cloud;
}

export type Session = Pick<Cloud, "cursor" | "open" | "session">;

export function snapshot(cloud: Cloud): Session {
  return { cursor: cloud.cursor, open: cloud.open, session: cloud.session };
}

export function adopt(cloud: Cloud, saved: unknown) {
  const session = saved as Partial<Session> | undefined;
  Object.assign(cloud, typeof session?.session === "string" ? { cursor: session.cursor ?? 0, open: session.open, session: session.session } : { cursor: 0, open: undefined, session: `web-${crypto.randomUUID()}` });
  save(cloud);
}

export async function status(cloud: Cloud) {
  const response = await fetch("v1/me", { headers: headers(cloud) });
  if (!response.ok) throw await failure(response);
  return await response.json() as { calls?: Record<string, number>; spent: Record<string, string> };
}

async function follow(cloud: Cloud, response: Response, request: string, handlers: Handlers, signal?: AbortSignal): Promise<boolean> {
  if (!response.ok || !response.body) {
    if (signal?.aborted) return true;
    throw await failure(response);
  }
  try {
    for await (const message of serverEvents(response.body)) {
      if (signal?.aborted) break;
      if (message.id) {
        cloud.cursor = Number(message.id);
        save(cloud);
      }
      if (!message.data) continue;
      const logged = JSON.parse(message.data) as LoggedEvent & { event?: { source?: string; type?: string } };
      const body = logged.event ?? {};
      if (body.source === "agent") {
        handlers.event(logged);
        continue;
      }
      if (logged.request_id !== request) continue;
      if (body.type === "interrupted") handlers.interrupted();
      if (body.type === "retrying" || body.type === "result") handlers.event(logged);
      if (body.type === "result") return true;
    }
  } catch {
    return Boolean(signal?.aborted);
  }
  if (signal?.aborted) void response.body.cancel().catch(() => undefined);
  return Boolean(signal?.aborted);
}

function pause(signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(done, reconnectMs);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}

async function reconnect(cloud: Cloud, session: string, request: string, handlers: Handlers, signal?: AbortSignal) {
  while (!signal?.aborted) {
    const response = await fetch(`sessions/${encodeURIComponent(session)}/events?after=${cloud.cursor}`, { headers: headers(cloud, { accept: "text/event-stream" }), signal }).catch(() => undefined);
    if (response?.status === 401 || response?.status === 403) throw await failure(response);
    if (response && await follow(cloud, response, request, handlers, signal)) return;
    await pause(signal);
  }
}

export async function ask(cloud: Cloud, prompt: string, handlers: Handlers, model: Model = luna, signal?: AbortSignal) {
  const request = `turn-${crypto.randomUUID()}`;
  const session = cloud.session;
  cloud.open = request;
  save(cloud);
  try {
    const response = await fetch(`sessions/${encodeURIComponent(session)}/turns?after=${cloud.cursor}`, {
      body: JSON.stringify({ model: model.model, prompt, provider: model.provider, request_id: request, thinking: model.thinking }),
      headers: headers(cloud, { accept: "text/event-stream", "content-type": "application/json" }),
      method: "POST",
      signal,
    }).catch((error: unknown) => {
      if (signal?.aborted) return undefined;
      throw error;
    });
    if (response && !(await follow(cloud, response, request, handlers, signal))) await reconnect(cloud, session, request, handlers, signal);
  } finally {
    if (!signal?.aborted) {
      cloud.open = undefined;
      save(cloud);
    }
  }
}

export async function resume(cloud: Cloud, handlers: Handlers, signal?: AbortSignal) {
  const request = cloud.open;
  if (!request) return;
  try {
    await reconnect(cloud, cloud.session, request, handlers, signal);
  } finally {
    if (!signal?.aborted) {
      cloud.open = undefined;
      save(cloud);
    }
  }
}

export async function steer(cloud: Cloud, prompt: string, model: Model = luna): Promise<"queued" | "steered"> {
  const response = await fetch(`sessions/${encodeURIComponent(cloud.session)}/turns`, {
    body: JSON.stringify({ model: model.model, prompt, provider: model.provider, request_id: `steer-${crypto.randomUUID()}`, steer: true }),
    headers: headers(cloud, { "content-type": "application/json" }),
    method: "POST",
  });
  if (response.ok) return "steered";
  if (response.status === 409) return "queued";
  throw await failure(response);
}

export function meter(cloud: Cloud, interval = 1000) {
  let ledger: Payments.Ledger = { calls: 0, services: [], total: 0n };
  let seen: Record<string, { calls: number; spent: bigint }> | undefined;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function poll() {
    try {
      const { calls = {}, spent } = await status(cloud);
      const now = Date.now();
      const hosts = new Set([...Object.keys(spent), ...Object.keys(calls)]);
      const first = seen === undefined;
      const next: Record<string, { calls: number; spent: bigint }> = {};
      let changed = first;
      const services = [...ledger.services];
      for (const host of hosts) {
        const current = { calls: calls[host] ?? 0, spent: BigInt(spent[host] ?? "0") };
        next[host] = current;
        const before = seen?.[host] ?? { calls: 0, spent: 0n };
        const [domain = host, ...operation] = host.split(" · ");
        const name = [domain.split(".")[0] ?? domain, ...operation].join(" · ");
        const index = services.findIndex(service => service.name === name);
        const previous = index >= 0 ? services[index]! : { calls: 0, charges: [], name, spent: 0n };
        const amount = current.spent - before.spent;
        if (!first && amount === 0n && current.calls === before.calls) continue;
        changed = true;
        const service: Payments.Service = {
          calls: current.calls,
          charges: [...previous.charges.filter(item => now - item.at < 30_000), ...(first || amount <= 0n ? [] : [{ amount, at: now }])],
          name,
          spent: current.spent,
        };
        if (index >= 0) services[index] = service;
        else services.push(service);
      }
      seen = next;
      if (changed) {
        ledger = { calls: services.reduce((sum, service) => sum + service.calls, 0), services, total: services.reduce((sum, service) => sum + service.spent, 0n) };
        for (const listener of listeners) listener();
      }
    } catch {
      // the next poll tries again
    }
    if (listeners.size) timer = setTimeout(poll, interval);
  }

  return {
    ledger: () => ledger,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) void poll();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) clearTimeout(timer);
      };
    },
  };
}

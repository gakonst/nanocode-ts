import { relayHands, type RelayedHand } from "./bridge.ts";
import { createRelayToken, type HandAccess, socketUrl } from "./client.ts";
import type { TurnReport } from "./contracts.ts";
import type { AgentRuntime } from "./host.ts";
import type { RemotePolicy } from "./remote.ts";

export type SessionRelay = { url: string; token?: string; policy: RemotePolicy; keep?(token: string): void };

export type SessionOptions = {
  scope: string;
  open(hand: RelayedHand | undefined): Promise<AgentRuntime>;
  relay?: SessionRelay;
  waitMs?: number;
};

export type Session = {
  readonly interrupted: boolean;
  ask(prompt: string): Promise<TurnReport | undefined>;
  steer(prompt: string): Promise<"queued" | "steered">;
  resume(): Promise<TurnReport | undefined>;
  hand(): HandAccess | undefined;
  hands(): readonly (string | null)[];
  runtime(): AgentRuntime;
  dispose(): Promise<void>;
};

export function handName(hand: RelayedHand): string {
  return hand.name ?? "machine";
}

export async function openSession(options: SessionOptions): Promise<Session> {
  const { scope } = options;
  let hand: RelayedHand | undefined;
  let placed: RelayedHand | undefined;
  const launch = async () => {
    placed = hand;
    const runtime = await options.open(placed);
    if (placed) await runtime.attach(handName(placed), placed.connection);
    return runtime;
  };
  let runtime = await launch();
  let leases = 0;
  let reopening: Promise<void> | undefined;
  const settle = () => {
    if (leases || reopening || placed === hand) return;
    reopening = (async () => {
      await runtime.dispose();
      runtime = await launch().catch(error => {
        if (placed) hand = undefined;
        throw error;
      });
    })().catch(() => {}).finally(() => {
      reopening = undefined;
      settle();
    });
  };
  const lease = async <T>(work: () => Promise<T>): Promise<T> => {
    while (reopening) await reopening;
    leases++;
    try {
      return await work();
    } finally {
      leases--;
      settle();
    }
  };
  const relay = new AbortController();
  let token = options.relay?.token;
  let relaying = false;
  const connect = () => {
    if (!options.relay || !token || relaying) return;
    relaying = true;
    relayHands(options.relay.url, token, options.relay.policy, found => {
      hand = found;
      settle();
    }, relay.signal);
  };
  connect();
  const submit = async (prompt: string) => {
    const request = crypto.randomUUID();
    const submitted = await runtime.submit(scope, { ...(placed ? { hand: handName(placed) } : {}), metadata: {}, prompt, request_id: request });
    if (submitted.submitted !== "accepted") throw new Error(`The session refused the prompt (${submitted.submitted}).`);
    return request;
  };
  let draining: Promise<void> | undefined;
  const drain = () => {
    draining ??= lease(async () => {
      try {
        for (;;) {
          const next = (await runtime.pending(scope))[0];
          if (!next) break;
          const driven = await runtime.drive(next.report.request_id);
          if (driven.retry) throw new Error("The session must reopen. Reload the page to start again.");
          if (driven.waiting) await new Promise(resolve => setTimeout(resolve, options.waitMs ?? 500));
        }
      } finally {
        draining = undefined;
      }
    });
    return draining;
  };
  const interrupted = (await runtime.pending(scope)).length > 0;
  return {
    interrupted,
    ask: prompt => lease(async () => {
      const request = await submit(prompt);
      await drain();
      return (await runtime.turn(scope, request))?.report;
    }),
    steer: prompt => lease(async () => {
      if (await runtime.steer(crypto.randomUUID(), prompt)) return "steered";
      await submit(prompt);
      void drain();
      return "queued";
    }),
    resume: () => lease(async () => {
      const pending = (await runtime.pending(scope))[0];
      if (!pending) return undefined;
      await drain();
      return (await runtime.turn(scope, pending.report.request_id))?.report;
    }),
    hand() {
      if (!options.relay) return undefined;
      if (!token) {
        token = createRelayToken();
        options.relay.keep?.(token);
      }
      connect();
      return { url: socketUrl(options.relay.url), token };
    },
    hands: () => (hand ? [hand.name] : []),
    runtime: () => runtime,
    async dispose() {
      relay.abort();
      while (reopening) await reopening;
      await runtime.dispose();
    },
  };
}

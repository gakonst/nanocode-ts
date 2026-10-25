import { defineDoc, type DurableSessions } from "durable-harness";
import { egress } from "../vercel/egress.ts";
import * as Mcp from "./mcp.ts";
import * as Payment from "./payment.ts";
import { account, type Account, device, json, keys, paying, type Store } from "./account.ts";

const WalletDoc = defineDoc<{ entries: Record<string, string | number> }>({ kind: "nanocode.wallet", version: 1, initial: () => ({ entries: {} }) });

export function docStore(sessions: () => DurableSessions, sessionId: string, maxAgeMs = 1000): Store {
  let cached: { at: number; entries: Record<string, string | number> } | undefined;
  const read = async () => {
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.entries;
    const snapshot = await sessions().doc(sessionId, WalletDoc);
    cached = { at: Date.now(), entries: { ...snapshot.value.entries } };
    return cached.entries;
  };
  const write = async (mutate: (entries: Record<string, string | number>) => void) => {
    const snapshot = await sessions().updateDoc(sessionId, WalletDoc, draft => { mutate(draft.entries); });
    cached = { at: Date.now(), entries: { ...snapshot.value.entries } };
  };
  return {
    get: async <T,>(key: string) => (await read())[key] as T | undefined,
    put: (key, value) => write(entries => { entries[key] = value as string | number; }),
    delete: async key => {
      let had = false;
      await write(entries => {
        had = key in entries;
        delete entries[key];
      });
      return had;
    },
    list: async <T,>(prefix: string) => Object.entries(await read()).filter(([key]) => key.startsWith(prefix)) as [string, T][],
    update: async <T,>(key: string, change: (value: T | undefined) => T) => {
      let next: T | undefined;
      await write(entries => {
        next = change(entries[key] as T | undefined);
        entries[key] = next as string | number;
      });
      return next as T;
    },
  };
}

export type WalletsOptions = {
  sessions(): DurableSessions;
  secret: string | undefined;
  payment?: Payment.Config;
  authorize?(request: Request, sessionId: string): Promise<void> | void;
  rpc?: string;
  scripts?: boolean;
};

export function createWallets(options: WalletsOptions) {
  const { servers } = Payment.resolve({ inference: "apiKey", ...options.payment });
  const holders = new Map<string, Account>();
  const holder = (sessionId: string) => {
    let found = holders.get(sessionId);
    if (!found) {
      found = account({ store: docStore(options.sessions, sessionId), secret: options.secret, servers, scripts: options.scripts ?? false, fetch: egress(), ...(options.rpc ? { rpc: options.rpc } : {}) });
      holders.set(sessionId, found);
    }
    return found;
  };
  const sessionOf = (request: Request) => new URL(request.url).searchParams.get("sessionId");
  const handlers = keys<undefined>({ holder, account: sessionOf, rpc: () => options.rpc });

  async function guarded(request: Request, run: (request: Request) => Promise<Response>): Promise<Response> {
    const sessionId = sessionOf(request);
    if (!sessionId) return json({ error: "send ?sessionId=<the chat session>" }, 400);
    try {
      await options.authorize?.(request, sessionId);
    } catch (refusal) {
      if (refusal instanceof Response) return refusal;
      throw refusal;
    }
    try {
      return await run(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  return {
    DELETE: (request: Request) => guarded(request, request => handlers.logout(request, undefined)),
    GET: (request: Request) => guarded(request, request => handlers.me(request, undefined)),
    POST: (request: Request) => guarded(request, request => handlers.register(request, undefined)),
    device,
    fetch: (sessionId: string) => paying(() => holder(sessionId), servers),
    mcp: { servers: [...servers], fetch: (sessionId: string) => paying(() => holder(sessionId), servers) },
    servers,
  };
}

import { DurableObject } from "cloudflare:workers";
import * as Mcp from "../mcp.ts";
import { account, type Account, envelope, json, type KeyRecord, type Store } from "../account.ts";
import type { MachinesEnv } from "./env.ts";

export { digest, type KeyRecord, MACH, RPC } from "../account.ts";

function kvStore(kv: SyncKvStorage): Store {
  return {
    get: async <T,>(key: string) => kv.get<T>(key),
    put: async (key, value) => kv.put(key, value),
    delete: async key => kv.delete(key),
    list: async <T,>(prefix: string) => [...kv.list<T>({ prefix })],
    update: async <T,>(key: string, change: (value: T | undefined) => T) => {
      const next = change(kv.get<T>(key));
      kv.put(key, next);
      return next;
    },
  };
}

export class Wallet extends DurableObject<MachinesEnv> {
  protected servers: readonly Mcp.Server[] = Mcp.servers;
  protected scripts = true;
  private holder?: Account;

  private core(): Account {
    this.holder ??= account({ store: kvStore(this.ctx.storage.kv), secret: this.env.KEY_SECRET, servers: this.servers, scripts: this.scripts, ...(this.env.TEMPO_RPC ? { rpc: this.env.TEMPO_RPC } : {}) });
    return this.holder;
  }

  register(record: KeyRecord, issue = true) { return this.core().register(record, issue); }
  authenticate(hash: string) { return this.core().authenticate(hash); }
  status() { return this.core().status(); }
  logout() { return this.core().logout(); }
  setSecret(name: string, value: string | null) { return this.core().setSecret(name, value); }
  secretNames() { return this.core().secretNames(); }
  secrets(names: string[]) { return this.core().secrets(names); }
  files(session: string) { return this.core().files(session); }
  allFiles() { return this.core().allFiles(); }
  readFile(session: string, path: string) { return this.core().readFile(session, path); }
  writeFile(session: string, path: string, content: string) { return this.core().writeFile(session, path, content); }
  deleteFile(session: string, path: string) { return this.core().deleteFile(session, path); }

  async fetch(request: Request): Promise<Response> {
    const parsed = await envelope(request, this.servers);
    if (!parsed) return json({ error: "not_found" }, 404);
    return this.core().send(parsed.kind, parsed.target, parsed.init);
  }
}

export function walletClass(servers: readonly Mcp.Server[], scripts = true): typeof Wallet {
  return class extends Wallet {
    protected override servers = servers;
    protected override scripts = scripts;
  };
}

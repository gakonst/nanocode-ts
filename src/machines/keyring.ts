import type { Status } from "./account.ts";
import type * as Wallet from "./wallet.ts";

export const visitorKey = "nanocode.visitor";

export const visitorHeader = "x-nanocode-visitor";

export function visitor(): string {
  const saved = localStorage.getItem(visitorKey);
  if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved;
  const created = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(visitorKey, created);
  return created;
}

export function visitorHeaders(): Record<string, string> {
  return { [visitorHeader]: visitor() };
}

export type Options = {
  url: string;
  headers?(): Record<string, string>;
  scope?(): Promise<Record<string, string> | undefined> | Record<string, string> | undefined;
};

export type Keyring = {
  register(wallet: Wallet.Wallet): Promise<void>;
  status(): Promise<Status | undefined>;
  logout(): Promise<void>;
};

async function failure(response: Response) {
  const text = await response.text();
  try {
    return new Error((JSON.parse(text) as { error?: string }).error ?? text);
  } catch {
    return new Error(`${response.status} ${text}`);
  }
}

export function keyring(options: Options): Keyring {
  const registered = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const target = async () => {
    if (!options.scope) return options.url;
    const scope = await options.scope();
    return scope ? `${options.url}?${new URLSearchParams(scope)}` : undefined;
  };
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...options.headers?.() });

  return {
    register: wallet => serial(async () => {
      const url = await target();
      if (!url) return;
      const id = `${url} ${wallet.keyAddress}`;
      if (registered.has(id)) return;
      const response = await fetch(url, { body: JSON.stringify({ address: wallet.address, key_type: "secp256k1", private_key: wallet.key }), headers: headers({ "content-type": "application/json" }), method: "POST" });
      if (!response.ok) throw await failure(response);
      registered.add(id);
    }),
    status: () => serial(async () => {
      const url = await target();
      if (!url) return undefined;
      const response = await fetch(url, { headers: headers() });
      if (!response.ok) throw await failure(response);
      return await response.json() as Status;
    }),
    logout: () => serial(async () => {
      registered.clear();
      const url = await target();
      if (!url) return;
      const response = await fetch(url, { headers: headers(), method: "DELETE" });
      if (!response.ok) throw await failure(response);
    }),
  };
}

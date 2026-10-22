import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { CELL_GLOBALS, CELL_SCOPE } from "../cell.ts";
import type { CellEvaluator, CellHost } from "../hand.ts";

export type QuickJSOptions = { wasm?: WebAssembly.Module; memoryLimitBytes?: number; stackLimitBytes?: number; interruptChecks?: number };

const GUEST = String.raw`
const __decode = (encoded) => {
  const result = JSON.parse(encoded);
  if (result.ok) return result.value;
  throw result.error;
};
const __request = (input, init) => {
  const options = init ?? {};
  const url = typeof input === "string" ? input : input && typeof input.url === "string" ? input.url : String(input);
  const method = String(options.method ?? (input && input.method) ?? "GET").toUpperCase();
  const source = options.headers ?? (input && input.headers) ?? {};
  const headers = Array.isArray(source) ? source.map(([name, value]) => [String(name), String(value)])
    : typeof source.entries === "function" ? [...source.entries()].map(([name, value]) => [String(name), String(value)])
    : Object.entries(source).map(([name, value]) => [name, String(value)]);
  const body = options.body == null ? null : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  return { url, method, headers, body };
};
const __response = (encoded) => {
  const response = __decode(encoded);
  const headers = new Map(response.headers.map(([name, value]) => [name.toLowerCase(), value]));
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null, has: (name) => headers.has(String(name).toLowerCase()), entries: () => headers.entries(), forEach: (callback) => headers.forEach((value, name) => callback(value, name)) },
    text: async () => response.body,
    json: async () => JSON.parse(response.body),
  };
};
const __timers = new Map();
let __nextTimer = 0;
const __host = {
  call: (name, input) => __nanocode_call(name, JSON.stringify(input === undefined ? null : input)).then(__decode),
  content: (item) => __nanocode_emit("content", JSON.stringify(item)),
  notify: (text) => __nanocode_emit("notify", JSON.stringify(text)),
  yield: () => __nanocode_emit("yield", "null"),
  fetch: (input, init) => __nanocode_fetch(JSON.stringify(__request(input, init))).then(__response),
  bash: __nanocode_has_bash ? (script, stdin) => __nanocode_bash(JSON.stringify({ script: String(script), stdin: stdin === undefined ? null : String(stdin) })).then(__decode) : undefined,
  setTimeout: (callback, delay, ...values) => {
    if (typeof callback !== "function") throw new TypeError("setTimeout expects a function");
    const id = ++__nextTimer;
    __timers.set(id, () => callback(...values));
    __nanocode_sleep(Number(delay) || 0).then(() => {
      const run = __timers.get(id);
      __timers.delete(id);
      if (run) run();
    });
    return id;
  },
  clearTimeout: (id) => { __timers.delete(Number(id)); },
};
`;

function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item);
}

function failure(error: unknown): string {
  return encode({ ok: false, error: typeof error === "string" ? error : error instanceof Error ? error.message : error });
}

function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const fields = error as { message?: unknown; stack?: unknown; name?: unknown };
    const label = typeof fields.message === "string" ? (typeof fields.name === "string" ? fields.name + ": " + fields.message : fields.message) : undefined;
    if (typeof fields.stack === "string" && fields.stack.trim()) return label ? label + "\n" + fields.stack : fields.stack;
    if (label) return label;
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}

export function quickjs(options: QuickJSOptions = {}): CellEvaluator {
  let loading: Promise<QuickJSWASMModule> | undefined;
  return async (code, host, definitions, stored) => {
    const pending = loading ??= newQuickJSWASMModuleFromVariant(options.wasm ? newVariant(variant, { wasmModule: options.wasm }) : variant);
    let module: QuickJSWASMModule;
    try { module = await pending; } catch (error) { if (loading === pending) loading = undefined; throw error; }
    const vm: QuickJSContext = module.newContext();
    const runtime = vm.runtime;
    const signal = host.signal;
    let closed = false;
    const deferreds = new Set<QuickJSDeferredPromise>();
    runtime.setMemoryLimit(options.memoryLimitBytes ?? 64 * 1024 * 1024);
    runtime.setMaxStackSize(options.stackLimitBytes ?? 512 * 1024);
    const limit = options.interruptChecks ?? 20_000;
    let checks = 0;
    runtime.setInterruptHandler(() => closed || signal?.aborted === true || ++checks > limit);
    const pump = () => {
      if (closed) return;
      checks = 0;
      runtime.executePendingJobs();
    };
    const expose = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | void) => vm.newFunction(name, fn).consume(handle => vm.setProp(vm.global, name, handle));
    const later = (work: () => Promise<string>) => {
      const deferred = vm.newPromise();
      deferreds.add(deferred);
      void work().catch(failure).then(encoded => {
        if (closed) return;
        vm.newString(encoded).consume(handle => deferred.resolve(handle));
        deferreds.delete(deferred);
        deferred.dispose();
        pump();
      });
      return deferred.handle;
    };
    const run = (cellHost: CellHost) => {
      expose("__nanocode_call", (name, input) => {
        const tool = vm.getString(name);
        const value = JSON.parse(vm.getString(input));
        return later(async () => encode({ ok: true, value: await cellHost.call(tool, value) }));
      });
      expose("__nanocode_emit", (kind, payload) => {
        const type = vm.getString(kind);
        const value = JSON.parse(vm.getString(payload));
        if (type === "content") cellHost.content(value);
        else if (type === "notify") cellHost.notify(String(value));
        else if (type === "yield") cellHost.yield();
      });
      expose("__nanocode_fetch", request => {
        const { url, method, headers, body } = JSON.parse(vm.getString(request)) as { url: string; method: string; headers: [string, string][]; body: string | null };
        return later(async () => {
          const response = await cellHost.fetch(url, { method, headers, body });
          return encode({ ok: true, value: { status: response.status, statusText: response.statusText, url: response.url || url, headers: [...response.headers], body: await response.text() } });
        });
      });
      expose("__nanocode_bash", input => {
        const { script, stdin } = JSON.parse(vm.getString(input)) as { script: string; stdin: string | null };
        return later(async () => encode({ ok: true, value: await cellHost.bash!(script, stdin ?? undefined) }));
      });
      expose("__nanocode_sleep", delay => {
        const milliseconds = Math.min(Math.max(vm.getNumber(delay) || 0, 0), 2_147_483_647);
        return later(() => new Promise(resolve => cellHost.setTimeout ? cellHost.setTimeout(() => resolve(encode({ ok: true, value: null })), milliseconds) : setTimeout(() => resolve(encode({ ok: true, value: null })), milliseconds)));
      });
      vm.newString(encode(definitions)).consume(handle => vm.setProp(vm.global, "__nanocode_definitions", handle));
      vm.newString(encode(stored)).consume(handle => vm.setProp(vm.global, "__nanocode_stored", handle));
      vm.setProp(vm.global, "__nanocode_has_bash", cellHost.bash ? vm.true : vm.false);
    };
    try {
      run(host);
      const source = GUEST + "\n(async () => JSON.stringify(await (" + CELL_SCOPE + ")(__host, JSON.parse(__nanocode_definitions), JSON.parse(__nanocode_stored)).run(() => async function (" + CELL_GLOBALS.join(", ") + ") {\n" + code + "\n})))()";
      checks = 0;
      const started = vm.evalCode(source, "cell.js");
      if (started.error) {
        const error = vm.dump(started.error);
        started.error.dispose();
        return { error: message(error), stored: {} };
      }
      const promise = started.value!;
      try {
        const settling = vm.resolvePromise(promise);
        pump();
        const aborted = new Promise<never>((_, reject) => {
          if (signal?.aborted) reject(new Error("Code Mode cell ended"));
          signal?.addEventListener("abort", () => reject(new Error("Code Mode cell ended")), { once: true });
        });
        const settled = await Promise.race([settling, aborted]);
        if (settled.error) {
          const error = vm.dump(settled.error);
          settled.error.dispose();
          return { error: message(error), stored: {} };
        }
        const text = vm.getString(settled.value!);
        settled.value!.dispose();
        return JSON.parse(text);
      } finally {
        promise.dispose();
      }
    } catch (error) {
      return { error: message(error), stored: {} };
    } finally {
      closed = true;
      for (const deferred of deferreds) deferred.dispose();
      vm.dispose();
    }
  };
}

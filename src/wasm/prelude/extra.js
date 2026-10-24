const { callWasm, errorString, fromBase64, fromUtf8, host, setTimeoutWithArgs, show, toBase64, utf8 } = core;
const consoleState = { depth: 0, counts: new Map(), timers: new Map() };
const printArgs = (args) => {
  if (typeof args[0] === "string" && args.length > 1 && /%[sdifoOjc%]/.test(args[0])) {
    const rest = args.slice(1);
    const head = args[0].replace(/%([sdifoOjc%])/g, (match, kind) => {
      if (kind === "%") return "%";
      if (!rest.length) return match;
      const value = rest.shift();
      if (kind === "s") return typeof value === "string" ? value : show(value);
      if (kind === "d" || kind === "i") return typeof value === "bigint" ? value + "n" : String(kind === "i" ? Math.trunc(Number(value)) : Number(value));
      if (kind === "f") return String(Number(value));
      if (kind === "c") return "";
      return show(value);
    });
    return [head, ...rest.map(show)].join(" ");
  }
  return args.map(show).join(" ");
};
const out = (line) => host.text(consoleState.depth ? String(line).replace(/^/gm, "  ".repeat(consoleState.depth)) : String(line));
const tableCell = (value) => typeof value === "string" ? value : show(value);
const consoleTable = (data, columns) => {
  if (data === null || typeof data !== "object") return out(printArgs([data]));
  const rows = data instanceof Map ? [...data.entries()] : data instanceof Set ? [...data].map((value, index) => [index, value]) : Object.entries(data);
  const keys = [];
  let values = false;
  for (const [, row] of rows) {
    if (row !== null && typeof row === "object") { for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key); }
    else values = true;
  }
  const chosen = Array.isArray(columns) ? columns.map(String) : keys;
  const header = ["(index)", ...chosen, ...(values ? ["Values"] : [])];
  const body = rows.map(([index, row]) => {
    const object = row !== null && typeof row === "object";
    return [String(index), ...chosen.map((key) => object && key in row ? tableCell(row[key]) : ""), ...(values ? [object ? "" : tableCell(row)] : [])];
  });
  const widths = header.map((title, index) => Math.max(title.length, ...body.map((cells) => cells[index].length)));
  const rule = (left, middle, right) => left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right;
  const line = (cells) => "│" + cells.map((cell, index) => " " + cell.padEnd(widths[index]) + " ").join("│") + "│";
  out([rule("┌", "┬", "┐"), line(header), rule("├", "┼", "┤"), ...body.map(line), rule("└", "┴", "┘")].join("\n"));
};
const log = (...args) => out(printArgs(args));
const console = Object.freeze({
  log, info: log, debug: log, warn: log, error: log,
  dir: (value) => out(show(value)),
  dirxml: log,
  table: consoleTable,
  assert: (condition, ...args) => { if (!condition) out("Assertion failed" + (args.length ? ": " + printArgs(args) : "")); },
  count: (label = "default") => { const count = (consoleState.counts.get(label) ?? 0) + 1; consoleState.counts.set(label, count); out(label + ": " + count); },
  countReset: (label = "default") => { consoleState.counts.delete(label); },
  group: (...args) => { if (args.length) log(...args); consoleState.depth++; },
  groupCollapsed: (...args) => { if (args.length) log(...args); consoleState.depth++; },
  groupEnd: () => { consoleState.depth = Math.max(0, consoleState.depth - 1); },
  time: (label = "default") => { consoleState.timers.set(label, performance.now()); },
  timeLog: (label = "default", ...args) => { const start = consoleState.timers.get(label); out(start === undefined ? "Timer '" + label + "' does not exist" : label + ": " + (performance.now() - start).toFixed(3) + "ms" + (args.length ? " " + printArgs(args) : "")); },
  timeEnd: (label = "default") => { const start = consoleState.timers.get(label); consoleState.timers.delete(label); out(start === undefined ? "Timer '" + label + "' does not exist" : label + ": " + (performance.now() - start).toFixed(3) + "ms"); },
  trace: (...args) => out("Trace" + (args.length ? ": " + printArgs(args) : "") + "\n" + String(new Error().stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)).slice(1).join("\n")),
  clear: () => {},
});
const moduleHint = (name) => {
  const bare = String(name).replace(/^node:/, "").split("/")[0];
  if (bare === "fs" || bare === "path" || bare === "os") return "Use bash(...) for shell commands and bash.readFile(path) / bash.writeFile(path, data) for files.";
  if (bare === "child_process") return "Use bash(...) to run commands.";
  if (bare === "crypto") return "Use the global crypto (getRandomValues, randomUUID, subtle.digest, HMAC through subtle.importKey and subtle.sign).";
  if (bare === "buffer") return "Use the global Buffer.";
  if (bare === "http" || bare === "https" || bare === "node-fetch" || bare === "axios" || bare === "undici") return "Use the global fetch.";
  if (bare === "url" || bare === "querystring") return "Use the global URL and URLSearchParams.";
  if (bare === "util") return "Use JSON.stringify, TextEncoder and TextDecoder.";
  return "Use fetch, bash, tools.* and the built-in globals instead.";
};
const require = (name) => { throw new Error("require(" + JSON.stringify(String(name)) + ") is not available: Code Mode cells run in QuickJS, not Node.js, and cannot load modules or npm packages. " + moduleHint(name)); };
require.resolve = require;
const stdio = { write: (chunk) => { const line = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? fromUtf8(chunk) : String(chunk); if (line) out(line.replace(/\n$/, "")); return true; }, isTTY: false, columns: 80 };
const hrtime = (previous) => {
  const now = performance.now();
  let seconds = Math.floor(now / 1000), nanos = Math.floor((now % 1000) * 1e6);
  if (Array.isArray(previous)) { seconds -= previous[0]; nanos -= previous[1]; if (nanos < 0) { seconds--; nanos += 1e9; } }
  return [seconds, nanos];
};
hrtime.bigint = () => BigInt(Math.floor(performance.now() * 1e6));
const process = {
  env: {},
  argv: ["quickjs"],
  execArgv: [],
  platform: "quickjs",
  arch: "wasm32",
  version: "",
  versions: {},
  pid: 1,
  title: "quickjs",
  release: { name: "quickjs" },
  stdout: stdio,
  stderr: stdio,
  cwd: () => { throw new Error("process.cwd() is not available in a Code Mode cell (QuickJS, not Node.js): run (await bash('pwd')).stdout for the shell's directory"); },
  exit: () => host.exit(),
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
  hrtime,
  uptime: () => performance.now() / 1000,
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  emitWarning: (warning) => log("Warning:", warning),
  on() { return process; },
  once() { return process; },
  off() { return process; },
  removeListener() { return process; },
};
class Event {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.timeStamp = performance.now();
    this.target = null;
    this.currentTarget = null;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() {}
  stopImmediatePropagation() { this.stopped = true; }
}
class CustomEvent extends Event {
  constructor(type, init = {}) { super(type, init); this.detail = init.detail ?? null; }
}
class EventTarget {
  #listeners = new Map();
  addEventListener(type, listener, options) {
    if (!listener) return;
    const list = this.#listeners.get(type) ?? [];
    if (list.some((entry) => entry.listener === listener)) return;
    list.push({ listener, once: typeof options === "object" && Boolean(options?.once) });
    this.#listeners.set(type, list);
    if (typeof options === "object" && options?.signal) options.signal.addEventListener("abort", () => this.removeEventListener(type, listener), { once: true });
  }
  removeEventListener(type, listener) {
    const list = this.#listeners.get(type);
    if (list) this.#listeners.set(type, list.filter((entry) => entry.listener !== listener));
  }
  dispatchEvent(event) {
    if (event.target === null) event.target = this;
    event.currentTarget = this;
    const handler = this["on" + event.type];
    const list = [...(this.#listeners.get(event.type) ?? [])];
    if (typeof handler === "function") list.unshift({ listener: handler });
    for (const entry of list) {
      if (entry.once) this.removeEventListener(event.type, entry.listener);
      try {
        if (typeof entry.listener === "function") entry.listener.call(this, event);
        else entry.listener.handleEvent?.(event);
      } catch (error) { out("Uncaught " + show(error)); }
      if (event.stopped) break;
    }
    return !event.defaultPrevented;
  }
}
class AbortSignal extends EventTarget {
  aborted = false;
  reason = undefined;
  onabort = null;
  throwIfAborted() { if (this.aborted) throw this.reason; }
  static abort(reason) { const controller = new AbortController(); controller.abort(reason); return controller.signal; }
  static timeout(milliseconds) { const controller = new AbortController(); setTimeoutWithArgs(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), milliseconds); return controller.signal; }
  static any(signals) {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) { controller.abort(signal.reason); break; }
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  }
}
class AbortController {
  signal = new AbortSignal();
  abort(reason = new DOMException("This operation was aborted", "AbortError")) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason;
    this.signal.dispatchEvent(new Event("abort"));
  }
}
const toWire = (value) => typeof value === "bigint" ? { bigint: String(value) } : value;
const fromWire = (value) => Array.isArray(value) ? value.map(fromWire) : value !== null && typeof value === "object" && typeof value.bigint === "string" ? BigInt(value.bigint) : value;
const wasmSource = (source) => {
  if (typeof source === "string") return { path: source };
  if (source instanceof Module) return source.input;
  if (source instanceof ArrayBuffer) return { module: toBase64(new Uint8Array(source)) };
  if (ArrayBuffer.isView(source)) return { module: toBase64(new Uint8Array(source.buffer, source.byteOffset, source.byteLength)) };
  if (Array.isArray(source)) return { module: toBase64(Uint8Array.from(source)) };
  throw new TypeError("expected WebAssembly bytes (Uint8Array or ArrayBuffer) or a file path");
};
const importHint = (error, imports) => {
  const names = [];
  for (const [module, entries] of Object.entries(imports ?? {})) for (const [name, value] of Object.entries(entries ?? {})) if (typeof value === "function" || value instanceof Memory) names.push(module + "." + name);
  return names.length ? new Error(error.message + " (the JavaScript imports " + names.join(", ") + " are not linked: cell WebAssembly runs in the host, which provides only WASI preview1 imports)") : error;
};
class Module {
  constructor(source) { this.input = wasmSource(source); }
}
class Memory {
  constructor(id) { this.id = id; }
  get buffer() { throw new Error("memory lives in the host: use await memory.read(offset, length) and await memory.write(offset, bytes)"); }
  async read(offset = 0, length) { const reply = await callWasm({ op: "read", id: this.id, offset, ...(length === undefined ? {} : { length }) }); return fromBase64(reply.data); }
  async write(offset, bytes) { await callWasm({ op: "write", id: this.id, offset, data: toBase64(bytes instanceof Uint8Array ? bytes : typeof bytes === "string" ? utf8(bytes) : new Uint8Array(bytes)) }); }
  async grow(pages) { return (await callWasm({ op: "grow", id: this.id, pages })).previous; }
}
const exportsOf = (id, list, imports) => {
  const exports = {};
  for (const entry of list) {
    if (entry.kind === "function") exports[entry.name] = async (...args) => fromWire((await callWasm({ op: "call", id, name: entry.name, args: args.map(toWire) }).catch((error) => { throw importHint(error, imports); })).result);
    else if (entry.kind === "memory") exports[entry.name] = new Memory(id);
  }
  return Object.freeze(exports);
};
class Instance {
  constructor(module, imports) {
    const ready = callWasm({ op: "instantiate", ...wasmSource(module) });
    this.ready = ready.then((reply) => { this.id = reply.id; this.engine = reply.engine; this.exports = exportsOf(reply.id, reply.exports, imports); return this; }, (error) => { throw importHint(error, imports); });
    this.ready.catch(() => {});
    this.exports = new Proxy({}, { get: (_, name) => typeof name !== "string" || name === "then" ? undefined : async (...args) => (await this.ready).exports[name](...args) });
  }
  async close() { await this.ready; await callWasm({ op: "drop", id: this.id }); }
}
const instantiate = async (source, imports) => {
  const instance = new Instance(source instanceof Module ? source : new Module(source), imports);
  await instance.ready;
  return source instanceof Module ? instance : { module: new Module(source), instance };
};
const WebAssembly = {
  Module,
  Instance,
  Memory,
  compile: async (source) => new Module(source),
  instantiate,
  compileStreaming: async (response) => new Module(new Uint8Array(await (await response).arrayBuffer())),
  instantiateStreaming: async (response, imports) => instantiate(new Uint8Array(await (await response).arrayBuffer()), imports),
  validate: (source) => { const input = wasmSource(source); const bytes = input.module ? fromBase64(input.module) : null; return !bytes || (bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d); },
};
const wasm = {
  run: async (source, args = [], options = {}) => {
    const reply = await callWasm({ op: "run", ...wasmSource(source), args: args.map(String), ...(options.stdin === undefined ? {} : { stdin: String(options.stdin) }), ...(options.env ? { env: options.env } : {}) });
    return { stdout: reply.stdout, stderr: reply.stderr, exitCode: reply.exit_code };
  },
  invoke: async (source, name, ...args) => fromWire((await callWasm({ op: "invoke", ...wasmSource(source), name, args: args.map(toWire) })).result),
  instantiate: async (source) => (await instantiate(source instanceof Module ? source : new Module(source))),
};
return { AbortController, AbortSignal, CustomEvent, Event, EventTarget, WebAssembly, console, process, require, wasm };

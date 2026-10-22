import type { RemoteRequest } from "./contracts.ts";

export type LocalHandOptions = {
  name?: string;
  fetch?: typeof fetch;
  globals?: Record<string, unknown>;
  max_frame_bytes?: number;
  timeout_ms?: number;
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Context = Record<string, Json>;
type Content = Record<string, Json>;
type Nested = { call_id: string; name: string; input: Json; output: Json; structured_result: Json; success: boolean; started_after_ns: number; duration_ns: number; metadata: null };
type Notification = { call_id: string; text: string };
type Execution = { cell: { origin_call_id: string; running: boolean } | null; output: string | Content[]; success: boolean; nested_calls: Nested[]; notifications: Notification[] };
type Definition = { name: string; tool_name: string; kind: "function" | "freeform"; description: string; parameters: Json };
type Callback = { resolve(value: Json): void; reject(error: unknown): void };
type Session = { id: string; cells: Map<number, Cell>; next: number; stored: Map<string, Json> };

const BUDGET_MAX = "18446744073709551615";
const INITIAL_YIELD_MS = 10_000;
const OBSERVER_GRACE_MS = 1_000;
const TIMER_LIMIT_MS = 2_147_483_647;
const PRAGMA = "// @exec:";
const NOT_RECEIVED = "the hand never received this operation before its connection dropped; it was not dispatched";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...parameters: string[]) => (...values: unknown[]) => Promise<unknown>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decode(text: string): any {
  return JSON.parse(text.replace(/"output_token_budget":18446744073709551615(?=[,}])/g, '"output_token_budget":-1'));
}

function encode(frame: unknown): string {
  return JSON.stringify(frame).replace(/"output_token_budget":-1(?=[,}])/g, '"output_token_budget":' + BUDGET_MAX);
}

function stringify(value: unknown): string {
  if (value === null || ["undefined", "boolean", "number", "bigint", "string"].includes(typeof value)) return String(value);
  if (Object.prototype.toString.call(value) === "[object Error]") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function scriptStack(stack: unknown): string {
  if (typeof stack !== "string") return "";
  return stack.split("\n").filter(line => !/^\s+at /.test(line) || line.includes("<anonymous>")).map(line => line.replace(/eval at .*?\), (<anonymous>)/, "$1")).join("\n");
}

function errorText(error: any): string {
  if (!error) return String(error);
  const message = error.message;
  const label = message && error.name ? error.name + ": " + message : message;
  const stack = scriptStack(error.stack);
  if (stack && label && !stack.startsWith(label)) return label + "\n" + stack;
  return stack || label || String(error);
}

function dataUrl(block: any): string {
  const mime = block.mimeType ?? block.mime_type;
  return /^data:/i.test(block.data) ? block.data : "data:" + (typeof mime === "string" && mime ? mime : "application/octet-stream") + ";base64," + block.data;
}

function normalizeImage(value: any, detail?: unknown): Content {
  const expected = "image expects a non-empty image URL string, an object with exactly one of image_url or file_id and optional detail, or a raw MCP image block";
  if (detail != null && typeof detail !== "string") throw "image detail must be a string when provided";
  let url: string | undefined;
  let fileId: string | undefined;
  let embedded: unknown;
  if (typeof value === "string") url = value;
  else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (value.file_id !== undefined) {
      if (value.image_url !== undefined || typeof value.file_id !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(value.file_id)) throw "image file_id is malformed or ambiguous";
      fileId = value.file_id;
      embedded = value.detail;
      if (embedded != null && typeof embedded !== "string") throw "image detail must be a string when provided";
    } else if (value.image_url !== undefined) {
      url = value.image_url;
      if (typeof url !== "string") throw expected;
      embedded = value.detail;
      if (embedded != null && typeof embedded !== "string") throw "image detail must be a string when provided";
    } else {
      const block = JSON.parse(JSON.stringify(value));
      if (typeof block?.type !== "string") throw expected;
      if (block.type !== "image") throw 'image only accepts MCP image blocks, got "' + block.type + '"';
      if (typeof block.data !== "string" || !block.data) throw "image expected MCP image data";
      url = dataUrl(block);
      const metadata = block._meta?.["codex/imageDetail"];
      if (["auto", "low", "high", "original"].includes(metadata)) embedded = metadata;
    }
  } else throw expected;
  if (!url && !fileId) throw expected;
  if (url && /^https?:/i.test(url)) throw "Tool call failed: remote image URLs are not supported in tool outputs. Pass a base64 data URI instead";
  if (url && !/^data:/i.test(url)) throw "Tool call failed: invalid image output. Pass a base64 data URI instead";
  const selected = String(detail ?? embedded ?? "high").replace(/[A-Z]/g, character => character.toLowerCase());
  if (!["auto", "low", "high", "original"].includes(selected)) throw "image detail must be one of: auto, low, high, original";
  return { type: "input_image", ...(fileId ? { file_id: fileId } : { image_url: url as string }), detail: selected };
}

function normalizeAudio(value: any): Content {
  const expected = "audio expects a non-empty audio URL string, an object with audio_url, or a raw MCP audio block";
  let url: string | undefined;
  if (typeof value === "string") url = value;
  else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (value.audio_url !== undefined) {
      url = value.audio_url;
      if (typeof url !== "string") throw expected;
    } else {
      const block = JSON.parse(JSON.stringify(value));
      if (typeof block?.type !== "string") throw expected;
      if (block.type !== "audio") throw 'audio only accepts MCP audio blocks, got "' + block.type + '"';
      if (typeof block.data !== "string" || !block.data) throw "audio expected MCP audio data";
      url = dataUrl(block);
    }
  } else throw expected;
  if (!url) throw expected;
  if (!/^data:/i.test(url)) throw "Tool call failed: invalid audio output. Pass a base64 data URI instead";
  return { type: "input_audio", audio_url: url };
}

function generatedImageItems(value: any): Content[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw "generatedImage expects an image generation result object";
  const hint = value.output_hint;
  if (hint !== undefined && typeof hint !== "string") throw "generatedImage output_hint must be a string when provided";
  return [normalizeImage(value), ...(hint === undefined ? [] : [{ type: "input_text", text: hint }])];
}

function identifier(name: string): string {
  let result = "";
  for (const [index, character] of [...name].entries()) {
    const valid = character === "_" || character === "$" || (index === 0 ? /^[A-Za-z]$/.test(character) : /^[A-Za-z0-9]$/.test(character));
    result += valid ? character : "_";
  }
  return result || "_";
}

function definitions(tools: any[]): Definition[] {
  return tools.flatMap((tool): Definition[] => {
    if (tool?.type === "namespace") return definitions(tool.tools ?? []);
    if (tool?.type !== "function" && tool?.type !== "custom") return [];
    return [{ name: identifier(tool.name), tool_name: tool.name, kind: tool.type === "custom" ? "freeform" : "function", description: tool.description ?? "", parameters: tool.type === "custom" ? null : tool.parameters ?? null }];
  });
}

function approxTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function sliceBytes(bytes: Uint8Array, start: number, end: number): string {
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end++;
  return decoder.decode(bytes.subarray(start, end));
}

function truncateMiddle(text: string, tokens: number): string {
  const bytes = encoder.encode(text);
  const budget = tokens * 4;
  if (!text) return "";
  if (tokens > 0 && bytes.length <= budget) return text;
  if (budget === 0) return "…" + approxTokens(bytes.length) + " tokens truncated…";
  let prefixEnd = Math.floor(budget / 2);
  while (prefixEnd > 0 && (bytes[prefixEnd]! & 0xc0) === 0x80) prefixEnd--;
  let suffixStart = Math.max(bytes.length - (budget - Math.floor(budget / 2)), 0);
  while (suffixStart < bytes.length && (bytes[suffixStart]! & 0xc0) === 0x80) suffixStart++;
  suffixStart = Math.max(suffixStart, prefixEnd);
  return decoder.decode(bytes.subarray(0, prefixEnd)) + "…" + approxTokens(bytes.length - budget) + " tokens truncated…" + sliceBytes(bytes, suffixStart, bytes.length);
}

function truncate(content: Content[], tokens: number | null): Content[] {
  if (tokens === null || tokens >= Number.MAX_SAFE_INTEGER) return content;
  if (content.every(item => item.type === "input_text")) {
    const text = content.map(item => item.text as string).join("\n");
    if (encoder.encode(text).length <= tokens * 4) return content;
    return [{ type: "input_text", text: "Warning: truncated output (original token count: " + approxTokens(encoder.encode(text).length) + ")\nTotal output lines: " + text.split("\n").length + "\n\n" + truncateMiddle(text, tokens) }];
  }
  const output: Content[] = [];
  let remaining = tokens;
  let omitted = 0;
  for (const item of content) {
    if (item.type !== "input_text") {
      output.push(item);
      continue;
    }
    const text = item.text as string;
    if (!text) continue;
    if (remaining === 0) { omitted++; continue; }
    const cost = approxTokens(encoder.encode(text).length);
    if (cost <= remaining) {
      output.push(item);
      remaining -= cost;
      continue;
    }
    const snippet = truncateMiddle(text, remaining);
    if (snippet) output.push({ type: "input_text", text: snippet });
    else omitted++;
    remaining = 0;
  }
  if (omitted) output.push({ type: "input_text", text: "[omitted " + omitted + " text items ...]" });
  return output;
}

function pragma(input: string): { code: string; yield_time_ms?: number; max_output_tokens?: number } {
  if (!input.trim()) throw new Error('exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with first-line ' + "\u0060" + '// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}' + "\u0060" + ".");
  const newline = input.indexOf("\n");
  const first = newline < 0 ? input : input.slice(0, newline);
  const rest = newline < 0 ? "" : input.slice(newline + 1);
  const trimmed = first.trimStart();
  if (!trimmed.startsWith(PRAGMA)) return { code: input };
  if (!rest.trim()) throw new Error("exec pragma must be followed by JavaScript source on subsequent lines");
  const directive = trimmed.slice(PRAGMA.length).trim();
  const fields = "\u0060yield_time_ms\u0060 and \u0060max_output_tokens\u0060";
  if (!directive) throw new Error("exec pragma must be a JSON object with supported fields " + fields);
  let value: any;
  try { value = JSON.parse(directive); } catch (error) { throw new Error("exec pragma must be valid JSON with supported fields " + fields + ": " + (error as Error).message); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("exec pragma must be a JSON object with supported fields " + fields);
  const unknown = Object.keys(value).find(key => key !== "yield_time_ms" && key !== "max_output_tokens");
  if (unknown) throw new Error("exec pragma only supports \u0060yield_time_ms\u0060 and \u0060max_output_tokens\u0060; got \u0060" + unknown + "\u0060");
  for (const key of ["yield_time_ms", "max_output_tokens"] as const) {
    if (value[key] !== undefined && value[key] !== null && !(Number.isSafeInteger(value[key]) && value[key] >= 0)) throw new Error("exec pragma field \u0060" + key + "\u0060 must be a non-negative safe integer");
  }
  return { code: rest, yield_time_ms: value.yield_time_ms ?? undefined, max_output_tokens: value.max_output_tokens ?? undefined };
}

function observerYield(milliseconds: number): number {
  return milliseconds >= 10_000 ? milliseconds + OBSERVER_GRACE_MS : milliseconds;
}

class Cell {
  readonly id: number;
  readonly origin: string;
  readonly session: Session;
  readonly context: Context;
  readonly budget: number;
  readonly controller = new AbortController();
  readonly started = performance.now();
  status: "running" | "completed" | "failed" | "terminated" = "running";
  error = "";
  yielded = false;
  detached = false;
  observer: number | undefined;
  wake: (() => void) | undefined;
  content: Content[] = [];
  nested: Nested[] = [];
  notifications: Notification[] = [];
  queued: Json[] = [];
  readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly callbacks = new Set<number>();
  private nextTool = 0;
  private nextTimer = 0;
  private readonly hand: LocalHand;

  constructor(hand: LocalHand, session: Session, id: number, context: Context, budget: number) {
    this.hand = hand;
    this.session = session;
    this.id = id;
    this.context = context;
    this.origin = String(context.call_id);
    this.budget = budget;
  }

  emit(update: Json) {
    if (this.observer !== undefined) this.hand.send({ type: "update", id: this.observer, update });
    else if (this.detached) this.hand.send({ type: "detached_update", session_id: this.session.id, origin_call_id: this.origin, update });
    else this.queued.push(update);
  }

  changed() {
    this.wake?.();
  }

  finish(status: "completed" | "failed" | "terminated", error = "") {
    if (this.status !== "running") return;
    this.status = status;
    this.error = error;
    this.controller.abort(new Error("Code Mode cell ended"));
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const id of this.callbacks) this.hand.abandon(id);
    this.callbacks.clear();
    if (this.detached && this.observer === undefined) this.hand.send({ type: "detached_complete", session_id: this.session.id, origin_call_id: this.origin });
    this.changed();
  }

  async run(code: string, tools: Definition[], fetcher: typeof fetch, globals: Record<string, unknown>) {
    const stored = new Map(this.session.stored);
    const writes = new Map<string, Json>();
    const EXIT = Symbol("exit");
    const live = () => this.status === "running";
    const invoke = (definition: Definition, input: unknown) => this.call(definition, input === undefined && definition.kind === "function" ? {} : input);
    const declared = new Map(tools.map(definition => [definition.name, definition]));
    const target = Object.create(null);
    for (const [name, definition] of declared) {
      Object.defineProperty(target, name, {
        enumerable: true,
        value(input: unknown) {
          const promise = invoke(definition, input);
          promise.catch(() => {});
          return promise;
        },
      });
    }
    Object.freeze(target);
    const toolsProxy = new Proxy(target, {
      get(object, name) {
        if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
        if (typeof name !== "string" || name === "then") return undefined;
        return () => {
          const error: any = new Error('TOOL_NOT_AVAILABLE: Tool "' + name + '" is not available in this Code Mode execution. Check ALL_TOOLS for callable names. A tool exposed directly by the host may need to be called through its direct tool entry instead.');
          error.code = "TOOL_NOT_AVAILABLE";
          error.tool = name;
          const promise = Promise.reject(error);
          promise.catch(() => {});
          return promise;
        };
      },
    });
    const allTools = Object.freeze(tools.map(tool => Object.freeze({ name: tool.name, description: tool.description })));
    const toolSchema = (name: unknown) => {
      if (typeof name !== "string" || !name) throw "toolSchema expects a non-empty tool name";
      const tool = tools.find(entry => entry.name === name || entry.tool_name === name);
      return tool ? { inputSchema: structuredClone(tool.parameters), outputSchema: null } : undefined;
    };
    const push = (item: Content) => {
      if (!live()) return;
      this.content.push(item);
    };
    const text = (value: unknown) => push({ type: "input_text", text: stringify(value) });
    const image = (value: unknown, detail?: unknown) => push(normalizeImage(value, detail));
    const audio = (value: unknown) => push(normalizeAudio(value));
    const generatedImage = (value: unknown) => { for (const item of generatedImageItems(value)) push(item); };
    const notify = (value: unknown) => {
      const notification = stringify(value);
      if (!notification.trim()) throw "notify expects non-empty text";
      if (!live()) return;
      const entry = { call_id: this.origin, text: notification };
      this.notifications.push(entry);
      this.emit({ notification: entry });
    };
    const key = (value: unknown, helper: string) => {
      try { return String(value); } catch { throw helper + " key must be a string"; }
    };
    const store = (name: unknown, value: unknown) => {
      const normalized = key(name, "store");
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw "Unable to store " + JSON.stringify(normalized) + ". Only plain serializable objects can be stored.";
      stored.set(normalized, JSON.parse(encoded));
      writes.set(normalized, JSON.parse(encoded));
    };
    const load = (name: unknown) => {
      const normalized = key(name, "load");
      return stored.has(normalized) ? structuredClone(stored.get(normalized)) : undefined;
    };
    const yieldControl = () => {
      if (!live()) return;
      this.yielded = true;
      this.changed();
    };
    const exit = () => { throw EXIT; };
    const setTimer = (callback: unknown, delay?: unknown, ...rest: unknown[]) => {
      if (typeof callback !== "function") throw new TypeError("setTimeout expects a function");
      const id = ++this.nextTimer;
      const milliseconds = Math.min(Math.max(Number(delay) || 0, 0), TIMER_LIMIT_MS);
      this.timers.set(id, setTimeout(() => {
        this.timers.delete(id);
        if (live()) callback(...rest);
      }, milliseconds));
      return id;
    };
    const clearTimer = (id?: unknown) => {
      const timer = this.timers.get(Number(id));
      if (timer === undefined) return;
      clearTimeout(timer);
      this.timers.delete(Number(id));
    };
    const signal = this.controller.signal;
    const cellFetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const signals = [signal, init?.signal, input instanceof Request ? input.signal : undefined].filter((entry): entry is AbortSignal => !!entry);
      const combined = signals.length > 1 && typeof AbortSignal.any === "function" ? AbortSignal.any(signals) : signal;
      return fetcher(input, { ...init, signal: combined });
    };
    const names = ["tools", "ALL_TOOLS", "toolSchema", "text", "image", "audio", "generatedImage", "notify", "store", "load", "yield_control", "exit", "setTimeout", "clearTimeout", "fetch", ...Object.keys(globals)];
    const values = [toolsProxy, allTools, toolSchema, text, image, audio, generatedImage, notify, store, load, yieldControl, exit, setTimer, clearTimer, cellFetch, ...Object.values(globals)];
    let failure: string | undefined;
    try {
      const script = new AsyncFunction(...names, code);
      try {
        await script(...values);
      } catch (error) {
        if (error !== EXIT) throw error;
      }
    } catch (error) {
      failure = errorText(error);
    }
    if (!live()) return;
    for (const [name, value] of writes) this.session.stored.set(name, value);
    if (failure === undefined) this.finish("completed");
    else this.finish("failed", failure);
  }

  private call(definition: Definition, input: unknown): Promise<unknown> {
    if (!this.live()) return Promise.reject("Code Mode cell ended");
    const call_id = this.origin + "/code-" + ++this.nextTool;
    const value = (input === undefined ? null : JSON.parse(JSON.stringify(input))) as Json;
    const started = performance.now();
    this.emit({ call_id, name: definition.tool_name, input: value });
    return new Promise((resolve, reject) => {
      const record = (output: Json, structured: Json, success: boolean) => {
        const call: Nested = { call_id, name: definition.tool_name, input: value, output, structured_result: structured, success, started_after_ns: Math.round((started - this.started) * 1e6), duration_ns: Math.round((performance.now() - started) * 1e6), metadata: null };
        if (!this.live()) return false;
        this.nested.push(call);
        this.emit({ completed: call });
        return true;
      };
      const id = this.hand.callback({ name: definition.tool_name, input: value, freeform: definition.kind === "freeform", context: { ...this.context, call_id, output_token_budget: this.budget } }, {
        resolve: (wire: any) => {
          const output = (wire?.output ?? null) as Json;
          const structured = (wire?.structured_result ?? output) as Json;
          const success = wire?.success !== false;
          this.callbacks.delete(id);
          if (!record(output, structured, success)) return;
          if (success) resolve(structured);
          else reject(structured);
        },
        reject: (error: unknown) => {
          const message = typeof error === "string" ? error : errorText(error);
          this.callbacks.delete(id);
          if (!record(message, message, false)) return;
          reject(message);
        },
      });
      this.callbacks.add(id);
    });
  }

  private live() {
    return this.status === "running";
  }
}

export class LocalHand {
  readonly name: string;
  readonly #fetch: typeof fetch;
  readonly #globals: Record<string, unknown>;
  readonly #maxFrameBytes: number;
  readonly #timeoutMs: number;
  readonly #sessions = new Map<string, Session>();
  readonly #callbacks = new Map<number, Callback>();
  #frames: string[] = [];
  #waiter: { id: number; resolve(value: unknown): void } | undefined;
  #nextCallback = 0;
  #closed: string | undefined;

  constructor(options: LocalHandOptions = {}) {
    this.name = options.name ?? "local";
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#globals = options.globals ?? {};
    this.#maxFrameBytes = options.max_frame_bytes ?? 64 * 1024 * 1024;
    this.#timeoutMs = options.timeout_ms ?? 300_000;
  }

  failed(): boolean {
    return this.#closed !== undefined;
  }

  async execute(request: RemoteRequest, id: number): Promise<unknown> {
    switch (request.op) {
      case "remote_catalog":
        return { frame: encode({ type: "catalog", definitions: [], name: this.name, max_frame_bytes: this.#maxFrameBytes }), max_frame_bytes: this.#maxFrameBytes, timeout_ms: this.#timeoutMs };
      case "remote_send":
        if (this.#closed !== undefined) throw new Error(this.#closed);
        for (const frame of request.frames ?? []) this.#receive(decode(frame));
        return null;
      case "remote_poll":
        if (this.#frames.length) return { frames: this.#frames.splice(0) };
        if (this.#closed !== undefined) return { closed: this.#closed };
        if (this.#waiter) throw new Error("remote_poll is already pending");
        return new Promise(resolve => { this.#waiter = { id, resolve }; });
      case "remote_close":
        this.#close(String(request.reason ?? "remote executor closed"));
        return null;
      default:
        throw new Error("unsupported remote operation " + request.op);
    }
  }

  cancel(id: number): void {
    if (this.#waiter?.id !== id) return;
    this.#waiter.resolve(null);
    this.#waiter = undefined;
  }

  async dispose(): Promise<void> {
    this.#close("remote executor disposed");
  }

  send(frame: unknown): void {
    if (this.#closed !== undefined) return;
    this.#frames.push(encode(frame));
    const waiter = this.#waiter;
    if (!waiter) return;
    this.#waiter = undefined;
    waiter.resolve({ frames: this.#frames.splice(0) });
  }

  callback(call: { name: string; input: Json; freeform: boolean; context: Context }, handler: Callback): number {
    const id = ++this.#nextCallback;
    this.#callbacks.set(id, handler);
    this.send({ type: "callback", id, ...call });
    return id;
  }

  abandon(id: number): void {
    if (this.#callbacks.delete(id)) this.send({ type: "callback_cancel", id });
  }

  #close(reason: string) {
    if (this.#closed !== undefined) return;
    for (const session of this.#sessions.values()) for (const cell of session.cells.values()) cell.finish("terminated");
    this.#sessions.clear();
    this.#closed = reason;
    for (const handler of this.#callbacks.values()) handler.reject(reason);
    this.#callbacks.clear();
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.resolve({ closed: reason });
  }

  #session(id: string): Session {
    let session = this.#sessions.get(id);
    if (!session) {
      session = { id, cells: new Map(), next: 1, stored: new Map() };
      this.#sessions.set(id, session);
    }
    return session;
  }

  #reply(id: number, result: { Ok: unknown } | { Err: string }) {
    this.send({ type: "reply", id, result });
  }

  #receive(frame: any) {
    switch (frame?.type) {
      case "callback_result": {
        const handler = this.#callbacks.get(frame.id);
        if (!handler) return;
        this.#callbacks.delete(frame.id);
        if ("Ok" in frame.result) handler.resolve(frame.result.Ok);
        else handler.reject(frame.result.Err);
        return;
      }
      case "ack":
        return;
      case "resume":
        for (const id of frame.pending ?? []) this.#reply(id, { Err: NOT_RECEIVED });
        return;
      case "request":
        void this.#request(frame.id, frame.operation).then(
          value => this.#reply(frame.id, { Ok: value ?? null }),
          error => this.#reply(frame.id, { Err: error instanceof Error ? error.message : String(error) }),
        );
        return;
      default:
        this.#close("unexpected brain frame");
    }
  }

  async #request(id: number, operation: any): Promise<unknown> {
    const [kind] = Object.keys(operation ?? {});
    const body = kind ? operation[kind] : undefined;
    switch (kind) {
      case "Execute": return this.#exec(id, body);
      case "Wait": return this.#wait(id, body);
      case "Call": throw new Error("this hand has no tools of its own; " + body?.name + " runs on the brain");
      case "BeginTurn":
      case "SettlePreempt":
        return null;
      case "Preempt":
        for (const cell of this.#sessions.get(body.session_id)?.cells.values() ?? []) if (cell.observer !== undefined) { cell.yielded = true; cell.changed(); }
        return null;
      case "DetachTurn":
        for (const cell of this.#sessions.get(body.session_id)?.cells.values() ?? []) {
          if (cell.status !== "running" || cell.observer !== undefined) continue;
          cell.detached = true;
          for (const update of cell.queued.splice(0)) cell.emit(update);
        }
        return null;
      case "CancelTurn":
      case "Cancel": {
        const session = this.#sessions.get(body.session_id);
        for (const cell of session?.cells.values() ?? []) cell.finish("terminated");
        if (kind === "Cancel") this.#sessions.delete(body.session_id);
        else session?.cells.clear();
        return null;
      }
      default:
        throw new Error("unsupported remote operation " + kind);
    }
  }

  #exec(id: number, body: { source: string; context: Context; local_tools: any[] }): Promise<Execution> | Execution {
    const started = performance.now();
    let parsed: ReturnType<typeof pragma>;
    try {
      parsed = pragma(body.source);
    } catch (error) {
      return failed(started, (error as Error).message);
    }
    const session = this.#session(String(body.context.session_id));
    const budget = parsed.max_output_tokens ?? -1;
    const cell = new Cell(this, session, session.next++, body.context, budget);
    session.cells.set(cell.id, cell);
    void cell.run(parsed.code, definitions(body.local_tools ?? []), this.#fetch, this.#globals);
    return this.#observe(cell, id, started, observerYield(parsed.yield_time_ms ?? INITIAL_YIELD_MS), parsed.max_output_tokens ?? null);
  }

  #wait(id: number, body: { input: string; context: Context }): Promise<Execution> | Execution {
    const started = performance.now();
    let input: any;
    try {
      input = JSON.parse(body.input);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected an object");
      if (typeof input.cell_id !== "string") throw new Error("missing field \u0060cell_id\u0060");
      if (input.yield_time_ms !== undefined && !(typeof input.yield_time_ms === "number" && input.yield_time_ms >= 0)) throw new Error("invalid type: expected u64 for \u0060yield_time_ms\u0060");
      if (input.terminate !== undefined && typeof input.terminate !== "boolean") throw new Error("invalid type: expected a boolean for \u0060terminate\u0060");
      if (input.max_tokens != null && !(Number.isSafeInteger(input.max_tokens) && input.max_tokens >= 0)) throw new Error("invalid type: expected usize for \u0060max_tokens\u0060");
    } catch (error) {
      return failed(started, "failed to parse wait arguments: " + (error as Error).message);
    }
    if (!/^\d+$/.test(input.cell_id)) return failed(started, "invalid exec cell ID \u0060" + input.cell_id + "\u0060: invalid digit found in string");
    const cell = this.#sessions.get(String(body.context.session_id))?.cells.get(Number(input.cell_id)) ?? [...this.#sessions.values()].map(session => session.cells.get(Number(input.cell_id))).find(found => found);
    if (!cell) return failed(started, "exec cell " + input.cell_id + " not found");
    if (cell.observer !== undefined) return failed(started, "exec cell " + input.cell_id + " already has an active observer");
    if (input.terminate) {
      cell.finish("terminated");
      return this.#observe(cell, id, started, null, input.max_tokens ?? null);
    }
    return this.#observe(cell, id, started, observerYield(input.yield_time_ms ?? INITIAL_YIELD_MS), input.max_tokens ?? null);
  }

  #observe(cell: Cell, id: number, started: number, yieldMs: number | null, tokens: number | null): Promise<Execution> {
    cell.observer = id;
    cell.detached = false;
    for (const update of cell.queued.splice(0)) cell.emit(update);
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (running: boolean) => {
        if (timer !== undefined) clearTimeout(timer);
        cell.wake = undefined;
        cell.observer = undefined;
        const content = cell.content.splice(0);
        const nested = cell.nested.splice(0);
        const notifications = cell.notifications.splice(0);
        let status = "Script running with cell ID " + cell.id;
        let success = true;
        if (!running) {
          cell.session.cells.delete(cell.id);
          if (cell.status === "completed") status = "Script completed";
          else if (cell.status === "terminated") status = "Script terminated";
          else {
            status = "Script failed";
            success = false;
            content.push({ type: "input_text", text: "Script error:\n" + cell.error });
          }
        }
        resolve({ ...observed(status, success, started, truncate(content, tokens), nested, notifications), cell: { origin_call_id: cell.origin, running } });
      };
      cell.wake = () => {
        if (cell.status !== "running") return settle(false);
        if (cell.yielded) {
          cell.yielded = false;
          settle(true);
        }
      };
      if (yieldMs !== null && yieldMs < TIMER_LIMIT_MS) timer = setTimeout(() => settle(true), yieldMs);
      cell.wake();
    });
  }
}

function header(status: string, started: number): string {
  return status + "\nWall time " + ((performance.now() - started) / 1000).toFixed(1) + " seconds\nOutput:\n";
}

function observed(status: string, success: boolean, started: number, content: Content[], nested: Nested[], notifications: Notification[]): Execution {
  const text = header(status, started);
  return { cell: null, output: content.length ? [{ type: "input_text", text }, ...content] : text, success, nested_calls: nested, notifications };
}

function failed(started: number, message: string): Execution {
  return { cell: null, output: header("Script failed", started) + message, success: false, nested_calls: [], notifications: [] };
}

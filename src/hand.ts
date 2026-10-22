import type { RemoteRequest } from "./contracts.ts";
import { CELL_GLOBALS, CELL_SCOPE } from "./cell.ts";

export type CellDefinition = { name: string; tool_name: string; kind: "function" | "freeform"; description: string; parameters: unknown };

export type CellHost = {
  call(name: string, input: unknown): Promise<unknown>;
  content(item: Record<string, unknown>): void;
  notify(text: string): void;
  yield(): void;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  signal?: AbortSignal;
  bash?(script: string, stdin?: string): Promise<BashOutcome>;
  setTimeout?(callback: (...values: unknown[]) => void, delay?: number, ...values: unknown[]): number;
  clearTimeout?(id?: number): void;
};

export type CellOutcome = { error?: string; stored: Record<string, unknown> };

export type CellEvaluator = (code: string, host: CellHost, definitions: CellDefinition[], stored: Record<string, unknown>) => Promise<CellOutcome>;

export type BashOutcome = { stdout: string; stderr: string; exitCode: number };

export type BashHost = { exec(script: string, options?: { stdin?: string; signal?: AbortSignal }): Promise<BashOutcome> };

export type LocalHandOptions = {
  name?: string;
  fetch?: typeof fetch;
  bash?: BashHost;
  evaluate?: CellEvaluator;
  max_frame_bytes?: number;
  timeout_ms?: number;
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Context = Record<string, Json>;
type Content = Record<string, Json>;
type Nested = { call_id: string; name: string; input: Json; output: Json; structured_result: Json; success: boolean; started_after_ns: number; duration_ns: number; metadata: null };
type Notification = { call_id: string; text: string };
type Execution = { cell: { origin_call_id: string; running: boolean } | null; output: string | Content[]; success: boolean; nested_calls: Nested[]; notifications: Notification[] };
type Callback = { resolve(value: Json): void; reject(error: unknown): void };
type Session = { id: string; cells: Map<number, Cell>; next: number; stored: Map<string, Json> };
type Scope = { run(build: () => (...values: unknown[]) => Promise<unknown>): Promise<CellOutcome> };

const BUDGET_MAX = "18446744073709551615";
const INITIAL_YIELD_MS = 10_000;
const OBSERVER_GRACE_MS = 1_000;
const TIMER_LIMIT_MS = 2_147_483_647;
const PRAGMA = "// @exec:";
const NOT_RECEIVED = "the hand never received this operation before its connection dropped; it was not dispatched";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let scope: ((host: CellHost, definitions: CellDefinition[], stored: Record<string, unknown>) => Scope) | undefined;

export const inRealm: CellEvaluator = (code, host, definitions, stored) => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...parameters: string[]) => (...values: unknown[]) => Promise<unknown>;
  scope ??= new Function("return " + CELL_SCOPE)() as NonNullable<typeof scope>;
  return scope(host, definitions, stored).run(() => new AsyncFunction(...CELL_GLOBALS, code));
};

function decode(text: string): any {
  return JSON.parse(text.replace(/"output_token_budget":18446744073709551615(?=[,}])/g, '"output_token_budget":-1'));
}

function encode(frame: unknown): string {
  return JSON.stringify(frame).replace(/"output_token_budget":-1(?=[,}])/g, '"output_token_budget":' + BUDGET_MAX);
}

function message(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
}

function identifier(name: string): string {
  let result = "";
  for (const [index, character] of [...name].entries()) {
    const valid = character === "_" || character === "$" || (index === 0 ? /^[A-Za-z]$/.test(character) : /^[A-Za-z0-9]$/.test(character));
    result += valid ? character : "_";
  }
  return result || "_";
}

function definitions(tools: any[]): CellDefinition[] {
  return tools.flatMap((tool): CellDefinition[] => {
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

  async run(code: string, definitions: CellDefinition[], fetcher: typeof fetch, evaluate: CellEvaluator, shell: BashHost | undefined) {
    const live = () => this.status === "running";
    const signal = this.controller.signal;
    const host: CellHost = {
      call: (name, input) => {
        const definition = definitions.find(entry => entry.tool_name === name);
        return definition ? this.call(definition, input) : Promise.reject("unknown tool " + name);
      },
      content: item => {
        if (live()) this.content.push(JSON.parse(JSON.stringify(item)) as Content);
      },
      notify: text => {
        if (!live()) return;
        const entry = { call_id: this.origin, text: String(text) };
        this.notifications.push(entry);
        this.emit({ notification: entry });
      },
      yield: () => {
        if (!live()) return;
        this.yielded = true;
        this.changed();
      },
      signal,
      fetch: async (input, init) => {
        if (!live()) throw new Error("Code Mode cell ended");
        const request = new Request(input, init);
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
        return fetcher(request.url, { body, headers: request.headers, method: request.method, redirect: request.redirect, signal });
      },
      bash: shell
        ? async (script, stdin) => {
            if (!live()) throw new Error("Code Mode cell ended");
            const result = await shell.exec(String(script), { stdin: stdin === undefined ? undefined : String(stdin), signal });
            return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
          }
        : undefined,
      setTimeout: (callback, delay, ...values) => {
        if (typeof callback !== "function") throw new TypeError("setTimeout expects a function");
        const id = ++this.nextTimer;
        const milliseconds = Math.min(Math.max(Number(delay) || 0, 0), TIMER_LIMIT_MS);
        this.timers.set(id, setTimeout(() => {
          this.timers.delete(id);
          if (live()) callback(...values);
        }, milliseconds));
        return id;
      },
      clearTimeout: id => {
        const timer = this.timers.get(Number(id));
        if (timer === undefined) return;
        clearTimeout(timer);
        this.timers.delete(Number(id));
      },
    };
    let outcome: CellOutcome;
    try {
      outcome = await evaluate(code, host, definitions, Object.fromEntries(this.session.stored));
    } catch (error) {
      outcome = { error: error instanceof Error ? (error.stack || error.message) : String(error), stored: {} };
    }
    if (!live()) return;
    for (const [name, value] of Object.entries(outcome.stored ?? {})) this.session.stored.set(name, value as Json);
    if (outcome.error === undefined) this.finish("completed");
    else this.finish("failed", outcome.error);
  }

  private call(definition: CellDefinition, input: unknown): Promise<unknown> {
    if (this.status !== "running") return Promise.reject("Code Mode cell ended");
    const call_id = this.origin + "/code-" + ++this.nextTool;
    const value = (input === undefined ? null : JSON.parse(JSON.stringify(input))) as Json;
    const started = performance.now();
    this.emit({ call_id, name: definition.tool_name, input: value });
    return new Promise((resolve, reject) => {
      const record = (output: Json, structured: Json, success: boolean) => {
        const call: Nested = { call_id, name: definition.tool_name, input: value, output, structured_result: structured, success, started_after_ns: Math.round((started - this.started) * 1e6), duration_ns: Math.round((performance.now() - started) * 1e6), metadata: null };
        if (this.status !== "running") return false;
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
          const text = message(error);
          this.callbacks.delete(id);
          if (!record(text, text, false)) return;
          reject(text);
        },
      });
      this.callbacks.add(id);
    });
  }
}

export class LocalHand {
  readonly name: string;
  readonly #fetch: typeof fetch;
  readonly #evaluate: CellEvaluator;
  readonly #bash: BashHost | undefined;
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
    this.#evaluate = options.evaluate ?? inRealm;
    this.#bash = options.bash;
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
    void cell.run(parsed.code, definitions(body.local_tools ?? []), this.#fetch, this.#evaluate, this.#bash);
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

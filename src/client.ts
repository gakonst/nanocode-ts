import type { LoggedEvent, ModelEntry, ModelProvider } from "./contracts.ts";

export type EntryKind = "assistant" | "error" | "reasoning" | "tool" | "user";

export type Entry = { kind: EntryKind; text: string };

export type LiveEvent = { type: string; [field: string]: unknown };

export type ServerEvent = { id?: string; event: string; data: string };

type AgentEvent = { type: string; payload: Record<string, unknown> };

type LoggedBody = { source?: string; event?: AgentEvent; type?: string; status?: string; ok?: { message?: string }; error?: unknown };

export function liveEvent(logged: LoggedEvent): LiveEvent | undefined {
  const body = logged.event as LoggedBody;
  const base = { seq: logged.seq, request_id: logged.request_id };
  if (body.source === "agent" && body.event) {
    const { type, payload } = body.event;
    switch (type) {
      case "assistant.delta": return { type: "text", delta: payload.text, item: payload.item_id, ...base };
      case "reasoning.summary.delta": return { type: "reasoning", delta: payload.text, item: `reasoning:${payload.model_call_index}`, ...base };
      case "tool.input.delta": return { type: "tool_input", name: payload.tool, delta: payload.text, call_id: payload.call_id, ...base };
      case "tool.call": return { type: "tool_start", name: payload.tool, args: payload.arguments, call_id: payload.call_id, ...base };
      case "tool.result": return { type: "tool_end", name: payload.tool, call_id: payload.call_id, status: payload.status, result: payload.result, ...base };
      default: return undefined;
    }
  }
  if (body.type === "result") return { type: "turn", status: body.status, ...(body.ok?.message !== undefined ? { message: body.ok.message } : {}), ...(body.error !== undefined ? { error: body.error } : {}), ...base };
  if (body.type === "retrying") return { type: "retrying", ...body, ...base };
  return undefined;
}

export function paragraphs(text: string, from: number, final = false): { chunks: string[]; next: number } {
  const chunks: string[] = [];
  let start = from;
  let fenced = (text.slice(0, from).match(/^```/gm)?.length ?? 0) % 2 === 1;
  let index = from;
  while (index < text.length) {
    const line = text.indexOf("\n", index);
    if (line === -1) break;
    if (text.startsWith("```", index)) fenced = !fenced;
    if (!fenced && text.startsWith("\n", line + 1)) {
      const chunk = text.slice(start, line).trim();
      if (chunk) chunks.push(chunk);
      start = line + 2;
    }
    index = line + 1;
  }
  if (!final) return { chunks, next: start };
  const rest = text.slice(start).trim();
  if (rest) chunks.push(rest);
  return { chunks, next: text.length };
}

const ESCAPES: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

const SPECIAL = /["\\]/g;

export class ToolInput {
  raw = "";
  readonly fields = new Map<string, string>();
  private object: boolean | undefined;
  private depth = 0;
  private key: string | undefined;
  private expectingKey = true;
  private role: "key" | "value" | "other" | undefined;
  private value = "";
  private pending = "";

  push(delta: string): void {
    this.raw += delta;
    const text = this.pending + delta;
    this.pending = "";
    let index = 0;
    if (this.object === undefined) {
      const start = text.search(/\S/);
      if (start < 0) return;
      this.object = text[start] === "{";
      index = start + 1;
    }
    if (!this.object) return;
    while (index < text.length) {
      if (this.role === undefined) {
        const char = text[index++];
        if (char === '"') {
          this.role = this.depth > 0 ? "other" : this.expectingKey ? "key" : this.key === undefined ? "other" : "value";
          this.value = "";
        } else if (this.depth === 0 && char === ":") this.expectingKey = false;
        else if (this.depth === 0 && char === ",") {
          this.expectingKey = true;
          this.key = undefined;
        } else if (char === "{" || char === "[") this.depth++;
        else if (char === "}" || char === "]") this.depth--;
        continue;
      }
      SPECIAL.lastIndex = index;
      const found = SPECIAL.exec(text);
      const end = found ? found.index : text.length;
      this.value += text.slice(index, end);
      if (!found) break;
      if (text[end] === '"') {
        if (this.role === "key") this.key = this.value;
        else if (this.role === "value" && this.key !== undefined) {
          this.fields.set(this.key, this.value);
          this.key = undefined;
        }
        this.role = undefined;
        this.value = "";
        index = end + 1;
        continue;
      }
      const escape = text[end + 1];
      if (escape === undefined || (escape === "u" && end + 6 > text.length)) {
        this.pending = text.slice(end);
        break;
      }
      if (escape === "u") {
        this.value += String.fromCharCode(Number.parseInt(text.slice(end + 2, end + 6), 16));
        index = end + 6;
      } else {
        this.value += ESCAPES[escape] ?? escape;
        index = end + 2;
      }
    }
    if (this.role === "value" && this.key !== undefined) this.fields.set(this.key, this.value);
  }

  text(): string {
    if (!this.fields.size) return this.raw;
    if (this.fields.size === 1) return [...this.fields.values()][0];
    return [...this.fields].map(([key, value]) => `${key}: ${value}`).join("\n");
  }
}

export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function describe(event: LiveEvent, limit = 160): Entry | undefined {
  const result = event.result as string | { text?: string } | undefined;
  switch (event.type) {
    case "tool_start": return { kind: "tool", text: `${event.name} ${JSON.stringify(event.args)}` };
    case "tool_end": return { kind: "tool", text: `${event.name} ${event.status}: ${clip(typeof result === "string" ? result : result?.text ?? "", limit)}` };
    case "retrying": return { kind: "tool", text: `Retrying: ${typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? event.message ?? "")}` };
    case "turn": return event.status === "completed" ? undefined : { kind: "error", text: `The turn ${event.status}: ${JSON.stringify(event.error ?? "")}` };
    case "error": return { kind: "error", text: typeof event.message === "string" ? event.message : JSON.stringify(event) };
    case "steered": return { kind: "tool", text: "steered into the running turn" };
    default: return undefined;
  }
}

export async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const message: ServerEvent = { event: "message", data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) message.id = line.slice(3).trim();
          else if (line.startsWith("event:")) message.event = line.slice(6).trim();
          else if (line.startsWith("data:")) message.data += line.slice(5).trim();
        }
        yield message;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type TranscriptOptions = {
  add(entry: Entry): void;
  live(entry: Entry | null): void;
  apply?(event: LiveEvent): void;
  revealMs?: number;
  frameMs?: number;
  reducedMotion?(): boolean;
  limit?: number;
};

type Stream = { kind?: "assistant" | "reasoning" | "tool"; item?: unknown; posted: number; shown: number; text: string; input?: ToolInput };

type Queued = { event: LiveEvent } | { run: () => void };

export class Transcript {
  private readonly options: TranscriptOptions;
  private stream: Stream = { posted: 0, shown: 0, text: "" };
  private queue: Queued[] = [];
  private frame: ReturnType<typeof setTimeout> | undefined;
  private clock = 0;

  constructor(options: TranscriptOptions) {
    this.options = options;
  }

  push(event: LiveEvent): void {
    this.enqueue({ event });
  }

  run(callback: () => void): void {
    this.enqueue({ run: callback });
  }

  reset(): void {
    if (this.frame !== undefined) clearTimeout(this.frame);
    this.frame = undefined;
    this.queue = [];
    this.stream = { posted: 0, shown: 0, text: "" };
    this.clock = 0;
    this.options.live(null);
  }

  private enqueue(item: Queued): void {
    this.queue.push(item);
    if (this.frame === undefined) this.frame = setTimeout(() => this.step());
  }

  private flush(): void {
    const { kind, posted, text } = this.stream;
    if (kind === "assistant") for (const chunk of paragraphs(text, posted, true).chunks) this.options.add({ kind, text: chunk });
    else if (kind === "reasoning" && text.trim()) this.options.add({ kind, text: text.trim() });
    this.stream = { posted: 0, shown: 0, text: "" };
    this.options.live(null);
  }

  private reveal(): void {
    const current = this.stream;
    const visible = current.text.slice(0, current.shown);
    if (current.kind === "assistant") {
      const { chunks, next } = paragraphs(visible, current.posted);
      current.posted = next;
      for (const chunk of chunks) this.options.add({ kind: current.kind, text: chunk });
    }
    const rest = visible.slice(current.posted).trim();
    this.options.live(rest && current.kind ? { kind: current.kind, text: rest } : null);
  }

  private step(): void {
    this.frame = undefined;
    const now = performance.now();
    const elapsed = this.clock ? now - this.clock : 0;
    this.clock = now;
    const revealMs = this.options.revealMs ?? 30;
    const instant = revealMs <= 0 || (this.options.reducedMotion?.() ?? false);
    let revealed = false;
    for (;;) {
      const current = this.stream;
      const next = this.queue[0];
      const event = next && "event" in next ? next.event : undefined;
      const kind = event?.type === "text" ? "assistant" : event?.type === "reasoning" ? "reasoning" : event?.type === "tool_input" ? "tool" : undefined;
      const item = event?.type === "tool_input" ? event.call_id : event?.item;
      if (event && kind && (!current.kind || (current.kind === kind && current.item === item))) {
        this.queue.shift();
        current.kind = kind;
        current.item = item;
        append(current, event);
        continue;
      }
      if (current.shown < current.text.length) {
        if (revealed) break;
        revealed = true;
        const backlog = current.text.length - current.shown;
        current.shown += instant ? backlog : Math.max(1, Math.ceil(backlog * (1 - Math.exp(-elapsed / revealMs))));
        this.reveal();
        continue;
      }
      if (!next) break;
      this.queue.shift();
      this.flush();
      if ("run" in next) {
        next.run();
        continue;
      }
      if (kind) {
        this.stream = { kind, item, posted: 0, shown: 0, text: "" };
        append(this.stream, next.event);
        continue;
      }
      const entry = describe(next.event, this.options.limit);
      if (entry) this.options.add(entry);
      this.options.apply?.(next.event);
    }
    if (this.stream.kind === "tool") this.options.live({ kind: "tool", text: this.stream.text });
    if (this.queue.length || this.stream.shown < this.stream.text.length) this.frame = setTimeout(() => this.step(), this.options.frameMs ?? 16);
    else this.clock = 0;
  }
}

function append(stream: Stream, event: LiveEvent): void {
  const delta = typeof event.delta === "string" ? event.delta : "";
  if (stream.kind !== "tool") {
    stream.text += delta;
    return;
  }
  stream.input ??= new ToolInput();
  stream.input.push(delta);
  const body = stream.input.text();
  stream.text = typeof event.name === "string" ? `${event.name} ${body}`.trimEnd() : body;
  stream.shown = stream.text.length;
}

export type PickerModel = Pick<ModelEntry, "id" | "name" | "efforts" | "effort">;

export type PickerHarness = { id: ModelProvider; label: string; models: PickerModel[] };

export type PickerItem = { kind: "choice" | "header"; label: string; detail?: string; current?: boolean };

export function modelItems(harnesses: PickerHarness[], model: string, query: string): PickerItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return harnesses.flatMap(entry => {
    const models = entry.models.map(candidate => ({ kind: "choice" as const, label: candidate.id, detail: `${candidate.name} · thinking ${candidate.efforts.join("/")}`, current: candidate.id === model })).filter(item => words.every(word => `${item.label} ${item.detail}`.toLowerCase().includes(word)));
    return models.length ? [{ kind: "header" as const, label: entry.label }, ...models] : [];
  });
}

export function thinkingItems(model: PickerModel | undefined, thinking: string | undefined): PickerItem[] {
  const current = model && thinking && model.efforts.includes(thinking as PickerModel["effort"]) ? thinking : model?.effort;
  return (model?.efforts ?? []).map(level => ({ kind: "choice", label: level, detail: level === model?.effort ? "default" : "", current: level === current }));
}

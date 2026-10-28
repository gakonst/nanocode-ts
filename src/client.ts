import type { LoggedEvent, ModelEntry, ModelProvider } from "./contracts.ts";
import type { Attachment } from "./files.ts";

export type { Attachment } from "./files.ts";

export type EntryKind = "assistant" | "error" | "reasoning" | "tool" | "user";

export type ToolStatus = "running" | "completed" | "failed" | "cancelled" | "yielded";

export type ToolBody = "text" | "code" | "diff";

export type ToolCell = {
  call_id: string;
  tool: string;
  name: string;
  title: string;
  input: string;
  body: ToolBody;
  language: string;
  output: string;
  output_language: string;
  status: ToolStatus;
  started_at: number;
  duration_ms?: number;
  exit_code?: number;
  images?: string[];
  details: string[];
  children: ToolCell[];
};

export type Entry = { kind: EntryKind; text: string; tool?: ToolCell; started_at?: number; ended_at?: number; steer?: boolean; attachments?: Attachment[] };

export type TransportFiles = {
  upload(file: Blob, name: string, signal?: AbortSignal): Promise<Attachment>;
  read(path: string, signal?: AbortSignal): Promise<Blob>;
  maxBytes?: number;
  maxFiles?: number;
  scope?(): string | undefined;
};

export const WORKSPACE_IMAGE = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i;

export function workspaceFile(src: unknown, root = "/workspace"): string | undefined {
  if (typeof src !== "string") return undefined;
  const value = src.trim();
  const scheme = /^(?:workspace|sandbox):(?:\/\/)?(.*)$/i.exec(value) ?? /^file:\/\/(\/.*)$/i.exec(value);
  const found = scheme ? scheme[1]! : value.startsWith(root + "/") ? value : undefined;
  if (found === undefined) return undefined;
  const raw = (() => {
    try {
      return decodeURIComponent(found);
    } catch {
      return found;
    }
  })();
  const absolute = raw.startsWith("/") ? raw : "/" + raw;
  const path = absolute === root || absolute.startsWith(root + "/") ? absolute : root + absolute;
  return path.split("/").includes("..") ? undefined : path.split(/[?#]/)[0];
}

export function bytes(size: number): string {
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return Math.round(size / 1024) + " KB";
  return (size / 1024 / 1024).toFixed(1) + " MB";
}

export function attachedPrompt(prompt: string, attachments: readonly Attachment[] = []): string {
  if (!attachments.length) return prompt;
  const lines = attachments.map(item => `Attached: ${item.path} (${item.type || "file"}, ${bytes(item.size)})`);
  return prompt ? prompt + "\n\n" + lines.join("\n") : lines.join("\n");
}

export type LiveEvent = { type: string; [field: string]: unknown };

export type ServerEvent = { id?: string; event: string; data: string };

type AgentEvent = { type: string; payload: Record<string, unknown> };

type LoggedBody = { source?: string; event?: AgentEvent; type?: string; status?: string; ok?: { message?: string }; error?: unknown };

function parentOf(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.parent_call_id === "string" && payload.parent_call_id) return payload.parent_call_id;
  const id = typeof payload.call_id === "string" ? payload.call_id : "";
  const slash = id.lastIndexOf("/");
  return slash > 0 ? id.slice(0, slash) : undefined;
}

export function liveEvent(logged: LoggedEvent): LiveEvent | undefined {
  const body = logged.event as LoggedBody;
  const base = { ...(logged.seq > 0 ? { seq: logged.seq } : {}), request_id: logged.request_id, ...(typeof logged.created_at === "number" ? { at: logged.created_at } : {}) };
  if (body.source === "agent" && body.event) {
    const { type, payload } = body.event;
    switch (type) {
      case "assistant.delta": return { type: "text", delta: payload.text, item: payload.item_id, ...(typeof payload.offset === "number" ? { offset: payload.offset } : {}), ...base };
      case "assistant.message": return typeof payload.text === "string" && payload.text ? { type: "text", delta: payload.text, item: payload.item_id, offset: 0, ...base } : undefined;
      case "reasoning.summary.delta": return { type: "reasoning", delta: payload.text, item: `reasoning:${payload.model_call_index}`, ...base };
      case "tool.input.delta": return { type: "tool_input", name: payload.tool, delta: payload.text, call_id: payload.call_id, ...(typeof payload.offset === "number" ? { offset: payload.offset } : {}), ...base };
      case "tool.call": return { type: "tool_start", name: payload.tool, args: payload.arguments, call_id: payload.call_id, parent: parentOf(payload), ...base };
      case "tool.notification": return { type: "tool_output", call_id: payload.call_id, text: payload.text, ...base };
      case "tool.result": return { type: "tool_end", name: payload.tool, call_id: payload.call_id, parent: parentOf(payload), status: payload.status, result: payload.result, structured: payload.structured_result, duration_ns: payload.duration_ns, ...base };
      default: return undefined;
    }
  }
  if (body.source !== undefined) return undefined;
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

  arguments(): unknown {
    return this.object ? Object.fromEntries(this.fields) : this.raw;
  }
}

export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const CODE_TOOLS = new Set(["exec", "code_mode", "js"]);

const PRAGMA = /^\s*\/\/ @exec:[^\n]*(?:\n|$)/;

function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function firstLine(text: string): { first: string; more: boolean } {
  const lines = text.trim().split("\n");
  return { first: lines[0] ?? "", more: lines.length > 1 };
}

function patchFiles(patch: string): string[] {
  return patch.split("\n").flatMap(line => {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    return match ? [match[1].trim()] : [];
  });
}

function linesPatch(header: string, path: string, removed: string, added: string): string {
  const lines = [`*** ${header}: ${path}`];
  if (header === "Update File") lines.push("@@");
  for (const line of removed ? removed.split("\n") : []) lines.push(`-${line}`);
  for (const line of added ? added.split("\n") : []) lines.push(`+${line}`);
  return lines.join("\n");
}

export function toolCell(callId: string, tool: string, startedAt = Date.now()): ToolCell {
  return { call_id: callId, tool, name: tool, title: "", input: "", body: "text", language: "", output: "", output_language: "", status: "running", started_at: startedAt, details: [], children: [] };
}

export function describeTool(cell: ToolCell, args: unknown): ToolCell {
  const value = decoded(args);
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const field = (key: string) => typeof object[key] === "string" ? object[key] as string : undefined;
  const number = (key: string) => typeof object[key] === "number" || typeof object[key] === "string" ? String(object[key]) : undefined;
  const command = (text: string) => {
    const { first, more } = firstLine(text);
    cell.name = "run";
    cell.title = first;
    cell.input = more ? text : "";
    cell.body = more ? "code" : "text";
    cell.language = more ? "bash" : "";
  };
  cell.name = cell.tool;
  cell.title = "";
  cell.input = "";
  cell.body = "text";
  cell.language = "";
  cell.details = [];
  if (CODE_TOOLS.has(cell.tool)) {
    let source = typeof value === "string" ? value : field("code") ?? field("source") ?? field("input") ?? (Object.keys(object).length ? JSON.stringify(object) : "");
    const pragma = PRAGMA.exec(source);
    if (pragma) source = source.slice(pragma[0].length);
    cell.name = "code";
    cell.input = source;
    cell.body = "code";
    cell.language = "js";
    return cell;
  }
  switch (cell.tool) {
    case "wait": {
      cell.name = "code";
      cell.title = `cell ${number("cell_id") ?? ""}${object.terminate === true ? " · terminate" : " · wait"}`;
      break;
    }
    case "exec_command":
      command(field("cmd") ?? "");
      if (object.tty === true) cell.details.push("tty");
      break;
    case "Bash":
    case "bash":
    case "shell":
    case "run_command":
      command(field("command") ?? field("cmd") ?? field("script") ?? (typeof value === "string" ? value : ""));
      if (object.run_in_background === true) cell.details.push("background");
      break;
    case "write_stdin": {
      const chars = field("chars") ?? "";
      cell.name = chars ? "stdin" : "poll";
      cell.title = `session ${number("session_id") ?? ""}`;
      cell.input = chars;
      break;
    }
    case "apply_patch": {
      const patch = typeof value === "string" ? value : field("input") ?? field("patch") ?? "";
      cell.name = "patch";
      cell.input = patch;
      cell.title = patchFiles(patch).join(", ");
      cell.body = "diff";
      break;
    }
    case "Edit":
    case "edit_file": {
      const path = field("file_path") ?? field("path") ?? "";
      cell.name = "edit";
      cell.title = path;
      cell.input = linesPatch("Update File", path, field("old_string") ?? "", field("new_string") ?? "");
      cell.body = "diff";
      if (object.replace_all === true) cell.details.push("all occurrences");
      break;
    }
    case "Write":
    case "write_file": {
      const path = field("file_path") ?? field("path") ?? "";
      cell.name = "write";
      cell.title = path;
      cell.input = linesPatch("Add File", path, "", field("content") ?? "");
      cell.body = "diff";
      break;
    }
    case "Read":
    case "read_file":
      cell.name = "read";
      cell.title = field("file_path") ?? field("path") ?? "";
      if (number("offset") || number("limit")) cell.details.push([number("offset") && `from line ${number("offset")}`, number("limit") && `${number("limit")} lines`].filter(Boolean).join(", "));
      break;
    case "Glob":
    case "Grep":
      cell.name = cell.tool.toLowerCase();
      cell.title = [field("pattern"), field("path") && `in ${field("path")}`].filter(Boolean).join(" ");
      break;
    case "WebSearch":
    case "web_search":
      cell.name = "search";
      cell.title = field("query") ?? "";
      break;
    case "WebFetch":
    case "fetch":
      cell.name = "fetch";
      cell.title = field("url") ?? "";
      break;
    case "spawn_agent":
      cell.name = "spawn agent";
      cell.title = field("role") ?? "";
      cell.input = field("task") ?? "";
      break;
    default: {
      const strings = Object.entries(object).filter(([, entry]) => typeof entry === "string") as [string, string][];
      const short = strings.find(([, entry]) => entry.length <= 80 && !entry.includes("\n"));
      if (typeof value === "string") cell.input = value;
      else if (Object.keys(object).length === 1 && strings.length === 1) {
        if (short) cell.title = short[1];
        else cell.input = strings[0][1];
      } else if (Object.keys(object).length) {
        if (short) cell.title = short[1];
        cell.input = JSON.stringify(object, null, 2);
        cell.body = "code";
        cell.language = "json";
      }
    }
  }
  return cell;
}

function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(textOf).reduce((text, part) => !part ? text : !text || text.endsWith("\n") ? text + part : `${text}\n${part}`, "");
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (Array.isArray(record.content_blocks)) return textOf(record.content_blocks);
    if (Array.isArray(record.content)) return textOf(record.content);
    if (Array.isArray(record.Content)) return textOf(record.Content);
    if (typeof record.Text === "string") return record.Text;
  }
  return "";
}

const IMAGE = /^(https?:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,])/i;

export function imagesOf(result: unknown, found: string[] = []): string[] {
  if (Array.isArray(result)) {
    for (const item of result) imagesOf(item, found);
    return found;
  }
  if (!result || typeof result !== "object") return found;
  const record = result as Record<string, unknown>;
  const source = record.source && typeof record.source === "object" ? record.source as Record<string, unknown> : undefined;
  const nested = record.image_url && typeof record.image_url === "object" ? (record.image_url as Record<string, unknown>).url : undefined;
  const url = record.type === "input_image" || record.type === "image_url" ? (typeof record.image_url === "string" ? record.image_url : nested)
    : record.type === "image" && typeof record.data === "string" ? `data:${typeof record.mimeType === "string" ? record.mimeType : typeof record.mime_type === "string" ? record.mime_type : "image/png"};base64,${record.data}`
    : record.type === "image" && source?.type === "base64" && typeof source.data === "string" ? `data:${typeof source.media_type === "string" ? source.media_type : "image/png"};base64,${source.data}`
    : record.type === "image" && source?.type === "url" ? source.url
    : undefined;
  if (typeof url === "string" && (IMAGE.test(url.trim()) || workspaceFile(url)) && !found.includes(url.trim())) found.push(url.trim());
  for (const key of ["content", "content_blocks", "Content", "output"]) if (Array.isArray(record[key])) imagesOf(record[key], found);
  return found;
}

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\^_])/g;

function plain(text: string): string {
  return text.includes("\u001b") ? text.replace(ANSI, "") : text;
}

function humanize(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    if (!("stdout" in value) && !("stderr" in value)) return text;
    const parts = ["stdout", "stderr", "output"].map(key => value[key]).filter((part): part is string => typeof part === "string" && part !== "").map(part => part.trimEnd());
    if (typeof value.exit_code === "number" && value.exit_code !== 0) parts.push(`exit code ${value.exit_code}`);
    return parts.join("\n");
  } catch {
    return text;
  }
}

function codeStatus(header: string): ToolStatus | undefined {
  if (header === "Script completed") return "completed";
  if (header === "Script failed") return "failed";
  if (header === "Script terminated") return "cancelled";
  if (header.startsWith("Script running with cell ID ")) return "yielded";
  return undefined;
}

function stripCodeHeader(text: string): string {
  const lines = text.split("\n");
  if (!lines[0]?.startsWith("Script ")) return text;
  let index = 1;
  while (index < lines.length && /^(Wall time|Original token count|Chunk ID)\b/.test(lines[index])) index++;
  if (lines[index] === "Output:") index++;
  return lines.slice(index).join("\n");
}

export function finishTool(cell: ToolCell, event: LiveEvent): ToolCell {
  const raw = textOf(event.result);
  const structured = event.structured && typeof event.structured === "object" ? event.structured as Record<string, unknown> : {};
  let status: ToolStatus = event.status === "completed" ? "completed" : event.status === "cancelled" ? "cancelled" : "failed";
  if (typeof event.duration_ns === "number") {
    if (event.duration_ns > 0) cell.duration_ms = event.duration_ns / 1e6;
  } else if (cell.status === "running") cell.duration_ms = at(event) - cell.started_at;
  if (CODE_TOOLS.has(cell.tool) || cell.tool === "wait") {
    const header = raw.split("\n", 1)[0] ?? "";
    status = codeStatus(header) ?? status;
    const yielded = /^Script running with cell ID (\S+)/.exec(header);
    if (yielded && cell.tool !== "wait") cell.title = `cell ${yielded[1]}`;
    const output = humanize(stripCodeHeader(raw)).trimEnd();
    cell.output = status === "cancelled" && cell.output && !output.includes(cell.output) ? `${cell.output}\n${output}`.trimEnd() : output;
  } else if (cell.tool === "exec_command" || cell.tool === "write_stdin") {
    const [header, output] = raw.includes("Output:\n") ? raw.split(/Output:\n([\s\S]*)/, 2) : ["", raw];
    cell.output = (typeof structured.output === "string" ? structured.output : output ?? "").trimEnd();
    const code = typeof structured.exit_code === "number" ? structured.exit_code : Number(/Process exited with code (-?\d+)/.exec(header ?? "")?.[1] ?? Number.NaN);
    if (Number.isFinite(code)) cell.exit_code = code;
    const session = /Process running with session ID (\d+)/.exec(header ?? "")?.[1];
    if (session) cell.details.push(`session ${session} running`);
  } else {
    cell.output = (typeof structured.output === "string" ? structured.output : humanize(raw)).trimEnd();
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed.exit_code === "number") cell.exit_code = parsed.exit_code;
      } catch {}
    }
  }
  const images = imagesOf(event.structured, imagesOf(event.result));
  if (images.length) cell.images = images;
  const output = cell.output.trim();
  cell.output_language = cell.output && (output.startsWith("{") || output.startsWith("[")) && (() => { try { JSON.parse(output); return true; } catch { return false; } })() ? "json" : /^(diff --git|--- )/.test(cell.output) ? "diff" : "";
  if (status === "completed" && cell.exit_code !== undefined && cell.exit_code !== 0) cell.details.push(`exit ${cell.exit_code}`);
  cell.output = plain(cell.output);
  cell.status = status;
  return cell;
}

export function at(event: LiveEvent): number {
  return typeof event.at === "number" ? event.at : Date.now();
}

export function toolSummary(cell: ToolCell): string {
  const head = [cell.name, cell.title].filter(Boolean).join(" ");
  const meta = [cell.status === "completed" ? "" : cell.status, cell.duration_ms !== undefined ? duration(cell.duration_ms) : "", ...cell.details].filter(Boolean).join(" · ");
  return meta ? `${head} · ${meta}` : head;
}

export function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes}m ${Math.round((milliseconds - minutes * 60_000) / 1000)}s`;
}

export function describe(event: LiveEvent, limit = 160): Entry | undefined {
  const result = event.result as string | { text?: string } | undefined;
  switch (event.type) {
    case "tool_start": return { kind: "tool", text: `${event.name} ${JSON.stringify(event.args)}` };
    case "tool_end": return { kind: "tool", text: `${event.name} ${event.status}: ${clip(typeof result === "string" ? result : result?.text ?? "", limit)}` };
    case "retrying": return { kind: "tool", text: `Retrying: ${typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? event.message ?? "")}` };
    case "turn": return event.status === "completed" ? undefined : event.status === "cancelled" ? { kind: "error", text: "The turn was cancelled." } : { kind: "error", text: `The turn ${event.status}: ${JSON.stringify(event.error ?? "")}` };
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
  live(entries: Entry[]): void;
  apply?(event: LiveEvent): void;
  revealMs?: number;
  frameMs?: number;
  reducedMotion?(): boolean;
  limit?: number;
  checkpoint?(event: LiveEvent): void;
  end?(status: ToolStatus): void;
};

export type TranscriptState = { running: ToolCell[]; stream: Omit<Stream, "shown">; links: [string, { cell: string; latest: string }][]; orphans: [string, ToolCell[]][]; ended?: string[]; seen?: [number, string][]; received?: [string, number][] };

type Stream = { kind?: "assistant" | "reasoning"; item?: unknown; posted: number; shown: number; text: string; started?: number; ended?: number };

type Queued = { event: LiveEvent } | { run: () => void } | { aside: Entry };

const TOOL_EVENTS = new Set(["tool_input", "tool_start", "tool_output", "tool_end"]);

const ENDED_LIMIT = 1024;

const SEEN_LIMIT = 4096;

const SAVED_SEEN = 256;

const RECEIVED_LIMIT = 256;

const OUTPUT_LIMIT = 65_536;

function remember(map: Map<string, number>, key: string, value: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > RECEIVED_LIMIT) map.delete(map.keys().next().value!);
}

function fingerprint(event: LiveEvent): string {
  return [event.type, event.call_id ?? event.item ?? "", typeof event.delta === "string" ? event.delta.length : typeof event.text === "string" ? event.text.length : ""].join("|");
}

export class Transcript {
  private readonly options: TranscriptOptions;
  private stream: Stream = { posted: 0, shown: 0, text: "" };
  private streaming: Entry | undefined;
  private queue: Queued[] = [];
  private frame: ReturnType<typeof setTimeout> | undefined;
  private clock = 0;
  private running: ToolCell[] = [];
  private readonly calls = new Map<string, ToolCell>();
  private readonly inputs = new Map<string, ToolInput>();
  private readonly links = new Map<string, { cell: string; latest: string }>();
  private held: Entry[] = [];
  private readonly orphans = new Map<string, ToolCell[]>();
  private readonly ended = new Set<string>();
  private readonly seen = new Map<number, string>();
  private readonly received = new Map<string, number>();
  private readonly consumed = new Map<string, number>();

  constructor(options: TranscriptOptions) {
    this.options = options;
  }

  push(event: LiveEvent): void {
    if (typeof event.seq === "number") {
      const key = fingerprint(event);
      if (this.seen.get(event.seq) === key) return;
      this.seen.delete(event.seq);
      this.seen.set(event.seq, key);
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.keys().next().value!);
    }
    if (event.type === "text" && event.item !== undefined) {
      const delta = typeof event.delta === "string" ? event.delta : "";
      const key = String(event.item);
      const have = this.received.get(key) ?? (this.stream.kind === "assistant" && this.stream.item === event.item ? this.stream.text.length : 0);
      const offset = typeof event.offset === "number" ? event.offset : have;
      const through = Math.max(have, offset + delta.length);
      remember(this.received, key, through);
      if (offset + delta.length <= have) return;
      event = { ...event, delta: offset >= have ? delta : delta.slice(have - offset), through };
    }
    this.enqueue({ event });
  }

  private consume(event: LiveEvent): void {
    if (event.type === "text" && event.item !== undefined && typeof event.through === "number") remember(this.consumed, String(event.item), event.through);
  }

  run(callback: () => void): void {
    this.enqueue({ run: callback });
  }

  aside(entry: Entry): void {
    this.enqueue({ aside: entry });
  }

  reset(): void {
    if (this.frame !== undefined) clearTimeout(this.frame);
    this.frame = undefined;
    this.queue = [];
    this.stream = { posted: 0, shown: 0, text: "" };
    this.streaming = undefined;
    this.running = [];
    this.calls.clear();
    this.inputs.clear();
    this.links.clear();
    this.orphans.clear();
    this.ended.clear();
    this.seen.clear();
    this.received.clear();
    this.consumed.clear();
    this.held = [];
    this.clock = 0;
    this.options.live([]);
  }

  pending(): boolean {
    return this.queue.length > 0;
  }

  state(limit = 65_536): TranscriptState {
    const clip = (cell: ToolCell) => clipCell(cell, limit, true);
    const { shown: _shown, ...stream } = this.stream;
    return { running: this.running.map(clip), stream, links: [...this.links], orphans: [...this.orphans].map(([key, cells]) => [key, cells.map(clip)]), ended: [...this.ended].slice(-256), seen: [...this.seen].slice(-SAVED_SEEN), received: [...this.consumed].slice(-SAVED_SEEN) };
  }

  restore(state: TranscriptState | undefined): void {
    if (!state || !Array.isArray(state.running)) return;
    const index = (cell: ToolCell) => {
      this.calls.set(cell.call_id, cell);
      for (const child of cell.children) index(child);
    };
    this.running = state.running;
    for (const cell of this.running) index(cell);
    for (const [key, cells] of state.orphans ?? []) {
      this.orphans.set(key, cells);
      for (const cell of cells) index(cell);
    }
    for (const [key, link] of state.links ?? []) this.links.set(key, link);
    for (const id of Array.isArray(state.ended) ? state.ended : []) this.ended.add(id);
    for (const [seq, key] of Array.isArray(state.seen) ? state.seen : []) this.seen.set(seq, key);
    for (const [key, length] of Array.isArray(state.received) ? state.received : []) {
      this.received.set(key, length);
      this.consumed.set(key, length);
    }
    if (state.stream && typeof state.stream.text === "string") {
      this.stream = { ...state.stream, shown: state.stream.text.length };
      this.reveal();
    }
    this.emit();
  }

  close(): void {
    this.enqueue({ run: () => this.end("cancelled") });
  }

  private end(status: ToolStatus): void {
    this.settle(status);
    this.orphans.clear();
    this.links.clear();
    this.options.end?.(status);
  }

  private enqueue(item: Queued): void {
    this.queue.push(item);
    if (this.frame === undefined) this.frame = setTimeout(() => this.step());
  }

  private timing(): Pick<Entry, "started_at" | "ended_at"> {
    const { started, ended } = this.stream;
    return { ...(started !== undefined ? { started_at: started } : {}), ...(ended !== undefined ? { ended_at: ended } : {}) };
  }

  private release(): void {
    for (const entry of this.held.splice(0)) this.options.add(entry);
  }

  private flush(): void {
    const { kind, posted, text } = this.stream;
    if (kind === "assistant") for (const chunk of paragraphs(text, posted, true).chunks) this.options.add({ kind, text: chunk, ...this.timing() });
    else if (kind === "reasoning" && text.trim()) this.options.add({ kind, text: text.trim(), ...this.timing() });
    this.stream = { posted: 0, shown: 0, text: "" };
    this.streaming = undefined;
    this.release();
  }

  private reveal(): void {
    const current = this.stream;
    const visible = current.text.slice(0, current.shown);
    if (current.kind === "assistant") {
      const { chunks, next } = paragraphs(visible, current.posted);
      current.posted = next;
      for (const chunk of chunks) this.options.add({ kind: current.kind, text: chunk, ...this.timing() });
      if (chunks.length) this.release();
    }
    const rest = visible.slice(current.posted).trim();
    this.streaming = rest && current.kind ? { kind: current.kind, text: rest, ...(current.started !== undefined ? { started_at: current.started } : {}) } : undefined;
  }

  private emit(): void {
    const entries: Entry[] = this.running.map(cell => ({ kind: "tool", text: toolSummary(cell), tool: structuredClone(cell), started_at: cell.started_at }));
    if (this.streaming) entries.push(this.streaming);
    this.options.live(entries);
  }

  private resolve(id: string): string {
    return this.links.get(id)?.latest ?? id;
  }

  private tool(event: LiveEvent): void {
    const id = this.resolve(String(event.call_id ?? ""));
    let cell = this.calls.get(id);
    if (!cell) {
      if (event.type === "tool_output") return;
      const parentId = typeof event.parent === "string" ? this.resolve(event.parent) : undefined;
      if (this.ended.has(id) || (parentId !== undefined && this.ended.has(parentId) && !this.calls.has(parentId) && !this.links.has(String(event.parent)))) return;
      cell = toolCell(id, typeof event.name === "string" ? event.name : "tool", at(event));
      this.calls.set(id, cell);
      const parent = typeof event.parent === "string" ? this.calls.get(this.resolve(event.parent)) : undefined;
      if (parent) parent.children.push(cell);
      else this.running.push(cell);
    }
    if (event.type === "tool_input") {
      let input = this.inputs.get(id);
      if (!input) this.inputs.set(id, input = new ToolInput());
      const delta = typeof event.delta === "string" ? event.delta : "";
      const have = input.raw.length;
      const offset = typeof event.offset === "number" ? event.offset : have;
      if (offset + delta.length > have) input.push(offset >= have ? delta : delta.slice(have - offset));
      describeTool(cell, input.arguments());
    } else if (event.type === "tool_start") {
      this.inputs.delete(id);
      describeTool(cell, event.args);
      if (cell.tool === "wait") {
        const args = decoded(event.args) as Record<string, unknown>;
        const target = args && (typeof args.cell_id === "string" || typeof args.cell_id === "number") ? String(args.cell_id) : undefined;
        for (const [origin, link] of this.links) {
          if (link.cell !== target) continue;
          link.latest = id;
          const orphans = this.orphans.get(origin);
          this.orphans.delete(origin);
          if (orphans) cell.children.push(...orphans.filter(orphan => !cell!.children.includes(orphan)));
        }
      }
    } else if (event.type === "tool_output") {
      if (cell.status === "running" && typeof event.text === "string") {
        const output = cell.output ? cell.output + "\n" + plain(event.text) : plain(event.text);
        cell.output = output.length > OUTPUT_LIMIT ? output.slice(-OUTPUT_LIMIT) : output;
      }
    } else {
      this.inputs.delete(id);
      finishTool(cell, event);
      const origin = String(event.call_id ?? "");
      const yieldedCell = cell.status === "yielded" ? /^cell (\S+)/.exec(cell.title)?.[1] : undefined;
      if (yieldedCell !== undefined) this.links.set(origin, { cell: yieldedCell, latest: origin });
      else for (const [key, link] of this.links) if (link.latest === id && key !== id) this.links.delete(key);
    }
    this.settle();
  }

  private settle(all?: ToolStatus): void {
    while (this.running.length && (all || this.running[0].status !== "running")) {
      const cell = this.running.shift()!;
      finish(cell, all ?? cell.status);
      const posted = structuredClone(cell);
      if (cell.status === "yielded") {
        const carried = cell.children.filter(child => child.status === "running");
        if (carried.length) this.orphans.set(cell.call_id, carried);
        for (const child of posted.children) if (child.status === "running") finish(child, "yielded");
      }
      this.forget(cell);
      this.options.add({ kind: "tool", text: toolSummary(posted), tool: posted, started_at: cell.started_at, ...(cell.duration_ms !== undefined ? { ended_at: cell.started_at + cell.duration_ms } : {}) });
    }
  }

  private forget(cell: ToolCell): void {
    if (cell.status === "running" && [...this.orphans.values()].some(cells => cells.includes(cell))) return;
    this.calls.delete(cell.call_id);
    this.inputs.delete(cell.call_id);
    this.ended.add(cell.call_id);
    if (this.ended.size > ENDED_LIMIT) this.ended.delete(this.ended.values().next().value!);
    for (const child of cell.children) this.forget(child);
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
      const kind = event?.type === "text" ? "assistant" : event?.type === "reasoning" ? "reasoning" : undefined;
      const item = event?.item;
      if (event && kind && (!current.kind || (current.kind === kind && current.item === item))) {
        this.queue.shift();
        current.kind = kind;
        current.item = item;
        current.text += typeof event.delta === "string" ? event.delta : "";
        this.consume(event);
        current.started ??= at(event);
        current.ended = at(event);
        this.options.checkpoint?.(event);
        continue;
      }
      if (event && !kind && !TOOL_EVENTS.has(event.type) && event.type !== "turn" && !describe(event, this.options.limit)) {
        this.queue.shift();
        this.options.apply?.(event);
        this.options.checkpoint?.(event);
        continue;
      }
      if (next && "aside" in next && current.kind === "assistant" && current.text.slice(current.posted).trim()) {
        this.queue.shift();
        this.held.push(next.aside);
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
      if ("aside" in next) {
        this.options.add(next.aside);
        continue;
      }
      if (kind) {
        this.stream = { kind, item, posted: 0, shown: 0, text: typeof next.event.delta === "string" ? next.event.delta : "", started: at(next.event), ended: at(next.event) };
        this.consume(next.event);
        this.options.checkpoint?.(next.event);
        continue;
      }
      if (TOOL_EVENTS.has(next.event.type)) {
        this.tool(next.event);
        this.options.checkpoint?.(next.event);
        continue;
      }
      if (next.event.type === "turn") this.end(next.event.status === "completed" ? "completed" : "cancelled");
      const entry = describe(next.event, this.options.limit);
      if (entry) this.options.add(entry);
      this.options.apply?.(next.event);
      this.options.checkpoint?.(next.event);
    }
    this.emit();
    if (this.queue.length || this.stream.shown < this.stream.text.length) this.frame = setTimeout(() => this.step(), this.options.frameMs ?? 16);
    else this.clock = 0;
  }
}

export function clipCell(cell: ToolCell, limit: number, tail = false): ToolCell {
  const cut = (text: string) => {
    if (text.length <= limit) return text;
    const dropped = `… ${text.length - limit} characters not kept`;
    return tail ? `${dropped}\n${text.slice(-limit)}` : `${text.slice(0, limit)}\n${dropped}`;
  };
  return { ...cell, input: cut(cell.input), output: cut(cell.output), details: [...cell.details], children: cell.children.map(child => clipCell(child, limit, tail)) };
}

function finish(cell: ToolCell, status: ToolStatus): void {
  if (cell.status === "running") {
    cell.status = status;
    cell.duration_ms ??= Date.now() - cell.started_at;
  }
  for (const child of cell.children) finish(child, status === "yielded" ? "running" : cell.status === "yielded" ? "completed" : cell.status);
}

export type PickerModel = Pick<ModelEntry, "id" | "name" | "efforts" | "effort">;

export type PickerHarness = { id: ModelProvider; label: string; models: PickerModel[] };

export type PickerItem = { kind: "choice" | "header"; label: string; detail?: string; current?: boolean; value?: string };

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

export type ChatStatus = "idle" | "pending";

export type Conversation = { id: string; title: string; updated: number };

export type ChatState = { entries: readonly Entry[]; live: readonly Entry[]; status: ChatStatus; error: Error | undefined; conversations: readonly Conversation[]; conversation: string | undefined };

export type TransportParameters = { prompt: string; attachments?: readonly Attachment[]; push(event: LiveEvent): void; note(kind: EntryKind, text: string): void; changed?(): void; signal: AbortSignal };

export type Transport = {
  send(parameters: TransportParameters): Promise<void>;
  steer?(parameters: TransportParameters): Promise<boolean>;
  resume?(parameters: Omit<TransportParameters, "prompt">): Promise<void>;
  cancel?(): Promise<void>;
  snapshot?(): unknown;
  restore?(state: unknown): void;
  files?: TransportFiles;
};

export const INSTALL_URL = "https://nanocode.xyz/install";

export type HandAccess = { url: string; token: string };

export type HandSource = { hand(): Promise<HandAccess | undefined>; hands(): Promise<readonly (string | null)[]> };

export function handCommands(access: HandAccess, install = INSTALL_URL): { command: string; short: string } {
  return { command: `curl -fsSL ${install} | sh -s -- hand '${access.url}' --token ${access.token}`, short: `nc hand '${access.url}' --token ${access.token}` };
}

const page = () => (globalThis as { location?: { href: string } }).location?.href;

export function socketUrl(path: string, base = page()): string {
  return new URL(path, base).href.replace(/^http/, "ws");
}

export function relaySource(url: string, token: () => string): HandSource {
  const http = new URL(url, page()).href.replace(/^ws/, "http");
  return {
    hand: async () => ({ url: socketUrl(url), token: token() }),
    hands: async () => {
      const response = await fetch(`${http}${http.includes("?") ? "&" : "?"}token=${encodeURIComponent(token())}`, { cache: "no-store" }).catch(() => undefined);
      if (!response?.ok) return [];
      return (await response.json() as { hands?: (string | null)[] }).hands ?? [];
    },
  };
}

export function createRelayToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export type TurnBlock = Entry & { live: boolean };

export type Turn = { id: string; prompt: Entry | undefined; blocks: TurnBlock[]; live: boolean; started_at?: number; ended_at?: number };

export function turns(entries: readonly Entry[], live: readonly Entry[] = [], pending = false): Turn[] {
  const result: Turn[] = [];
  const all = [...entries.map(entry => ({ entry, live: false })), ...live.map(entry => ({ entry, live: true }))];
  for (const [index, item] of all.entries()) {
    const entry = item.entry;
    if (entry.kind === "user" || !result.length) result.push({ id: String(index), prompt: entry.kind === "user" ? entry : undefined, blocks: [], live: false, ...(entry.started_at !== undefined ? { started_at: entry.started_at } : {}) });
    const turn = result[result.length - 1];
    turn.live ||= item.live;
    const ended = entry.ended_at ?? entry.started_at;
    if (ended !== undefined && !item.live) turn.ended_at = ended;
    if (entry.kind === "user") continue;
    const last = turn.blocks[turn.blocks.length - 1];
    if (last && last.kind === entry.kind && (entry.kind === "assistant" || entry.kind === "reasoning")) {
      const merged: TurnBlock = { ...last, text: last.text + "\n\n" + entry.text, live: last.live || item.live };
      if (entry.ended_at !== undefined && !item.live) merged.ended_at = entry.ended_at;
      else delete merged.ended_at;
      turn.blocks[turn.blocks.length - 1] = merged;
    } else turn.blocks.push({ ...entry, live: item.live });
  }
  if (pending && result.length) result[result.length - 1].live = true;
  for (const turn of result) if (turn.live) delete turn.ended_at;
  return result;
}

export type ActivityPhase = "idle" | "waiting" | "thinking" | "writing" | "running";

export type Activity = { busy: boolean; phase: ActivityPhase; tool?: string };

export function activity(live: readonly Entry[], pending: boolean): Activity {
  if (!pending) return { busy: false, phase: "idle" };
  const last = live[live.length - 1];
  if (last?.kind === "reasoning") return { busy: true, phase: "thinking" };
  if (last?.kind === "assistant") return { busy: true, phase: "writing" };
  if (last?.tool?.status === "running") return { busy: true, phase: "running", tool: last.tool.name };
  return { busy: true, phase: "waiting" };
}

export type HistoryStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

export type HistoryOptions = { key: string; storage?: HistoryStorage; limit?: number };

type TabLocks = { request(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => unknown): Promise<unknown> };

type TabChannel = { postMessage(message: unknown): void; addEventListener(type: "message", listener: (event: { data: unknown }) => void): void };

type TabMessage = { type: "state"; id: string; status: ChatStatus; entries?: readonly Entry[]; live?: readonly Entry[] } | { type: "hello" | "cancel"; id: string } | { type: "send"; id: string; prompt: string };

export type ConfigOptions = {
  transport: Transport;
  persist?: { load(): readonly Entry[]; save(entries: readonly Entry[]): void };
  history?: HistoryOptions;
  apply?(event: LiveEvent): void;
  revealMs?: number;
  keep?: number;
};

export type Config = {
  getState(): ChatState;
  getServerState(): ChatState;
  subscribe(listener: () => void): () => void;
  send(prompt: string, attachments?: readonly Attachment[]): Promise<void>;
  readonly files: TransportFiles | undefined;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  readonly cancellable: boolean;
  readonly detachable: boolean;
  push(event: LiveEvent): void;
  run(callback: () => void): void;
  note(kind: EntryKind, text: string): void;
  clear(): void;
  reset(): void;
  select(id: string): void;
  create(): string | undefined;
  remove(id: string): void;
};

function conversationId(): string {
  const random = (globalThis as { crypto?: { randomUUID?(): string } }).crypto?.randomUUID?.();
  return random ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function createConfig(options: ConfigOptions): Config {
  const listeners = new Set<() => void>();
  const history = options.history && { key: options.history.key, storage: options.history.storage ?? (globalThis as { localStorage?: HistoryStorage }).localStorage, limit: options.history.limit ?? 50 };
  const read = <T,>(key: string, fallback: T): T => {
    try {
      const value = history?.storage?.getItem(key);
      return value ? JSON.parse(value) as T : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key: string, value: unknown): boolean => {
    try {
      history?.storage?.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };
  const indexKey = () => `${history!.key}:history`;
  const entriesKey = (id: string) => `${history!.key}:entries:${id}`;
  const transportKey = (id: string) => `${history!.key}:transport:${id}`;
  const liveKey = (id: string) => `${history!.key}:live:${id}`;
  const lockName = (id: string) => `${history!.key}:turn:${id}`;
  const scope = globalThis as { navigator?: { locks?: TabLocks }; BroadcastChannel?: new (name: string) => TabChannel };
  const locks = history ? scope.navigator?.locks : undefined;
  const channel = history && locks && scope.BroadcastChannel ? new scope.BroadcastChannel(`nanocode:${history.key}`) : undefined;
  const coordinated = Boolean(locks && channel);
  const stale = new Set<string>();
  const leases = new Map<string, Promise<void>>();
  let owned: string | undefined;
  let following: { id: string; abort: AbortController } | undefined;
  let claiming = false;
  let fresh = false;
  let conversations: Conversation[] = [];
  let current: string | undefined;
  if (history) {
    const saved = read<{ current?: string; conversations?: Conversation[] }>(indexKey(), {});
    conversations = (saved.conversations ?? []).filter(item => item && typeof item.id === "string");
    current = saved.current && conversations.some(item => item.id === saved.current) ? saved.current : conversations[0]?.id;
    if (!current) {
      current = conversationId();
      conversations = [{ id: current, title: "", updated: Date.now() }];
      fresh = true;
    }
    options.transport.restore?.(read(transportKey(current), undefined));
  }
  let state: ChatState = { entries: history ? read<Entry[]>(entriesKey(current!), []) : options.persist?.load() ?? [], live: [], status: "idle", error: undefined, conversations, conversation: current };
  const server: ChatState = { entries: [], live: [], status: "idle", error: undefined, conversations: history && current ? [{ id: current, title: "", updated: 0 }] : [], conversation: current };
  const set = (next: Partial<ChatState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };
  const saveIndex = () => {
    if (history) write(indexKey(), { current, conversations });
  };
  const foreign = (id: string, view?: View) => following?.id === id || (stale.has(id) && owned !== id && !view?.release);
  const saveTransport = () => {
    if (history && current && options.transport.snapshot && !foreign(current, views.get(current))) write(transportKey(current), options.transport.snapshot());
  };
  const post = (message: TabMessage) => {
    try {
      channel?.postMessage(message);
    } catch {}
  };
  const outbox = new Map<string, { entries?: readonly Entry[]; live?: readonly Entry[] }>();
  let flushing: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (flushing !== undefined) clearTimeout(flushing);
    flushing = undefined;
    for (const [id, part] of outbox) post({ type: "state", id, status: owned === id ? "pending" : "idle", ...part });
    outbox.clear();
  };
  const announce = (id: string | undefined, part: { entries?: readonly Entry[]; live?: readonly Entry[] }) => {
    if (!channel || !id || owned !== id) return;
    outbox.set(id, { ...outbox.get(id), ...part });
    flushing ??= setTimeout(flush, 16);
  };
  type View = { transcript: Transcript; live: Entry[]; entries?: Entry[]; pushed?: unknown; processed?: unknown; dirty: boolean; saved: number; timer?: ReturnType<typeof setTimeout>; release?: () => void };
  const views = new Map<string | undefined, View>();
  const snapshots = new WeakMap<LiveEvent, unknown>();
  const evict = (id: string, key: string, value: unknown): boolean => {
    while (!write(key, value)) {
      const oldest = [...conversations].reverse().find(item => item.id !== id && item.id !== current);
      if (!oldest) return false;
      forget(oldest.id);
      conversations = conversations.filter(item => item.id !== oldest.id);
      saveIndex();
    }
    return true;
  };
  const persist = (id: string | undefined, view: View) => {
    if (view.timer !== undefined) clearTimeout(view.timer);
    view.timer = undefined;
    if (!history || !id || !conversations.some(item => item.id === id)) return;
    const entries = view.entries;
    view.entries = undefined;
    if (entries) evict(id, entriesKey(id), entries);
    if (foreign(id, view)) return;
    const snapshot = !options.transport.snapshot ? undefined : view.transcript.pending() ? view.processed : id === current ? options.transport.snapshot() : view.pushed;
    if (snapshot === undefined) return;
    view.dirty = false;
    view.saved = Date.now();
    const live = view.transcript.state();
    const idle = !live.running.length && !live.stream.text && !live.orphans.length;
    if (!evict(id, liveKey(id), idle ? { running: [], stream: { posted: 0, text: "" }, links: [], orphans: [], ended: live.ended?.slice(-64), seen: live.seen } : live)) {
      try { history.storage?.removeItem(liveKey(id)); } catch {}
    }
    write(transportKey(id), snapshot);
  };
  const schedule = (id: string | undefined, view: View) => {
    view.timer ??= setTimeout(() => persist(id, view), view.dirty ? 0 : 250);
  };
  const drop = (id: string | undefined) => {
    const found = views.get(id);
    views.delete(id);
    found?.release?.();
    found?.transcript.reset();
  };
  const entriesOf = (id: string): readonly Entry[] => id === current ? state.entries : views.get(id)?.entries ?? read<Entry[]>(entriesKey(id), []);
  const clean = (found: View | undefined) => !found || !(found.entries || found.release || found.transcript.pending());
  const sync = (id: string) => {
    if (!stale.has(id) || !clean(views.get(id))) return;
    stale.delete(id);
    const found = views.get(id);
    if (found?.timer !== undefined) clearTimeout(found.timer);
    drop(id);
    if (id !== current) return;
    options.transport.restore?.(read(transportKey(id), undefined));
    set({ entries: read<Entry[]>(entriesKey(id), []), live: view(id).live });
  };
  const forget = (id: string) => {
    drop(id);
    for (const key of [entriesKey(id), transportKey(id), liveKey(id)]) try { history?.storage?.removeItem(key); } catch {}
  };
  const add = (id: string | undefined, entry: Entry) => {
    if (!history) {
      const entries = [...state.entries, entry].slice(-(options.keep ?? 500));
      options.persist?.save(entries);
      set({ entries });
      return;
    }
    const shown = id === current;
    const existing = conversations.find(item => item.id === id);
    if (!existing && !shown) return;
    const target = views.get(id);
    const entries = [...(shown ? state.entries : target?.entries ?? read<Entry[]>(entriesKey(id!), [])), entry.tool ? { ...entry, tool: clipCell(entry.tool, 65_536) } : entry].slice(-(options.keep ?? 500));
    store(id!, entries, target);
  };
  const store = (id: string, entries: Entry[], target: View | undefined) => {
    const shown = id === current;
    if (following?.id === id) {
      if (shown) set({ entries });
      return;
    }
    if (shown) fresh = false;
    announce(id, { entries });
    const existing = conversations.find(item => item.id === id);
    const entry = entries[entries.length - 1];
    if (target) target.entries = entries;
    else evict(id, entriesKey(id), entries);
    const title = existing?.title || (entry?.kind === "user" ? (entry.text || entry.attachments?.map(item => item.name).join(", ") || "").replace(/\s+/g, " ").slice(0, 80) : "");
    conversations = [{ id, title, updated: Date.now() }, ...conversations.filter(item => item.id !== id)];
    for (const dropped of conversations.slice(history!.limit)) forget(dropped.id);
    conversations = conversations.slice(0, history!.limit);
    saveIndex();
    if (target) {
      target.dirty = true;
      schedule(id, target);
    }
    if (!shown) return set({ conversations });
    if (!target) saveTransport();
    set({ entries, conversations });
  };
  const end = (id: string | undefined, status: ToolStatus) => {
    const target = views.get(id);
    const entries = id === current ? state.entries : target?.entries ?? (history && id ? read<Entry[]>(entriesKey(id), []) : []);
    let start = entries.length;
    while (start > 0 && !(entries[start - 1]!.kind === "user" && !entries[start - 1]!.steer)) start--;
    const final = status === "completed" ? "completed" : "cancelled";
    const settle = (cell: ToolCell): ToolCell => cell.status === "yielded" || cell.status === "running" || cell.children.some(child => settle(child) !== child) ? { ...cell, status: cell.status === "yielded" || cell.status === "running" ? final : cell.status, children: cell.children.map(settle) } : cell;
    let changed = false;
    const next = entries.map((entry, index) => {
      if (index < start || !entry.tool) return entry;
      const tool = settle(entry.tool);
      if (tool === entry.tool) return entry;
      changed = true;
      return { ...entry, tool, text: toolSummary(tool) };
    });
    if (!changed) return;
    if (!history) {
      options.persist?.save(next);
      return set({ entries: next });
    }
    if (!id) return;
    store(id, next, target);
  };
  const view = (id = current): View => {
    let found = views.get(id);
    if (found) return found;
    const created: View = {
      dirty: false,
      live: [],
      saved: 0,
      transcript: new Transcript({
        add: entry => add(id, entry),
        end: status => end(id, status),
        checkpoint: event => {
          created.processed = snapshots.has(event) ? snapshots.get(event) : created.processed;
          if (created.dirty || Date.now() - created.saved >= 250) persist(id, created);
          else schedule(id, created);
        },
        live: live => {
          created.live = live;
          if (id === current && following?.id !== id) set({ live });
          announce(id, { live });
        },
        apply: event => { if (id === current) options.apply?.(event); },
        revealMs: options.revealMs,
        reducedMotion: () => { const media = (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia; return typeof media === "function" && media("(prefers-reduced-motion: reduce)").matches; },
      }),
    };
    views.set(id, created);
    if (history && id) created.transcript.restore(read<TranscriptState | undefined>(liveKey(id), undefined));
    return created;
  };
  const note = (kind: EntryKind, text: string) => {
    const started_at = Date.now();
    const target = current;
    view().transcript.run(() => add(target, { kind, text, started_at }));
  };
  const push = (event: LiveEvent) => {
    const target = view();
    target.pushed = options.transport.snapshot?.();
    snapshots.set(event, target.pushed);
    target.transcript.push(event);
  };
  let generation = 0;
  let controller: AbortController | undefined;
  const parameters = (prompt: string, id: number, signal: AbortSignal, attachments?: readonly Attachment[]): TransportParameters => ({
    prompt,
    ...(attachments?.length ? { attachments } : {}),
    signal,
    push: event => { if (id === generation) push(event); },
    note: (kind, text) => { if (id === generation) note(kind, text); },
    changed: () => { if (id === generation) saveTransport(); },
  });
  const detachable = () => Boolean(history && options.transport.resume);
  const detach = () => {
    if (state.status !== "pending") return;
    owned = undefined;
    generation += 1;
    controller?.abort();
    controller = undefined;
  };
  const settle = (start: (parameters: TransportParameters) => Promise<void>, prompt = "", attachments?: readonly Attachment[], free: () => void = () => undefined) => {
    const id = ++generation;
    controller?.abort();
    const signal = (controller = new AbortController()).signal;
    const conversation = current;
    const shown = view();
    const transcript = shown.transcript;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (shown.release === finish) shown.release = undefined;
      if (conversation && owned === conversation) {
        owned = undefined;
        flush();
        post({ type: "state", id: conversation, status: "idle", entries: entriesOf(conversation), live: [] });
      }
      free();
    };
    shown.release = finish;
    owned = conversation;
    set({ status: "pending", error: undefined });
    announce(conversation, { entries: state.entries, live: shown.live });
    let work: Promise<void>;
    try {
      work = start(parameters(prompt, id, signal, attachments));
    } catch (error) {
      work = Promise.reject(error);
    }
    return work.catch((error: unknown) => {
      if (id !== generation) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      note("error", failure.message);
      set({ error: failure });
    }).finally(() => {
      const leave = () => {
        if (conversation) persist(conversation, shown);
        finish();
      };
      if (id !== generation) return transcript.run(leave);
      transcript.close();
      transcript.run(() => {
        if (id !== generation) return leave();
        controller = undefined;
        const now = views.get(current);
        if (now) persist(current, now);
        else saveTransport();
        set({ status: "idle" });
        finish();
      });
    });
  };
  const lease = (id: string | undefined, waitMs: number): Promise<(() => void) | undefined> => {
    if (!locks || !channel || id === undefined) return Promise.resolve(() => undefined);
    const lockManager = locks;
    return (leases.get(id) ?? Promise.resolve()).then(() => new Promise(resolve => {
      let granted = false;
      lockManager.request(lockName(id), { signal: AbortSignal.timeout(waitMs) }, () => {
        granted = true;
        let free: () => void = () => undefined;
        const held = new Promise<void>(release => {
          free = () => {
            if (leases.get(id) === held) leases.delete(id);
            release();
          };
        });
        leases.set(id, held);
        resolve(free);
        return held;
      }).catch(() => {
        if (!granted) resolve(undefined);
      });
    }));
  };
  const unfollow = () => {
    following?.abort.abort();
    following = undefined;
  };
  const follow = (id: string) => {
    if (!locks || !channel || following?.id === id || owned === id) return;
    unfollow();
    const abort = new AbortController();
    following = { id, abort };
    if (id === current) set({ status: "pending", error: undefined });
    post({ type: "hello", id });
    locks.request(lockName(id), { signal: abort.signal }, () => {
      if (following?.abort !== abort) return;
      following = undefined;
      stale.add(id);
      if (id !== current) return;
      sync(id);
      set({ status: "idle" });
      setTimeout(() => void config.resume());
    }).catch(() => undefined);
  };
  const claim = async (target: string | undefined, waitMs: number): Promise<(() => void) | undefined> => {
    claiming = true;
    try {
      return await lease(target, waitMs);
    } finally {
      claiming = false;
    }
  };
  const open = (id: string, entries: Entry[], resume = true) => {
    const detached = state.status === "pending";
    detach();
    unfollow();
    fresh = false;
    const leaving = views.get(current);
    if (leaving && conversations.some(item => item.id === current)) persist(current, leaving);
    else if (conversations.some(item => item.id === current)) saveTransport();
    if (!detached) drop(current);
    current = id;
    if (stale.has(id) && clean(views.get(id))) {
      drop(id);
      stale.delete(id);
    }
    options.transport.restore?.(read(transportKey(id), undefined));
    saveIndex();
    set({ conversation: id, conversations: [...conversations], entries, live: view(id).live, status: "idle", error: undefined });
    if (resume) void config.resume();
  };
  const config: Config = {
    getState: () => state,
    getServerState: () => server,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(prompt, attachments) {
      const text = prompt.trim();
      const attached = attachments?.length ? attachments.map(item => ({ name: item.name, path: item.path, type: item.type, size: item.size })) : undefined;
      if (!text && !attached) return;
      if (claiming) return;
      if (current && following?.id === current) {
        if (attached) note("error", "Attachments go with a new message. Send them when the running turn finishes.");
        else post({ type: "send", id: current, prompt: text });
        return;
      }
      if (state.status === "pending" && attached) {
        note("error", "Attachments go with a new message. Send them when the running turn finishes.");
        return;
      }
      if (state.status === "pending") {
        const transcript = view().transcript;
        transcript.aside({ kind: "user", text, started_at: Date.now(), steer: true });
        if (!options.transport.steer || !controller) return;
        try {
          if (await options.transport.steer(parameters(text, generation, controller.signal))) transcript.aside({ kind: "tool", text: "steered into the running turn", started_at: Date.now() });
        } catch (error) {
          note("error", error instanceof Error ? error.message : String(error));
        }
        return;
      }
      const started_at = Date.now();
      const target = current;
      let free: (() => void) | undefined = () => undefined;
      if (coordinated && target) {
        set({ status: "pending", error: undefined });
        free = await claim(target, 3000);
        if (target !== current) return free?.();
        if (!free) {
          follow(target);
          if (attached) note("error", "Another tab is running a turn in this conversation. Send the attachments when it finishes.");
          else post({ type: "send", id: target, prompt: text });
          return;
        }
        owned = target;
      }
      if (target) sync(target);
      view().transcript.run(() => add(target, { kind: "user", text, started_at, ...(attached ? { attachments: attached } : {}) }));
      await settle(parameters => options.transport.send(parameters), text, attached, free);
    },
    async resume() {
      const resume = options.transport.resume?.bind(options.transport);
      if (!resume || state.status === "pending" || claiming) return;
      const target = current;
      let free: (() => void) | undefined = () => undefined;
      if (coordinated && target) {
        free = await claim(target, 250);
        if (target !== current || config.getState().status === "pending") return free?.();
        if (!free) return follow(target);
      }
      if (target) sync(target);
      await settle(({ push, note, signal }) => resume({ push, note, signal }), "", undefined, free);
    },
    async cancel() {
      if (current && following?.id === current) return post({ type: "cancel", id: current });
      if (!options.transport.cancel || state.status !== "pending") return;
      try {
        await options.transport.cancel();
      } catch (error) {
        note("error", error instanceof Error ? error.message : String(error));
      }
    },
    cancellable: Boolean(options.transport.cancel),
    files: options.transport.files,
    get detachable() {
      return detachable();
    },
    push,
    run: callback => view().transcript.run(callback),
    note,
    clear() {
      if (history) {
        config.create();
        return;
      }
      view().transcript.reset();
      options.persist?.save([]);
      set({ entries: [], live: [], error: undefined });
    },
    reset() {
      view().transcript.reset();
      set({ live: [], status: "idle" });
    },
    select(id) {
      if (!history || id === current || (state.status === "pending" && !detachable() && !following) || !conversations.some(item => item.id === id)) return;
      open(id, views.get(id)?.entries ?? read<Entry[]>(entriesKey(id), []));
    },
    create() {
      if (!history || (state.status === "pending" && !detachable() && !following)) return current;
      if (!state.entries.length) return current;
      const id = conversationId();
      conversations = [{ id, title: "", updated: Date.now() }, ...conversations].slice(0, history.limit);
      open(id, [], false);
      return id;
    },
    remove(id) {
      if (!history) return;
      if (id !== current) {
        forget(id);
        conversations = conversations.filter(item => item.id !== id);
        saveIndex();
        set({ conversations: [...conversations] });
        return;
      }
      if (state.status === "pending") {
        if (!detachable() && !following) return;
        if (following?.id === id) post({ type: "cancel", id });
        else options.transport.cancel?.().catch(() => undefined);
        detach();
      }
      forget(id);
      conversations = conversations.filter(item => item.id !== id);
      const next = conversations[0];
      if (next) open(next.id, read<Entry[]>(entriesKey(next.id), []));
      else {
        conversations = [{ id: conversationId(), title: "", updated: Date.now() }];
        open(conversations[0].id, [], false);
      }
    },
  };
  if (history) {
    state = { ...state, live: view(current).live };
    const target = globalThis as { addEventListener?: (type: string, listener: (event: Event) => void) => void };
    target.addEventListener?.("pagehide", () => {
      for (const [id, entry] of views) if (entry.dirty || entry.entries || entry.timer !== undefined || entry.release) persist(id, entry);
    });
    const index = () => {
      const saved = read<{ current?: string; conversations?: Conversation[] }>(indexKey(), {});
      const list = (saved.conversations ?? []).filter(item => item && typeof item.id === "string");
      if (fresh && !state.entries.length && state.status !== "pending" && saved.current && saved.current !== current && list.some(item => item.id === saved.current)) {
        conversations = list;
        open(saved.current, read<Entry[]>(entriesKey(saved.current), []));
        return;
      }
      const kept = conversations.find(item => item.id === current);
      conversations = kept && !list.some(item => item.id === current) ? [kept, ...list] : list;
      set({ conversations: [...conversations] });
    };
    target.addEventListener?.("storage", event => {
      const { key, storageArea } = event as unknown as { key: string | null; storageArea: unknown };
      const prefix = `${history.key}:`;
      if ((storageArea && storageArea !== history.storage) || !key?.startsWith(prefix)) return;
      const rest = key.slice(prefix.length);
      if (rest === "history") return index();
      const match = /^(entries|transport|live):(.+)$/.exec(rest);
      if (!match) return;
      const id = match[2]!;
      stale.add(id);
      if (match[1] === "entries" && id === current && owned !== id && following?.id !== id && state.status !== "pending") set({ entries: read<Entry[]>(entriesKey(id), []) });
    });
    channel?.addEventListener("message", event => {
      const message = event.data as TabMessage;
      if (!message || typeof message.id !== "string") return;
      if (message.type === "hello") {
        if (message.id === owned) post({ type: "state", id: owned, status: "pending", entries: entriesOf(owned), live: views.get(owned)?.live ?? [] });
        return;
      }
      if (message.type === "send" || message.type === "cancel") {
        if (message.id !== owned || owned !== current) return;
        if (message.type === "send") void config.send(message.prompt);
        else void config.cancel();
        return;
      }
      if (message.type !== "state" || message.id === owned) return;
      stale.add(message.id);
      if (message.id !== current) return;
      if (message.status === "pending") follow(message.id);
      if (following?.id !== message.id) {
        if (message.entries && state.status !== "pending") set({ entries: [...message.entries] });
        return;
      }
      set({ ...(message.entries ? { entries: [...message.entries] } : {}), ...(message.live ? { live: [...message.live] } : {}) });
    });
  }
  return config;
}

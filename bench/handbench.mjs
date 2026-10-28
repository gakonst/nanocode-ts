import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import { AgentRuntime, RemoteExecutor, sessionUuid } from "../src/index.ts";
import { Bash } from "../src/bash/index.ts";

export const arg = (name, fallback) => process.argv.find(a => a.startsWith("--" + name + "="))?.slice(name.length + 3) ?? fallback;

const enc = new TextEncoder();
const sse = events => new Response(enc.encode(events.map(([e, d]) => "event: " + e + "\ndata: " + JSON.stringify(d) + "\n\n").join("")), { headers: { "content-type": "text/event-stream" } });
let step = 0;
export function claude(code) {
  const s = step++;
  const tool = code !== null;
  const block = tool ? [{ type: "tool_use", id: "t" + s, name: "exec", input: {} }, { type: "input_json_delta", partial_json: JSON.stringify({ code }) }] : [{ type: "text", text: "" }, { type: "text_delta", text: "ok" }];
  return sse([["message_start", { type: "message_start", message: { id: "m" + s, type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } }], ["content_block_start", { type: "content_block_start", index: 0, content_block: block[0] }], ["content_block_delta", { type: "content_block_delta", index: 0, delta: block[1] }], ["content_block_stop", { type: "content_block_stop", index: 0 }], ["message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }], ["message_stop", { type: "message_stop" }]]);
}

export const PROVIDER = arg("provider", "claude");
const plain = rows => new Response(enc.encode(rows.map(d => "data: " + JSON.stringify(d) + "\n\n").join("")), { headers: { "content-type": "text/event-stream" } });
export function codex(code) {
  const s = step++;
  const id = "resp_" + s;
  const item = code !== null
    ? { type: "custom_tool_call", id: "ctc_" + s, call_id: "call_" + s, name: "exec", input: code, status: "completed" }
    : { type: "message", id: "msg_" + s, role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
  return plain([{ type: "response.created", response: { id, status: "in_progress" } }, { type: "response.output_item.added", output_index: 0, item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : item }, ...(item.type === "message" ? [{ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "ok" }] : []), { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id, status: "completed", model: "gpt-6-luna", output: [item], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } }]);
}

export const stats = { statements: 0, transactions: 0, rows: 0, bytes: 0, frames_in: 0, bytes_in: 0, frames_out: 0, bytes_out: 0, request_bytes: 0 };
export const histogram = {};
export const bytesHist = {};
export function database() {
  const db = new DatabaseSync(":memory:");
  const prepared = new Map();
  return { db, transaction(kind, operation, statements) { stats.transactions++; db.exec("BEGIN IMMEDIATE"); try { const rows = statements.map(([q, ...v]) => { stats.statements++; const key = operation + " | " + q.trim().split(/\s+/).slice(0, 4).join(" "); histogram[key] = (histogram[key] ?? 0) + 1; let nb = 0; for (const x of v) nb += typeof x === "string" ? x.length : 8; stats.bytes += nb; bytesHist[key] = (bytesHist[key] ?? 0) + nb; let st = prepared.get(q); if (!st) { st = db.prepare(q); st.setReturnArrays(true); prepared.set(q, st); } return st.all(...v); }); db.exec("COMMIT"); return rows; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
}

export async function hand(kind, binary) {
  if (kind === "local") return { local: true, close() {} };
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const policy = { max_frame_bytes: 8 * 1024 * 1024, timeout_ms: 120000, resumes: true };
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: policy.max_frame_bytes, handleProtocols: protocols => (protocols.has("bearer") ? "bearer" : false) });
  await new Promise(resolve => wss.on("listening", resolve));
  const port = wss.address().port;
  const accepted = new Promise((resolve, reject) => {
    wss.on("connection", (socket, request) => {
      const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? (request.headers["sec-websocket-protocol"] ?? "").split(",").map(s => s.trim())[1];
      if (bearer !== token) return socket.close(1008, "invalid runner credential");
      socket.send(JSON.stringify({ type: "ack", ids: [] }));
      const send = socket.send.bind(socket);
      const shim = { get readyState() { return socket.readyState; }, send(text) { stats.frames_out++; stats.bytes_out += text.length; send(text); }, close(code, reason) { try { socket.close(code, reason); } catch {} }, addEventListener() {} };
      let executor;
      socket.on("message", (data, binary) => {
        const text = binary ? data : data.toString();
        if (!executor) { executor = RemoteExecutor.restore(shim, policy, text); resolve({ executor, name: JSON.parse(text).name ?? "machine" }); return; }
        stats.frames_in++; stats.bytes_in += text.length;
        executor.receive(text);
      });
      socket.on("close", () => executor?.disconnected());
    });
    setTimeout(() => reject(new Error("the hand did not connect")), 30000);
  });
  const work = mkdtempSync(join(tmpdir(), "hand-bench-"));
  const child = kind === "native"
    ? spawn(binary, ["hand", "ws://127.0.0.1:" + port, "--token", token, "--name", "bench", "-C", work], { stdio: ["ignore", "ignore", "inherit"] })
    : spawn(process.execPath, [new URL("./hand-ts.mjs", import.meta.url).pathname], { env: { ...process.env, URL: "ws://127.0.0.1:" + port, TOKEN: token }, stdio: ["ignore", "ignore", "inherit"] });
  const { executor, name } = await accepted;
  return { executor, name, close() { child.kill(); wss.close(); } };
}

export const module = await WebAssembly.compile(readFileSync(process.env.NANOCODE_WASM_PATH ?? new URL("../dist/nanocode_wasm.wasm", import.meta.url)));

export class Session {
  constructor(attached, sql = database()) { this.attached = attached; this.sql = sql; this.id = sessionUuid(); this.turns = 0; this.current = null; this.marks = []; }
  async open() {
    this.runtime = await AgentRuntime.instantiate(module, this.sql, { published() {} });
    const local = this.attached?.local;
    const shell = local ? (this.shell ??= await Bash.create({ cwd: "/workspace" })) : undefined;
    await this.runtime.open({ scope: "s", session_id: this.id, ...(PROVIDER === "codex" ? { provider: "codex", model: "gpt-6-luna", endpoint: "https://api.openai.com/v1" } : { provider: "claude", model: "claude-haiku-5-5", endpoint: "https://api.anthropic.com/v1/messages" }), subscription: false, event_coalesce_ms: 100, live_deltas: true, code_mode: !!local, ...(local ? { workspace: shell.cwd } : { hands: !!this.attached }), tools: [{ name: "lookup", description: "Look up a key.", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }] }, {
      ...(local ? { workspace: shell.workspace(), fetch: async () => new Response("pong") } : this.attached ? { remote: this.attached.executor.host() } : {}),
      tools: { call: async (_, input) => ({ key: input.key, value: 1 }) },
      dispatch: async request => { this.marks.push(performance.now()); stats.request_bytes += request.body.byteLength; if (process.env.DUMP) writeFileSync(process.env.DUMP + "-" + this.marks.length + ".json", request.body); const code = this.current; this.current = null; return PROVIDER === "codex" ? codex(code) : claude(code); },
    });
    if (this.attached && !this.attached.local) await this.runtime.attach(this.attached.name, "bench");
    return this;
  }
  async dispose() { await this.runtime?.dispose(); this.runtime = undefined; }
  async once(code) {
    this.marks = []; this.current = code;
    const id = "t" + this.turns++;
    const t0 = performance.now();
    await this.runtime.submit("s", { request_id: id, prompt: "go", metadata: {}, ...(this.attached && !this.attached.local ? { hand: this.attached.name } : {}) });
    for (;;) { const next = (await this.runtime.pending("s"))[0]; if (!next) break; const d = await this.runtime.drive(next.report.request_id); if (d.waiting) await new Promise(r => setTimeout(r, 1)); }
    const report = (await this.runtime.turn("s", id))?.report;
    if (report?.status !== "completed") throw new Error(JSON.stringify(report).slice(0, 400));
    return { turn: performance.now() - t0, cell: this.marks.length > 1 ? this.marks[1] - this.marks[0] : 0 };
  }
}

export const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
export const p90 = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; };
export const pad = (s, n) => String(s).padEnd(n);
export const f = x => x.toFixed(x < 10 ? 2 : 1);
export function report(label, lines) {
  mkdirSync(new URL("./out", import.meta.url), { recursive: true });
  writeFileSync(new URL("./out/" + label + ".txt", import.meta.url), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}
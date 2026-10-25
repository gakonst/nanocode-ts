import { HostFailure, RECENT_MODEL_LIMIT, RemoteRefusal, sessionUuid, type AgentConfiguration, type Compacted, type BranchCursor, type BranchExport, type BranchPage, type BranchPoint, type BranchSummary, type Driven, type Engine, type EngineCall, type EngineHost, type HostEvent, type HostOptions, type HostTool, type LoggedEvent, type McpServer, type LogPage, type LogPageOptions, type MessageSocket, type ModelCatalog, type ModelTiming, type MovedQueued, type Replaced, type RuntimeOptions, type RuntimeSettings, type RuntimeTiming, type SqlHost, type SqlValue, type WorkspaceHost, type Submitted, type Thinking, type SubagentSummary, type TurnView } from "./contracts.ts";
import { deferMcp, type McpPolicy } from "./mcp.ts";
import { Timings, type TimingSnapshot } from "./timing.ts";

type Pending = { resolve(value: unknown): void; reject(reason: unknown): void };

const NULL_CELL = 0xffffffff;

type Socket = { socket: MessageSocket; idle: number; frames: (string | null)[]; closed?: string; waiter?: { id: number; resolve(value: unknown): void }; watchers: (() => void)[]; timing: ModelTiming };

export type RuntimeMetrics = {
  wasm_memory_bytes: number;
  timing: { runtime_id: string; started_at: number; elapsed_ms: number; spans: TimingSnapshot; checkpoints: TimingSnapshot; models: ModelTiming[] };
  initializations: number;
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  retries: number;
  waits: number;
  resumes: number;
  rejected_runs: number;
  cancellations: number;
  host_calls: number;
  store_calls: number;
  log_calls: number;
  model_requests: number;
  model_sockets: number;
  socket_sends: number;
  socket_frames: number;
  tool_calls: number;
  body_reads: number;
  event_batches: number;
  events: number;
  host_cancellations: number;
  dropped_replies: number;
  disposals: number;
  bridge_request_bytes: number;
  bridge_reply_bytes: number;
};

export async function localEngine(module: WebAssembly.Module, host: EngineHost): Promise<Engine> {
  type Exports = { memory: WebAssembly.Memory; allocate(length: number): number; poll(): void } & Record<EngineCall, (id: number, pointer: number, length: number) => void>;
  const step = 16_384;
  const args = new Array<number>(step / 8).fill(0);
  let levels = 0;
  const descend = (): number => {
    if (--levels <= 0) return 1;
    try {
      return 1 + Reflect.apply(descend, undefined, args);
    } catch {
      return 1;
    }
  };
  const room = (want: number): number => {
    levels = Math.floor(want / step);
    try {
      return Reflect.apply(descend, undefined, args) * step;
    } catch {
      return 0;
    }
  };
  let exports: Exports | undefined;
  let entry = 0;
  const bytes = (pointer: number, length: number) => new Uint8Array(exports!.memory.buffer, pointer, length);
  const view = () => new DataView(exports!.memory.buffer);
  const imports = {
    dispatch: (id: number, pointer: number, length: number) => host.dispatch(id, bytes(pointer, length)),
    dispatch_body: (id: number, pointer: number, length: number, body: number, bodyLength: number) => host.dispatch(id, bytes(pointer, length), bytes(body, bodyLength).slice()),
    cancel: (id: number) => host.cancel(id),
    clock: (monotonic: number) => monotonic ? performance.now() : Date.now(),
    stack_room: (want: number, at: number) => {
      entry = at;
      return room(want);
    },
    calendar_date: (pointer: number, length: number) => {
      try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: new TextDecoder().decode(bytes(pointer, length)), year: "numeric", month: "numeric", day: "numeric" }).formatToParts(Date.now()).map(part => [part.type, Number(part.value)]));
        return parts.year * 10_000 + parts.month * 100 + parts.day;
      } catch {
        return 0;
      }
    },
    random: (pointer: number, length: number) => { crypto.getRandomValues(bytes(pointer, length)); },
    reply: (id: number, pointer: number, length: number) => host.reply(id, bytes(pointer, length)),
    panicked: (pointer: number, length: number) => host.panicked(bytes(pointer, length)),
  };
  const libc = {
    clock_time_get: (clock: number, _precision: bigint, out: number) => {
      view().setBigUint64(out, BigInt(Math.round((clock === 0 ? Date.now() : performance.now()) * 1e6)), true);
      return 0;
    },
    fd_write: (_fd: number, iovs: number, count: number, written: number) => {
      let total = 0;
      for (let index = 0; index < count; index++) total += view().getUint32(iovs + index * 8 + 4, true);
      view().setUint32(written, total, true);
      return 0;
    },
    fd_close: () => 0,
    fd_fdstat_get: () => 8,
    fd_seek: () => 8,
  };
  const instance = await WebAssembly.instantiate(module, { host: imports, wasi_snapshot_preview1: libc });
  const wasm = instance.exports as unknown as Exports;
  exports = wasm;
  return {
    get memoryBytes() {
      return wasm.memory.buffer.byteLength;
    },
    enter(call, id, length, fill) {
      if (entry) new Uint32Array(wasm.memory.buffer, entry, 1)[0]++;
      if (call && fill) {
        const pointer = wasm.allocate(length);
        fill(new Uint8Array(wasm.memory.buffer, pointer, length));
        wasm[call](id, pointer, length);
      }
      wasm.poll();
    },
  };
}

export class AgentRuntime {
  private readonly runtimeId = sessionUuid();
  private readonly startedAt = Date.now();
  private readonly started = performance.now();
  private readonly timings = new Timings();
  private readonly checkpointTimings = new Timings();
  private readonly models: RuntimeTiming[] = [];
  private engine!: Engine;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly inflight = new Map<number, () => void>();
  private readonly bodies = new Map<number, { reader: ReadableStreamDefaultReader<Uint8Array>; timing: ModelTiming }>();
  private readonly sockets = new Map<number, Socket>();
  private readonly commands = new Map<number, Pending>();
  private readonly watchers = new Set<() => void>();
  private readonly counters: Omit<RuntimeMetrics, "timing" | "wasm_memory_bytes"> = {
    initializations: 0, runs: 0, completed: 0, failed: 0, cancelled: 0, retries: 0, waits: 0, resumes: 0, rejected_runs: 0, cancellations: 0,
    host_calls: 0, store_calls: 0, log_calls: 0, model_requests: 0, model_sockets: 0, socket_sends: 0, socket_frames: 0, tool_calls: 0, body_reads: 0, event_batches: 0, events: 0,
    host_cancellations: 0, dropped_replies: 0, disposals: 0,
    bridge_request_bytes: 0, bridge_reply_bytes: 0,
  };
  private nextBody = 0;
  private nextSocket = 0;
  private nextCommand = 0;
  private depth = 0;
  private stopped = false;
  private failure?: Error;
  private disposal?: Promise<void>;
  private readonly attached = new Set<string>();
  private options: Partial<RuntimeOptions> & HostOptions & { handSend?(text: string): void };
  private readonly sql: SqlHost;
  hands = false;
  remote = false;
  subscription = false;
  opened = false;

  private constructor(sql: SqlHost, options: HostOptions) {
    this.sql = sql;
    this.options = options;
  }

  static async instantiate(module: WebAssembly.Module, sql: SqlHost, options: HostOptions): Promise<AgentRuntime> {
    const runtime = new AgentRuntime(sql, options);
    const instantiateStarted = performance.now();
    runtime.engine = await (options.engine ?? localEngine)(module, runtime.engineHost());
    runtime.timings.record("wasm.instantiate", performance.now() - instantiateStarted);
    if (sql.value_limit !== undefined || options.log_logical_limit !== undefined || options.blobs) {
      await runtime.command("configure", { value_limit: sql.value_limit, logical_limit: options.log_logical_limit, blob_threshold: options.blobs ? options.blobs.threshold ?? sql.value_limit ?? Number.MAX_SAFE_INTEGER : undefined });
    }
    return runtime;
  }

  async serveHand(options: { workspace: WorkspaceHost; cwd: string; fetch?: RuntimeOptions["fetch"]; dispatch?: RuntimeOptions["dispatch"]; tools?: { definitions: HostTool[]; call: NonNullable<RuntimeOptions["tools"]>["call"] }; mcp_servers?: McpServer[]; mcp?: McpPolicy; name?: string; max_frame_bytes?: number; send(text: string): void }): Promise<{ catalog: string; receive(text: string): Promise<void>; closed(): Promise<void> }> {
    if (this.opened || this.closed) throw new Error("agent runtime cannot be opened again");
    this.opened = true;
    this.options = { ...this.options, workspace: options.workspace, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.dispatch ? { dispatch: deferMcp(options.dispatch, options.mcp_servers, options.mcp) } : {}), ...(options.tools ? { tools: options.tools } : {}), handSend: options.send };
    const catalog = await this.command("hand_open", { name: options.name ?? null, workspace: options.cwd, max_frame_bytes: options.max_frame_bytes ?? null, tools: options.tools?.definitions ?? [], mcp_servers: options.mcp_servers ?? [] }) as string;
    return {
      catalog,
      receive: async text => { await this.command("hand_frame", { text }); },
      closed: async () => { await this.command("hand_closed", {}); },
    };
  }

  async open(config: AgentConfiguration, options: RuntimeOptions): Promise<void> {
    if (this.opened || this.closed) throw new Error("agent runtime cannot be opened again");
    this.opened = true;
    this.options = { ...options, dispatch: deferMcp(options.dispatch, config.mcp_servers, options.mcp), published: this.options.published, wake: this.options.wake, blobs: this.options.blobs };
    const extra = config.code_mode ? options.workspace?.instructions : undefined;
    if (extra && !config.instructions?.includes(extra)) config = { ...config, instructions: config.instructions ? config.instructions + "\n\n" + extra : extra };
    this.hands = config.hands ?? false;
    this.remote = config.remote ?? false;
    this.subscription = config.subscription;
    try {
      const initStarted = performance.now();
      const opened = await this.command("init", { config: { ...config, runtime_id: this.runtimeId, started_ms: this.started, provider: config.provider ?? "claude", remote: this.remote, hands: this.hands, code_mode: config.code_mode ?? false, event_coalesce_ms: config.event_coalesce_ms ?? 0, tools: config.tools ?? [] } }) as { rejected?: { error: string; kind: string } };
      if (opened.rejected) throw new HostFailure(opened.rejected.error, opened.rejected.kind, true);
      this.timings.record("sdk.open", performance.now() - initStarted);
    } catch (error) {
      this.terminate(error);
      throw error;
    }
    this.counters.initializations++;
  }

  get metrics(): Readonly<RuntimeMetrics> {
    return { ...this.counters, wasm_memory_bytes: this.engine.memoryBytes, timing: { runtime_id: this.runtimeId, started_at: this.startedAt, elapsed_ms: this.elapsed(), spans: this.timings.snapshot(), checkpoints: this.checkpointTimings.snapshot(), models: this.models.map(value => ({ ...value })) } };
  }

  get closed(): boolean {
    return this.stopped || this.disposal !== undefined;
  }

  get reusable(): boolean {
    return !this.closed && !this.options.remote?.failed?.();
  }

  get memoryBytes(): number {
    return this.engine.memoryBytes;
  }

  get connected(): boolean {
    for (const entry of this.sockets.values()) if (entry.closed === undefined) return true;
    return false;
  }

  async submit(scope: string, input: { request_id: string; prompt: string; images?: string[]; hand?: string; metadata: unknown }): Promise<Submitted> {
    return await this.command("submit", { scope, ...input }) as Submitted;
  }

  async append(scope: string, events: { request_id?: string; event: HostEvent }[]): Promise<LoggedEvent[]> {
    return (await this.command("append", { scope, events }) as { appended: LoggedEvent[] }).appended;
  }

  async admit(request_id: string, recorded: string | null, requested: string): Promise<"reserved_request_id" | "provider_changed" | undefined> {
    return (await this.command("admit", { request_id, recorded, requested }) as { rejected?: "reserved_request_id" | "provider_changed" } | null)?.rejected;
  }

  async catalog(frame: string, max_frame_bytes: number): Promise<string | null> {
    return (await this.identity(frame, max_frame_bytes)).name;
  }

  async identity(frame: string, max_frame_bytes: number): Promise<{ name: string | null; runtime_id: string | null }> {
    return await this.command("catalog", { frame, max_frame_bytes }) as { name: string | null; runtime_id: string | null };
  }

  async turn(scope: string, request_id: string): Promise<TurnView | null> {
    return (await this.command("turn", { scope, request_id }) as { turn: TurnView | null }).turn;
  }

  async pending(scope: string): Promise<TurnView[]> {
    return (await this.command("pending", { scope }) as { turns: TurnView[] }).turns;
  }

  async page(scope: string, after: number, limit: number, options?: string | LogPageOptions): Promise<LogPage> {
    const page = typeof options === "string" ? { request_id: options } : options;
    return await this.command("page", { scope, after, limit, ...page }) as LogPage;
  }

  async interrupted(scope: string, request_id: string, note: string): Promise<void> {
    await this.command("interrupted", { scope, request_id, note });
  }

  async retry(scope: string, request_id: string, error: string, kind: string, retry_at: number): Promise<TurnView | null> {
    return (await this.command("retry", { scope, request_id, error, kind, retry_at }) as { turn: TurnView | null }).turn;
  }

  async finish(scope: string, request_id: string, status: "failed" | "cancelled", fields: Record<string, unknown>): Promise<void> {
    await this.command("finish", { scope, request_id, status, fields });
  }

  async import(scope: string, turns: unknown[]): Promise<number> {
    return await this.command("import", { scope, turns }) as number;
  }

  async exportBranch(session_id: string, at: BranchPoint): Promise<BranchExport> {
    return await this.command("export_branch", { session_id, at }) as BranchExport;
  }

  async exportPage(session_id: string, exported: BranchExport, cursor: BranchCursor, max_bytes: number): Promise<BranchPage> {
    return await this.command("export_page", { session_id, export: exported, cursor, max_bytes }) as BranchPage;
  }

  async importBranch(session_id: string, exported: BranchExport): Promise<BranchCursor | null> {
    return (await this.command("import_branch", { session_id, export: exported }) as { next: BranchCursor | null }).next;
  }

  async importPage(session_id: string, exported: BranchExport, page: BranchPage): Promise<BranchCursor | null> {
    return (await this.command("import_page", { session_id, export: exported, page }) as { next: BranchCursor | null }).next;
  }

  async publishBranch(session_id: string, exported: BranchExport): Promise<BranchSummary> {
    return await this.command("publish_branch", { session_id, export: exported }) as BranchSummary;
  }

  async importEvents(scope: string, after: number, events: LoggedEvent[]): Promise<number> {
    return await this.command("import_events", { scope, after, events }) as number;
  }

  async cancel(scope: string, request_id: string, fields: Record<string, unknown>): Promise<{ turn: TurnView | null; dequeued?: boolean }> {
    this.counters.cancellations++;
    return await this.command("cancel", { scope, request_id, fields }) as { turn: TurnView | null; dequeued?: boolean };
  }

  async drive(next?: string): Promise<Driven> {
    if (this.closed) throw this.failure ?? new Error("agent runtime is closed");
    this.counters.runs++;
    let result: Driven;
    try {
      result = await this.command("drive", { next }) as Driven;
    } catch {
      result = { retry: true };
    }
    const status = result.finished?.report.status;
    if (status === "completed") this.counters.completed++;
    else if (status === "cancelled") this.counters.cancelled++;
    else if (status === "failed") this.counters.failed++;
    else if (result.retry) this.counters.retries++;
    else if (result.busy) this.counters.rejected_runs++;
    else if (result.waiting) this.counters.waits++;
    else if (result.resumed !== undefined) this.counters.resumes++;
    if (result.retry) await this.dispose().catch(() => undefined);
    return result;
  }

  async attach(hand: string, connection: string): Promise<void> {
    if (this.closed || this.attached.has(connection)) return;
    this.attached.add(connection);
    try {
      await this.command("attach", { hand, connection });
    } catch (error) {
      this.attached.delete(connection);
      throw error;
    }
  }

  async detach(connection: string): Promise<void> {
    if (this.closed || !this.attached.delete(connection)) return;
    await this.command("detach", { connection });
  }

  async modelCatalog(): Promise<ModelCatalog> {
    return await this.command("models", {}) as ModelCatalog;
  }

  async settle(): Promise<boolean> {
    return await this.command("settle", {}) === true;
  }

  async compact(): Promise<Compacted> {
    return await this.command("compact", {}) as Compacted;
  }

  async steer(requestId: string, prompt: string, into?: string): Promise<boolean> {
    return await this.command("steer", { request_id: requestId, prompt, into }) === true;
  }

  async replaceQueued(scope: string, request_id: string, edit_id: string, text: string): Promise<Replaced> {
    return await this.command("replace", { scope, request_id, edit_id, text }) as Replaced;
  }

  async moveQueued(requestId: string, into?: string): Promise<MovedQueued> {
    return (await this.command("move_queued", { request_id: requestId, into }) as { moved: MovedQueued }).moved;
  }

  async interruptSubagent(agent_id: number): Promise<SubagentSummary[]> {
    return await this.command("interrupt_subagent", { agent_id }) as SubagentSummary[];
  }

  async closeSubagent(agent_id: number): Promise<SubagentSummary[]> {
    return await this.command("close_subagent", { agent_id }) as SubagentSummary[];
  }

  async completionOrigin(requestId: string): Promise<string | null> {
    return await this.command("completion_origin", { request_id: requestId }) as string | null;
  }

  async checkThinking(thinking: Thinking): Promise<void> {
    await this.command("settings", { thinking, apply: false });
  }

  async setThinking(thinking: Thinking): Promise<void> {
    await this.settings({ thinking });
  }

  async settings(settings: RuntimeSettings): Promise<void> {
    await this.command("settings", { ...settings, apply: true });
  }

  async preconnect(): Promise<void> {
    await this.command("preconnect", {});
  }

  changed(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        this.watchers.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.watchers.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  dispose(): Promise<void> {
    this.disposal ??= this.shutdown();
    return this.disposal;
  }

  private async shutdown(): Promise<void> {
    this.counters.disposals++;
    let failure: unknown;
    if (!this.stopped && this.opened) {
      try { await this.command("dispose", {}); } catch (error) { failure = error; }
    }
    this.terminate(new Error("agent runtime disposed"));
    await this.options.remote?.dispose();
    if (failure !== undefined) throw failure;
  }

  private accept(id: number, bytes: Uint8Array, body?: Uint8Array) {
    const received = performance.now();
    const request = JSON.parse(this.decoder.decode(bytes));
    if (body) request.body = body;
    this.counters.bridge_request_bytes += bytes.byteLength + (body?.byteLength ?? 0);
    this.timings.record("bridge.decode", performance.now() - received);
    this.counters.host_calls++;
    this.inflight.set(id, () => {});
    void Promise.resolve()
      .then(async () => {
        const started = performance.now();
        this.timings.record(`queue.${request.op}`, started - received);
        try { return await this.execute(id, request); }
        finally { this.timings.record(`host.${request.op}`, performance.now() - started); }
      })
      .then(ok => ({ ok }), error => ({ error: AgentRuntime.encodeError(error) }))
      .then(reply => this.complete(id, reply));
  }

  private engineHost(): EngineHost {
    return {
      dispatch: (id, request, body) => this.accept(id, request, body),
      cancel: id => {
        const cancel = this.inflight.get(id);
        if (!cancel) return;
        this.inflight.delete(id);
        this.counters.host_cancellations++;
        cancel();
      },
      reply: (id, bytes) => {
        const reply = JSON.parse(this.decoder.decode(bytes));
        const pending = this.commands.get(id);
        if (!pending) return;
        this.commands.delete(id);
        if ("error" in reply) pending.reject(new Error(String(reply.error)));
        else pending.resolve(reply.ok);
        this.notify();
      },
      panicked: bytes => { this.fail(new Error(this.decoder.decode(bytes))); },
    };
  }

  private onCancel(id: number, cancel: () => void) {
    if (this.inflight.has(id)) this.inflight.set(id, cancel);
    else cancel();
  }

  private live(id: number) {
    return !this.stopped && this.inflight.has(id);
  }

  private async execute(id: number, request: any): Promise<unknown> {
    if (!this.live(id)) return null;
    if (request.op.startsWith("remote_")) {
      if (!this.options.remote) throw new Error("remote executor is not configured");
      this.onCancel(id, () => this.options.remote!.cancel(id));
      return this.options.remote.execute(request, id);
    }
    switch (request.op) {
      case "hand_send": {
        this.options.handSend?.(request.text);
        return null;
      }
      case "wake":
        this.notify();
        this.options.wake?.();
        return null;
      case "sleep": return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), request.milliseconds);
        this.onCancel(id, () => { clearTimeout(timer); resolve(null); });
      });
      case "http_start": {
        if (!this.options.dispatch) throw new Error("agent runtime is not open");
        this.counters.model_requests++;
        const controller = new AbortController();
        this.onCancel(id, () => controller.abort());
        const timing: RuntimeTiming = { runtime_id: this.runtimeId, dispatch_id: id, started_ms: this.elapsed(), body_read_wait_ms: 0, body_reads: 0, bytes: 0, max_chunk_gap_ms: 0 };
        this.models.push(timing);
        if (this.models.length > RECENT_MODEL_LIMIT) this.models.shift();
        let response: Response;
        try { response = await this.options.dispatch({ provider: request.provider, endpoint: request.endpoint, method: request.method ?? "POST", headers: request.headers, body: request.body, origin: request.origin ?? null }, controller.signal, timing); }
        catch (error) { this.finishModel(timing, controller.signal.aborted ? "cancelled" : "failed"); throw error; }
        timing.headers_ms = this.elapsed() - timing.started_ms;
        timing.status = response.status;
        if (!this.live(id)) {
          void response.body?.cancel().catch(() => undefined);
          this.finishModel(timing, "cancelled");
          return null;
        }
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          this.finishModel(timing, "failed");
          throw new Error("provider redirect rejected");
        }
        const body = ++this.nextBody;
        const reader = (response.body ?? new ReadableStream<Uint8Array>({ start: controller => controller.close() })).getReader();
        this.bodies.set(body, { reader, timing });
        this.onCancel(id, () => {
          if (!this.bodies.delete(body)) return;
          this.finishModel(timing, "cancelled");
          void reader.cancel().catch(() => undefined);
        });
        return { id: body, status: response.status, headers: [...response.headers] };
      }
      case "http_read": {
        const body = this.bodies.get(request.id);
        if (!body) throw new Error("provider response body is closed");
        const { reader, timing } = body;
        this.counters.body_reads++;
        this.onCancel(id, () => {
          this.bodies.delete(request.id);
          this.finishModel(timing, "cancelled");
          void reader.cancel().catch(() => undefined);
        });
        const readStarted = performance.now();
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch (error) { this.finishModel(timing, "failed"); throw error; }
        finally { timing.body_read_wait_ms += performance.now() - readStarted; timing.body_reads++; }
        if (chunk.done) {
          this.bodies.delete(request.id);
          reader.releaseLock();
          this.finishModel(timing, "eof");
          return null;
        }
        const at = this.elapsed() - timing.started_ms;
        if (chunk.value.byteLength) timing.first_byte_ms ??= at;
        if (timing.last_byte_ms !== undefined) timing.max_chunk_gap_ms = Math.max(timing.max_chunk_gap_ms, at - timing.last_byte_ms);
        timing.last_byte_ms = at;
        timing.bytes += chunk.value.byteLength;
        return chunk.value;
      }
      case "http_close": {
        const body = this.bodies.get(request.id);
        if (body) {
          this.bodies.delete(request.id);
          this.finishModel(body.timing, "closed");
          await body.reader.cancel().catch(() => undefined);
        }
        return null;
      }
      case "tool_call": {
        if (!this.options.tools) throw new Error("host tools are not configured");
        this.counters.tool_calls++;
        const controller = new AbortController();
        this.onCancel(id, () => controller.abort());
        return await this.options.tools.call(request.name, request.input, controller.signal, request.context) ?? null;
      }
      case "file_read": return await this.workspace().read(request.path);
      case "file_write": return await this.workspace().write(request.path, request.contents) ?? null;
      case "file_remove": return await this.workspace().remove(request.path) ?? null;
      case "shell_run": {
        const controller = new AbortController();
        this.onCancel(id, () => controller.abort());
        return await this.workspace().run({ command: request.command, cwd: request.cwd, timeout_ms: request.timeout_ms ?? null, ...(typeof request.stdin === "string" ? { stdin: request.stdin } : {}) }, controller.signal);
      }
      case "cell_wasm": {
        const workspace = this.workspace();
        if (!workspace.wasm) throw new Error("this workspace does not run WebAssembly");
        const controller = new AbortController();
        this.onCancel(id, () => controller.abort());
        return await workspace.wasm(request.body instanceof Uint8Array ? { ...request.request, module_bytes: request.body } : request.request, controller.signal);
      }
      case "cell_fetch": {
        const input = request.request as { url: string; method?: string; headers?: Record<string, string>; body?: string };
        const controller = new AbortController();
        this.onCancel(id, () => controller.abort());
        const body: Uint8Array | string | undefined = request.body instanceof Uint8Array ? request.body : input.body;
        const response = await (this.options.fetch ?? globalThis.fetch)(input.url, { method: input.method ?? "GET", ...(input.headers ? { headers: input.headers } : {}), ...(body !== undefined ? { body: body as BodyInit } : {}), signal: controller.signal });
        return framed({ status: response.status, status_text: response.statusText, url: response.url, headers: [...response.headers] }, new Uint8Array(await response.arrayBuffer()));
      }
      case "cell_read": return await readBytes(this.workspace(), cellPath(request.cwd, request.path));
      case "cell_write": {
        await writeBytes(this.workspace(), cellPath(request.cwd, request.path), request.body, request.append === true);
        return null;
      }
      case "socket_open": {
        if (!this.options.socket) throw new Error("model sockets are not configured");
        this.counters.model_sockets++;
        const controller = new AbortController();
        this.onCancel(id, () => controller.abort());
        const timing: RuntimeTiming = { runtime_id: this.runtimeId, dispatch_id: id, transport: "websocket", started_ms: this.elapsed(), body_read_wait_ms: 0, body_reads: 0, bytes: 0, max_chunk_gap_ms: 0, sends: 0 };
        this.models.push(timing);
        if (this.models.length > RECENT_MODEL_LIMIT) this.models.shift();
        let handshake;
        try { handshake = await this.options.socket.open({ provider: request.provider, headers: request.headers, origin: request.origin ?? null }, controller.signal, timing); }
        catch (error) { this.finishModel(timing, controller.signal.aborted ? "cancelled" : "failed"); throw error; }
        timing.headers_ms = this.elapsed() - timing.started_ms;
        timing.status = handshake.status;
        const socket = handshake.socket;
        if (handshake.status !== 101 || !socket) {
          this.finishModel(timing, "failed");
          return { status: handshake.status, headers: [...handshake.headers], body: await handshake.text() };
        }
        if (!this.live(id)) {
          socket.close(1000, "handshake cancelled");
          this.finishModel(timing, "cancelled");
          return null;
        }
        const handle = ++this.nextSocket;
        const idle = handshake.idle_ms ?? 0;
        const entry: Socket = { socket, idle: Number.isSafeInteger(idle) && idle > 0 ? idle : 0, frames: [], watchers: [], timing };
        this.sockets.set(handle, entry);
        socket.addEventListener("message", event => this.receive(entry, event.data));
        socket.addEventListener("close", event => this.closeSocket(handle, `with code ${event.code}: ${event.reason}`, "eof"));
        socket.addEventListener("error", () => this.closeSocket(handle, "after a transport error", "failed"));
        this.onCancel(id, () => {
          this.closeSocket(handle, "handshake cancelled", "cancelled");
          this.sockets.delete(handle);
        });
        return { id: handle, status: handshake.status, headers: [...handshake.headers] };
      }
      case "socket_send": {
        const entry = this.sockets.get(request.id);
        if (entry?.closed !== undefined) return { closed: entry.closed };
        if (!entry) return { closed: "after the client released it" };
        await this.options.socket!.admit(request.origin ?? null);
        if (entry.closed !== undefined) return { closed: entry.closed };
        try { entry.socket.send(this.decoder.decode(request.body)); }
        catch { this.closeSocket(request.id, "before request dispatch", "failed"); return { closed: entry.closed }; }
        entry.timing.sends = (entry.timing.sends ?? 0) + 1;
        this.counters.socket_sends++;
        return null;
      }
      case "socket_next": {
        const entry = this.sockets.get(request.id);
        if (!entry) return { closed: "after the client released it" };
        if (entry.frames.length) return this.frame(entry);
        if (entry.closed !== undefined) return { closed: entry.closed };
        if (entry.waiter) throw new Error("socket_next is already pending");
        const readStarted = performance.now();
        try {
          return await new Promise(resolve => {
            const timer = entry.idle ? setTimeout(() => this.closeSocket(request.id, "after the stream idle deadline elapsed", "failed"), entry.idle) : undefined;
            const clear = () => { if (timer !== undefined) clearTimeout(timer); };
            entry.waiter = { id, resolve: value => { clear(); resolve(value); } };
            this.onCancel(id, () => {
              clear();
              if (entry.waiter?.id === id) entry.waiter = undefined;
              resolve(null);
            });
          });
        } finally { entry.timing.body_read_wait_ms += performance.now() - readStarted; }
      }
      case "socket_wait": {
        const entry = this.sockets.get(request.id);
        if (!entry || entry.closed !== undefined) return null;
        return new Promise(resolve => {
          entry.watchers.push(() => resolve(null));
          this.onCancel(id, () => resolve(null));
        });
      }
      case "socket_close": {
        this.closeSocket(request.id, "by the client", "closed");
        this.sockets.delete(request.id);
        return null;
      }
      case "events": {
        this.counters.event_batches++;
        this.counters.events += request.events.length;
        this.options.published(request.events, request.bytes);
        this.notify();
        return null;
      }
      case "turn_finished": return await this.options.finishing?.(request.request_id) ?? {};
      case "store": {
        this.counters.store_calls++;
        const started = performance.now();
        try { return this.rows(await this.sql.transaction("store", request.operation, request.statements)); }
        finally { this.checkpointTimings.record(request.operation, performance.now() - started); }
      }
      case "blob_put": {
        await this.blobs().put(request.key, request.body);
        return null;
      }
      case "blob_get": return await this.blobs().get(request.key);
      case "log": {
        this.counters.log_calls++;
        return this.rows(await this.sql.transaction("log", request.operation, request.statements));
      }
      default: throw new Error("unsupported host operation");
    }
  }

  private blobs() {
    if (!this.options.blobs) throw new Error("the host blob store is not configured");
    return this.options.blobs;
  }

  private workspace(): WorkspaceHost {
    if (!this.options.workspace) throw new Error("the host workspace is not configured");
    return this.options.workspace;
  }

  private notify() {
    for (const watcher of [...this.watchers]) watcher();
  }

  private rows(statements: SqlValue[][][]): Uint8Array {
    let capacity = 4;
    for (const rows of statements) {
      capacity += 4;
      for (const row of rows) {
        capacity += 4 + 4 * row.length;
        for (const cell of row) if (typeof cell === "string") capacity += 3 * cell.length;
      }
    }
    const bytes = new Uint8Array(capacity);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    const count = (value: number) => { view.setUint32(offset, value, true); offset += 4; };
    count(statements.length);
    for (const rows of statements) {
      count(rows.length);
      for (const row of rows) {
        count(row.length);
        for (const cell of row) {
          if (cell === null) { count(NULL_CELL); continue; }
          if (typeof cell !== "string") throw new Error("SQL host returned a value that is neither text nor null");
          const { written } = this.encoder.encodeInto(cell, bytes.subarray(offset + 4));
          count(written);
          offset += written;
        }
      }
    }
    return bytes.subarray(0, offset);
  }

  private receive(entry: Socket, data: unknown) {
    if (entry.closed !== undefined) return;
    const at = this.elapsed() - entry.timing.started_ms;
    entry.timing.first_byte_ms ??= at;
    entry.timing.last_byte_ms = at;
    entry.timing.body_reads++;
    this.counters.socket_frames++;
    entry.frames.push(typeof data === "string" ? data : null);
    const waiter = entry.waiter;
    if (!waiter) return;
    entry.waiter = undefined;
    waiter.resolve(this.frame(entry));
  }

  private frame(entry: Socket): unknown {
    const frame = entry.frames.shift();
    if (frame === null || frame === undefined) return { binary: true };
    const bytes = this.encoder.encode(frame);
    entry.timing.bytes += bytes.byteLength;
    return bytes;
  }

  private closeSocket(handle: number, detail: string, outcome: ModelTiming["outcome"]) {
    const entry = this.sockets.get(handle);
    if (!entry || entry.closed !== undefined) return;
    entry.closed = detail;
    this.finishModel(entry.timing, outcome);
    try { entry.socket.close(1000, "closed"); } catch {}
    const waiter = entry.waiter;
    entry.waiter = undefined;
    waiter?.resolve({ closed: detail });
    for (const watcher of entry.watchers.splice(0)) watcher();
  }

  releaseConnections(): void {
    this.closeSockets("released while the session is idle", "closed");
  }

  private closeSockets(detail: string, outcome: ModelTiming["outcome"]) {
    for (const handle of [...this.sockets.keys()]) this.closeSocket(handle, detail, outcome);
  }

  private complete(id: number, reply: { ok: unknown } | { error: unknown }) {
    if (!this.live(id)) {
      this.counters.dropped_replies++;
      return;
    }
    this.inflight.delete(id);
    if ("ok" in reply && isFramed(reply.ok)) this.enter("complete_bytes", id, ...this.writeFramed(reply.ok));
    else if ("ok" in reply && reply.ok instanceof Uint8Array) this.enter("complete_bytes", id, ...this.writeBytes(reply.ok));
    else this.enter("complete", id, ...this.write(reply));
  }

  private command(op: string, fields: object): Promise<unknown> {
    if (this.stopped) return Promise.reject(this.failure ?? new Error("agent runtime is closed"));
    const id = ++this.nextCommand;
    return new Promise((resolve, reject) => {
      this.commands.set(id, { resolve, reject });
      this.enter("command", id, ...this.write({ [op]: fields }));
    });
  }

  private enter(call: EngineCall, id: number, length: number, fill: (target: Uint8Array) => void) {
    if (this.depth > 0) {
      queueMicrotask(() => this.enter(call, id, length, fill));
      return;
    }
    if (this.stopped) return;
    this.depth++;
    const started = performance.now();
    try {
      this.engine.enter(call, id, length, fill);
    } catch (error) {
      this.fail(error);
    } finally {
      this.timings.record("wasm.enter", performance.now() - started);
      this.depth--;
    }
  }

  private fail(error: unknown) {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    this.terminate(this.failure);
  }

  private terminate(reason: unknown) {
    if (this.stopped) return;
    this.stopped = true;
    this.engine?.close?.();
    const cancellations = [...this.inflight.values()];
    this.counters.host_cancellations += cancellations.length;
    this.inflight.clear();
    for (const cancel of cancellations) cancel();
    for (const { reader, timing } of this.bodies.values()) { this.finishModel(timing, "cancelled"); void reader.cancel().catch(() => undefined); }
    this.bodies.clear();
    this.closeSockets("agent runtime disposed", "cancelled");
    this.sockets.clear();
    const commands = [...this.commands.values()];
    this.commands.clear();
    for (const pending of commands) pending.reject(reason);
    this.notify();
  }

  private write(value: unknown) {
    const started = performance.now();
    try { return this.writeBytes(this.encoder.encode(JSON.stringify(value))); }
    finally { this.timings.record("bridge.encode", performance.now() - started); }
  }

  private writeBytes(bytes: Uint8Array) {
    this.counters.bridge_reply_bytes += bytes.byteLength;
    return [bytes.length, (target: Uint8Array) => {
      const started = performance.now();
      target.set(bytes);
      this.timings.record("bridge.copy", performance.now() - started);
    }] as const;
  }

  private writeFramed(reply: Framed) {
    const head = this.encoder.encode(JSON.stringify(reply.head));
    const length = reply.body.byteLength + head.byteLength + 4;
    this.counters.bridge_reply_bytes += length;
    return [length, (target: Uint8Array) => {
      const started = performance.now();
      target.set(reply.body);
      target.set(head, reply.body.byteLength);
      new DataView(target.buffer, target.byteOffset + length - 4, 4).setUint32(0, head.byteLength, true);
      this.timings.record("bridge.copy", performance.now() - started);
    }] as const;
  }

  private static encodeError(error: unknown) {
    return { detail: error instanceof Error ? error.message : String(error), ...(error instanceof RemoteRefusal ? { unsent: true } : {}) };
  }

  private elapsed(): number { return performance.now() - this.started; }

  private finishModel(timing: ModelTiming, outcome: ModelTiming["outcome"]): void {
    if (timing.outcome) return;
    timing.outcome = outcome;
    timing.duration_ms = this.elapsed() - timing.started_ms;
  }
}

const FRAMED = Symbol("framed");

type Framed = { [FRAMED]: true; head: unknown; body: Uint8Array };

function framed(head: unknown, body: Uint8Array): Framed {
  return { [FRAMED]: true, head, body };
}

function isFramed(value: unknown): value is Framed {
  return typeof value === "object" && value !== null && FRAMED in value;
}

function cellPath(cwd: string, path: string): string {
  return path.startsWith("/") ? path : cwd.replace(/\/+$/, "") + "/" + path;
}

function shellQuote(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

const FILE_CHUNK = 600_000;

async function shellBytes(workspace: WorkspaceHost, command: string): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const result = await workspace.run({ command, cwd: "/", timeout_ms: null }, new AbortController().signal);
  if (result.exit_code !== 0) throw new Error(result.stderr.trim() || command.split(" ")[0] + " exited with " + result.exit_code);
  return { bytes: Uint8Array.from(atob(result.stdout.trim()), character => character.charCodeAt(0)), truncated: result.truncated };
}

export async function readBytes(workspace: WorkspaceHost, path: string): Promise<Uint8Array> {
  if (workspace.readBytes) return workspace.readBytes(path);
  const whole = await workspace.run({ command: "base64 -w0 -- " + shellQuote(path), cwd: "/", timeout_ms: null }, new AbortController().signal);
  if (whole.exit_code !== 0) throw new Error(whole.stderr.trim() || "base64 exited with " + whole.exit_code);
  if (!whole.truncated) return Uint8Array.from(atob(whole.stdout.trim()), character => character.charCodeAt(0));
  const size = await workspace.run({ command: "wc -c < " + shellQuote(path), cwd: "/", timeout_ms: null }, new AbortController().signal);
  const total = parseInt(size.stdout, 10);
  const out = new Uint8Array(total);
  for (let offset = 0; offset < total; offset += FILE_CHUNK) {
    const chunk = await shellBytes(workspace, "tail -c +" + (offset + 1) + " -- " + shellQuote(path) + " | head -c " + FILE_CHUNK + " | base64 -w0");
    if (chunk.truncated) throw new Error("reading " + path + " was truncated");
    out.set(chunk.bytes, offset);
  }
  return out;
}

export async function writeBytes(workspace: WorkspaceHost, path: string, data: Uint8Array, append: boolean): Promise<void> {
  if (workspace.writeBytes) return workspace.writeBytes(path, data, append);
  let encoded = "";
  for (let index = 0; index < data.length; index += 0x8000) encoded += String.fromCharCode(...data.subarray(index, index + 0x8000));
  const result = await workspace.run({ command: "mkdir -p -- \"$(dirname -- " + shellQuote(path) + ")\" && base64 -d " + (append ? ">>" : ">") + " " + shellQuote(path), cwd: "/", timeout_ms: null, stdin: btoa(encoded) }, new AbortController().signal);
  if (result.exit_code !== 0) throw new Error(result.stderr.trim() || "write exited with " + result.exit_code);
}

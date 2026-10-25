export type ModelProvider = "claude" | "codex";

export function sessionUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = BigInt(Date.now());
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(time & 255n);
    time >>= 8n;
  }
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type HostTool = { name: string; description: string; parameters: Record<string, unknown>; content?: boolean };

export type Thinking = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ServiceTier = "standard" | "priority" | "fast" | "ultrafast";

export type ReasoningMode = "standard" | "pro";

export type RuntimeSettings = { thinking?: Thinking; service_tier?: ServiceTier };

export type ProviderEndpoint = {
  endpoint: string;
  subscription?: boolean;
  gateway?: "vercel" | "workers_ai";
  cloudflare_account_id?: string;
  max_tokens?: number;
  instructions?: string;
};

export type HandToolSelection = { include?: string[]; exclude?: string[] };

export type AgentConfiguration = {
  scope: string;
  provider?: ModelProvider;
  model?: string;
  thinking?: Thinking;
  instructions?: string;
  session_id: string;
  subscription: boolean;
  endpoint: string;
  gateway?: "vercel" | "workers_ai";
  cloudflare_account_id?: string;
  max_tokens?: number;
  service_tier?: ServiceTier;
  subagents?: boolean;
  providers?: Partial<Record<ModelProvider, ProviderEndpoint>>;
  remote?: boolean;
  executor?: string;
  hands?: boolean;
  code_mode?: boolean;
  event_coalesce_ms?: number;
  live_deltas?: boolean;
  stream_tool_input?: boolean;
  auto_compact_window_tokens?: number;
  environment?: { cwd?: string; shell?: string; timezone?: string };
  tools?: HostTool[];
  web_search?: boolean | Partial<Record<ModelProvider, boolean>>;
  workspace?: string;
  workspace_tools?: WorkspaceTools | Partial<Record<ModelProvider, WorkspaceTools>>;
  mcp_servers?: McpServer[];
  hand_tools?: Partial<Record<ModelProvider, HandToolSelection>>;
};

export type WorkspaceTools = "all" | "files" | "none";

export type McpServer = { name: string; url: string; headers?: Record<string, string>; bearer_token?: string };

export type ModelGateway = "direct" | "vercel" | "workers_ai";

export type ModelEntry = { id: string; name: string; efforts: Thinking[]; effort: Thinking; priority: boolean; service_tiers: ServiceTier[]; reasoning_modes: ReasoningMode[]; gateways: ModelGateway[]; context_window_tokens: number; auto_compact_token_limit: number | null };

export type ModelCatalog = { harnesses: { id: ModelProvider; models: ModelEntry[] }[] };

export type ToolCallContext = {
  session_id: string;
  call_id: string;
  turn_id: string | null;
  model: string;
  instruction_revision: number | null;
  origin: string | null;
};

export type SubagentStatus =
  | { state: "pending" | "running" | "interrupted" | "closing" | "closed" }
  | { state: "completed"; output: unknown }
  | { state: "failed"; error: string };

export type SubagentSummary = {
  agent_id: number;
  role: string;
  task: string;
  parent_agent_id: number | null;
  status: SubagentStatus;
  model?: string | { backend: string; model: string };
  thinking?: Thinking;
  reasoning_mode: "standard" | "pro";
  last_output?: unknown;
  completion_revision?: number;
  usage?: Record<string, unknown>;
};

export type TurnReport = Record<string, unknown> & { request_id: string; status: string };

export class HostFailure extends Error {
  readonly kind: string;
  readonly permanent: boolean;

  constructor(message: string, kind: string, permanent: boolean) {
    super(message);
    this.kind = kind;
    this.permanent = permanent;
  }
}

export class RemoteRefusal extends Error {}

export type TurnView = { report: TurnReport; first_seq: number; last_seq: number | null; cancel_requested: boolean; metadata: unknown };

export type Submitted = { submitted: "accepted" | "existing" | "conflict"; turn: TurnView } | { submitted: "too_large"; bytes: number; limit: number };
export type Replaced = { replaced: "applied" | "already_applied" | "not_queued" | "conflict" } | { replaced: "too_large"; bytes: number; limit: number };
export type MovedQueued = "moved" | "not_queued" | "not_running" | "conflict" | "unknown";

export type LoggedEvent = { seq: number; request_id: string | null; created_at: number; event: unknown };

export type LogPage = { events: LoggedEvent[]; next_cursor: number; has_more: boolean };

export type HostEvent = { source: string; [field: string]: unknown };

export type Driven = { idle?: boolean; busy?: boolean; waiting?: boolean; retry?: boolean; request_id?: string; resumed?: string; finished?: TurnView };

export type Compacted = { compacted: true } | { busy: true };

export type BranchPoint = "latest" | { through: string } | { before: string };

export type BranchBoundary = { source_session_id: string; through_turn?: string };

export type SessionRecord = Record<string, unknown> & { session_id: string; branch?: BranchBoundary };

export type BranchExport = { record: SessionRecord; boundary: BranchBoundary; checkpoint: string | null; inherited: string; turns: number; preview: string | null };

export type BranchCursor = { entry: number; offset: number };

export type BranchPage = { cursor: BranchCursor; next: BranchCursor | null; records: { key: string; value: string }[] };

export type BranchSummary = { record: SessionRecord; preview: string | null };

export const RECENT_MODEL_LIMIT = 64;

export type ModelTiming = {
  dispatch_id: number;
  transport?: "websocket";
  started_ms: number;
  headers_ms?: number;
  first_byte_ms?: number;
  last_byte_ms?: number;
  body_read_wait_ms: number;
  body_reads: number;
  bytes: number;
  max_chunk_gap_ms: number;
  sends?: number;
  duration_ms?: number;
  status?: number;
  outcome?: "eof" | "closed" | "cancelled" | "failed";
  diagnostic?: unknown;
};

export type RuntimeTiming = ModelTiming & { runtime_id: string };

export type SqlValue = string | number | null | ArrayBuffer;

export type Statement = [string, ...SqlValue[]];

export type SqlKind = "store" | "log";

export interface SqlHost {
  readonly value_limit?: number;
  transaction(kind: SqlKind, operation: string, statements: Statement[]): SqlValue[][][] | Promise<SqlValue[][][]>;
}

export interface MessageSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: any) => void): void;
}

export type SocketHandshake = {
  status: number;
  headers: Iterable<[string, string]>;
  socket?: MessageSocket;
  idle_ms?: number;
  text(): Promise<string>;
};

export type RemoteRequest = { op: string; connection?: string | null; frames?: string[]; durable?: boolean; dispatches?: boolean; origins?: { index: number; origin: string | null }[]; refused?: number[]; reason?: string };

export type ShellRun = { command: string; cwd: string; timeout_ms: number | null; stdin?: string };

export type ShellOutput = { stdout: string; stderr: string; exit_code: number; truncated: boolean };

export interface WorkspaceHost {
  instructions?: string;
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
  readBytes?(path: string): Promise<Uint8Array>;
  writeBytes?(path: string, data: Uint8Array, append: boolean): Promise<void>;
  remove(path: string): Promise<void>;
  run(request: ShellRun, signal: AbortSignal): Promise<ShellOutput>;
  wasm?(request: unknown, signal: AbortSignal): Promise<unknown>;
}

export type LogPageOptions = { request_id?: string; max_bytes?: number };

export type BlobHost = {
  threshold?: number;
  put(key: string, bytes: Uint8Array): void | Promise<void>;
  get(key: string): Uint8Array | null | Promise<Uint8Array | null>;
};

export type EngineHost = {
  dispatch(id: number, request: Uint8Array, body?: Uint8Array): void;
  cancel(id: number): void;
  reply(id: number, bytes: Uint8Array): void;
  panicked(bytes: Uint8Array): void;
};

export type EngineCall = "command" | "complete" | "complete_bytes";

export type Engine = {
  readonly memoryBytes: number;
  enter(call: EngineCall | null, id: number, length: number, fill: ((target: Uint8Array) => void) | null): void;
  close?(): void;
};

export type EngineFactory = (module: WebAssembly.Module, host: EngineHost) => Promise<Engine>;

export type HostOptions = {
  engine?: EngineFactory;
  log_logical_limit?: number;
  blobs?: BlobHost;
  published(events: LoggedEvent[], bytes: number[]): void;
  live?(events: LoggedEvent[]): void;
  wake?(): void;
};

export type RuntimeOptions = {
  dispatch(request: { provider: ModelProvider | null; endpoint: string; method: string; headers: [string, string][]; body: Uint8Array; origin: string | null }, signal: AbortSignal, timing: RuntimeTiming): Promise<Response>;
  finishing?(request_id: string): Record<string, unknown> | Promise<Record<string, unknown>>;
  socket?: {
    open(request: { provider: ModelProvider; headers: [string, string][]; origin: string | null }, signal: AbortSignal, timing: RuntimeTiming): Promise<SocketHandshake>;
    admit(origin: string | null): Promise<void>;
  };
  tools?: {
    call(name: string, input: unknown, signal: AbortSignal, context: ToolCallContext): Promise<unknown>;
  };
  workspace?: WorkspaceHost;
  fetch?(input: string, init: RequestInit): Promise<Response>;
  mcp?: { deferred?: boolean; cacheMs?: number; core?: Record<string, readonly string[]> };
  remote?: {
    failed?(): boolean;
    execute(request: RemoteRequest, id: number): Promise<unknown>;
    cancel(id: number): void;
    dispose(): Promise<void>;
  };
};

/**
 * Contracts between hosts and the WebAssembly runtime: SQL, workspace, socket, engine, and model types, and the configuration of a session.
 *
 * @module
 */
/** Model harness of a session. */
export type ModelProvider = 'claude' | 'codex'

/** Returns a new UUIDv7 session ID. */
export function sessionUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let time = BigInt(Date.now())
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(time & 255n)
    time >>= 8n
  }
  bytes[6] = (bytes[6] & 15) | 112
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Tool that the host defines and runs through `RuntimeOptions.tools`. */
export type HostTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  content?: boolean
}

/** Reasoning effort. */
export type Thinking = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Service tier of model requests. */
export type ServiceTier = 'standard' | 'priority' | 'fast' | 'ultrafast'

/** Reasoning mode of a model. */
export type ReasoningMode = 'standard' | 'pro'

/** Settings that change between turns. */
export type RuntimeSettings = { thinking?: Thinking; service_tier?: ServiceTier }

/** Endpoint and limits of one model provider. */
export type ProviderEndpoint = {
  endpoint: string
  subscription?: boolean
  gateway?: 'vercel' | 'workers_ai'
  cloudflare_account_id?: string
  max_tokens?: number
  instructions?: string
}

/** Tools of a remote hand that a session advertises, by name. */
export type HandToolSelection = { include?: string[]; exclude?: string[] }

/** Configuration that opens a session. Its fields mirror `Configuration` in `src/wasm.rs`. */
export type AgentConfiguration = {
  scope: string
  provider?: ModelProvider
  model?: string
  thinking?: Thinking
  instructions?: string
  session_id: string
  subscription: boolean
  endpoint: string
  gateway?: 'vercel' | 'workers_ai'
  cloudflare_account_id?: string
  max_tokens?: number
  service_tier?: ServiceTier
  subagents?: boolean
  providers?: Partial<Record<ModelProvider, ProviderEndpoint>>
  remote?: boolean
  executor?: string
  hands?: boolean
  code_mode?: boolean
  event_coalesce_ms?: number
  live_deltas?: boolean
  stream_tool_input?: boolean
  auto_compact_window_tokens?: number
  environment?: { cwd?: string; shell?: string; timezone?: string; project_instructions?: string }
  tools?: HostTool[]
  web_search?: boolean | Partial<Record<ModelProvider, boolean>>
  workspace?: string
  workspace_tools?: WorkspaceTools | Partial<Record<ModelProvider, WorkspaceTools>>
  mcp_servers?: McpServer[]
  hand_tools?: Partial<Record<ModelProvider, HandToolSelection>>
}

/** Workspace tools that a session receives. */
export type WorkspaceTools = 'all' | 'files' | 'none'

/** MCP server of a session. */
export type McpServer = {
  name: string
  url: string
  headers?: Record<string, string>
  bearer_token?: string
}

/** Gateway that serves a model. */
export type ModelGateway = 'direct' | 'vercel' | 'workers_ai'

/** Model in the SDK's catalog. */
export type ModelEntry = {
  id: string
  name: string
  efforts: Thinking[]
  effort: Thinking
  priority: boolean
  service_tiers: ServiceTier[]
  reasoning_modes: ReasoningMode[]
  gateways: ModelGateway[]
  context_window_tokens: number
  auto_compact_token_limit: number | null
}

/** Models of each harness, from the SDK. */
export type ModelCatalog = { harnesses: { id: ModelProvider; models: ModelEntry[] }[] }

/** Context of a host tool call: the calling agent's session, call, turn, and model. */
export type ToolCallContext = {
  session_id: string
  call_id: string
  turn_id: string | null
  model: string
  instruction_revision: number | null
  origin: string | null
}

/** State of a subagent. */
export type SubagentStatus =
  | { state: 'pending' | 'running' | 'interrupted' | 'closing' | 'closed' }
  | { state: 'completed'; output: unknown }
  | { state: 'failed'; error: string }

/** Subagent of a session. */
export type SubagentSummary = {
  agent_id: number
  role: string
  task: string
  parent_agent_id: number | null
  status: SubagentStatus
  model?: string | { backend: string; model: string }
  thinking?: Thinking
  reasoning_mode: 'standard' | 'pro'
  last_output?: unknown
  completion_revision?: number
  usage?: Record<string, unknown>
}

/** Report of a turn. */
export type TurnReport = Record<string, unknown> & { request_id: string; status: string }

/** Failure that the runtime reports, with its kind and whether a retry can succeed. */
export class HostFailureError extends Error {
  readonly kind: string
  readonly permanent: boolean

  override name = 'Contracts.HostFailureError'

  constructor(message: string, kind: string, permanent: boolean) {
    super(message)
    this.kind = kind
    this.permanent = permanent
  }
}

/** Refusal of a remote hand to send frames. The module reads its frames as unsent. */
export class RemoteRefusalError extends Error {
  override name = 'Contracts.RemoteRefusalError'
}

/** Turn with its report and log range. */
export type TurnView = {
  report: TurnReport
  first_seq: number
  last_seq: number | null
  cancel_requested: boolean
  metadata: unknown
}

/** Result of a submit. */
export type Submitted =
  | { submitted: 'accepted' | 'existing' | 'conflict'; turn: TurnView }
  | { submitted: 'too_large'; bytes: number; limit: number }

/** Result of a queued-prompt replacement. */
export type Replaced =
  | { replaced: 'applied' | 'already_applied' | 'not_queued' | 'conflict' }
  | { replaced: 'too_large'; bytes: number; limit: number }

/** Result of moving a queued prompt. */
export type MovedQueued = 'moved' | 'not_queued' | 'not_running' | 'conflict' | 'unknown'

/** Event in a session log. */
export type LoggedEvent = {
  seq: number
  request_id: string | null
  created_at: number
  event: unknown
}

/** Page of a session log. */
export type LogPage = { events: LoggedEvent[]; next_cursor: number; has_more: boolean }

/** Event that a host appends to a session log. */
export type HostEvent = { source: string; [field: string]: unknown }

/** Result of one `drive` step. */
export type Driven = {
  idle?: boolean
  busy?: boolean
  waiting?: boolean
  retry?: boolean
  request_id?: string
  resumed?: string
  finished?: TurnView
}

/** Result of a compaction. */
export type Compacted = { compacted: true } | { busy: true }

/** Point of a session that a branch starts from. */
export type BranchPoint = 'latest' | { through: string } | { before: string }

/** Source session and last turn of a branch. */
export type BranchBoundary = { source_session_id: string; through_turn?: string }

/** Stored record of a session. */
export type SessionRecord = Record<string, unknown> & {
  session_id: string
  branch?: BranchBoundary
}

/** Exported branch of a session. */
export type BranchExport = {
  record: SessionRecord
  boundary: BranchBoundary
  checkpoint: string | null
  inherited: string
  turns: number
  preview: string | null
}

/** Position in an exported branch. */
export type BranchCursor = { entry: number; offset: number }

/** Page of an exported branch. */
export type BranchPage = {
  cursor: BranchCursor
  next: BranchCursor | null
  records: { key: string; value: string }[]
}

/** Published branch. */
export type BranchSummary = { record: SessionRecord; preview: string | null }

/** Number of recent model timings that a runtime keeps. */
export const recentModelLimit = 64

/** Timing of one model request. */
export type ModelTiming = {
  dispatch_id: number
  transport?: 'websocket'
  started_ms: number
  headers_ms?: number
  first_byte_ms?: number
  last_byte_ms?: number
  body_read_wait_ms: number
  body_reads: number
  bytes: number
  max_chunk_gap_ms: number
  sends?: number
  duration_ms?: number
  status?: number
  outcome?: 'eof' | 'closed' | 'cancelled' | 'failed'
  diagnostic?: unknown
}

/** Model timing with the runtime that made the request. */
export type RuntimeTiming = ModelTiming & { runtime_id: string }

/** Value of a SQL parameter or column. */
export type SqlValue = string | number | null | ArrayBuffer

/** SQL statement and its parameters. */
export type Statement = [string, ...SqlValue[]]

/** Store that a transaction writes: the session store or the event log. */
export type SqlKind = 'store' | 'log'

/** SQL host of a runtime. `transaction` runs every statement of one operation in one atomic SQLite transaction. */
export type SqlHost = {
  readonly value_limit?: number
  transaction(
    kind: SqlKind,
    operation: string,
    statements: Statement[],
  ): SqlValue[][][] | Promise<SqlValue[][][]>
}

/** WebSocket shape that hands and model sockets use. */
export type MessageSocket = {
  send(message: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: any) => void): void
}

/** Response of a model WebSocket handshake. */
export type SocketHandshake = {
  status: number
  headers: Iterable<[string, string]>
  socket?: MessageSocket
  idle_ms?: number
  text(): Promise<string>
}

/** Remote Code Mode operation of the SDK. */
export type RemoteRequest = {
  op: string
  connection?: string | null
  frames?: string[]
  durable?: boolean
  dispatches?: boolean
  origins?: { index: number; origin: string | null }[]
  refused?: number[]
  reason?: string
}

/** Shell command that a workspace runs. */
export type ShellRun = { command: string; cwd: string; timeout_ms: number | null; stdin?: string }

/** Output of a workspace shell command. */
export type ShellOutput = { stdout: string; stderr: string; exit_code: number; truncated: boolean }

/** Workspace that a session's file and shell tools run in. */
export type WorkspaceHost = {
  instructions?: string
  read(path: string): Promise<string | null>
  write(path: string, contents: string): Promise<void>
  readBytes?(path: string): Promise<Uint8Array>
  writeBytes?(path: string, data: Uint8Array, append: boolean): Promise<void>
  remove(path: string): Promise<void>
  run(request: ShellRun, signal: AbortSignal): Promise<ShellOutput>
  wasm?(request: unknown, signal: AbortSignal): Promise<unknown>
}

/** Options of a log page. */
export type LogPageOptions = { request_id?: string; max_bytes?: number }

/** Store for values larger than `threshold` bytes, which the module keeps out of SQL rows. */
export type BlobHost = {
  threshold?: number
  put(key: string, bytes: Uint8Array): void | Promise<void>
  get(key: string): Uint8Array | null | Promise<Uint8Array | null>
}

/** Host imports that the WebAssembly engine calls. */
export type EngineHost = {
  dispatch(id: number, request: Uint8Array, body?: Uint8Array): void
  cancel(id: number): void
  reply(id: number, bytes: Uint8Array): void
  panicked(bytes: Uint8Array): void
}

/** Entry points of the WebAssembly engine. */
export type EngineCall = 'command' | 'complete' | 'complete_bytes'

/** Instantiated WebAssembly engine. */
export type Engine = {
  readonly memoryBytes: number
  enter(
    call: EngineCall | null,
    id: number,
    length: number,
    fill: ((target: Uint8Array) => void) | null,
  ): void
  close?(): void
}

/** Instantiates the module into an engine. */
export type EngineFactory = (module: WebAssembly.Module, host: EngineHost) => Promise<Engine>

/** Options of `AgentRuntime.instantiate`. */
export type HostOptions = {
  engine?: EngineFactory
  log_logical_limit?: number
  blobs?: BlobHost
  published(events: LoggedEvent[], bytes: number[]): void
  live?(events: LoggedEvent[]): void
  wake?(): void
}

/** Host capabilities of an open session: model dispatch, sockets, tools, workspace, fetch, and remote hands. */
export type RuntimeOptions = {
  dispatch(
    request: {
      provider: ModelProvider | null
      endpoint: string
      method: string
      headers: [string, string][]
      body: Uint8Array
      origin: string | null
    },
    signal: AbortSignal,
    timing: RuntimeTiming,
  ): Promise<Response>
  finishing?(request_id: string): Record<string, unknown> | Promise<Record<string, unknown>>
  socket?: {
    open(
      request: { provider: ModelProvider; headers: [string, string][]; origin: string | null },
      signal: AbortSignal,
      timing: RuntimeTiming,
    ): Promise<SocketHandshake>
    admit(origin: string | null): Promise<void>
  }
  tools?: {
    call(
      name: string,
      input: unknown,
      signal: AbortSignal,
      context: ToolCallContext,
    ): Promise<unknown>
  }
  workspace?: WorkspaceHost
  fetch?(input: string, init: RequestInit): Promise<Response>
  mcp?: { cacheMs?: number }
  remote?: {
    failed?(): boolean
    execute(request: RemoteRequest, id: number): Promise<unknown>
    cancel(id: number): void
    dispose(): Promise<void>
  }
}

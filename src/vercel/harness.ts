import { type DriveContext, EffectFailure, Fatal, type Harness, type HostTool, hostToolIO, Restart, type SessionState, type Submission } from "durable-harness";
import { liveEvent } from "../client.ts";
import { AgentRuntime, type AgentConfiguration, HostFailure, type LoggedEvent, type McpServer, type ModelProvider, RemoteExecutor, type ServiceTier, sessionUuid, type Thinking } from "../index.ts";
import { type Dispatch, gatewayDispatch, gatewayEndpoint } from "./gateway.ts";
import { type Durability, type JournalStats, SqlJournal } from "./journal.ts";
import { nanocodeModule } from "./module.ts";
import { Bash, SqlFileSystem } from "../bash/index.ts";

export const SCOPE = "session";

export const SESSION_KEY = "nanocode.session";

export const WAIT_POLL_MS = 250;

export const DEFAULT_EVENT_COALESCE_MS = 50;

export type { ServiceTier, Thinking };

export type NanocodeSession = { session_id: string; provider: ModelProvider; model?: string; thinking?: Thinking; max_tokens?: number; service_tier?: ServiceTier };

export const EFFORT_COMMAND = /^\/effort\s+(\S+)\s*$/;

export type ModelCall = { index: number; replayed: boolean; first_output_ms: number | null; duration_ms: number; input_tokens: number; cached_tokens: number; output_tokens: number };

export type DriveReport = { run_id: string; attempt: number; durability: Durability; opened: boolean; duration_ms: number; replay_ms: number; open_ms: number; journal: JournalStats; model_requests: number; tool_calls: number; models: ModelCall[]; outcome: "idle" | "settled" | "stopped" | "failed"; error?: string };

export interface NanocodeHarnessOptions {
  name?: string;
  provider?: ModelProvider;
  model?: string;
  thinking?: AgentConfiguration["thinking"];
  instructions?: string;
  tools?: HostTool[];
  durability?: Durability;
  batchMs?: number;
  dispatch?: Dispatch;
  endpoint?: string;
  gateway?: "vercel";
  eventCoalesceMs?: number;
  module?: () => Promise<WebAssembly.Module>;
  report?: (report: DriveReport) => void;
  maxPrompts?: number;
  subagents?: boolean;
  streamToolInput?: boolean;
  codeMode?: boolean;
  workspace?: false | { cwd?: string; files?: Record<string, string> };
  fetch?: typeof fetch;
  hands?: { relay(channel: string): string; name?: string; timeoutMs?: number; maxFrameBytes?: number };
  mcp?: { servers: McpServer[]; fetch?(sessionId: string): typeof fetch };
}

export const HAND_CHANNEL = /^[A-Za-z0-9_-]{16,64}$/;

function openSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const fail = (reason: string) => { try { socket.close(); } catch {} reject(new Error(reason)); };
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => fail("the hand relay refused the connection"), { once: true });
    signal.addEventListener("abort", () => fail("the hand relay did not answer in time"), { once: true });
  });
}

const settledKey = (batches: number) => `nanocode.settled:${batches}`;

export function isIdle(state: SessionState, batches: number): boolean {
  return batches === 0 || state.effects.get(settledKey(batches))?.status === "completed";
}

export function nanocodeHarness(options: NanocodeHarnessOptions = {}): Harness {
  const tools = new Map((options.tools ?? []).map(tool => [tool.name, tool]));
  const definitions = [...tools.values()].map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema as Record<string, unknown> }));
  const dispatch = options.dispatch ?? gatewayDispatch();
  const gateway = options.endpoint ? options.gateway : "vercel";
  const module = options.module ?? nanocodeModule;
  const durability = options.durability ?? "on";

  async function run(ctx: DriveContext, journal: SqlJournal, session: NanocodeSession, counts: { model_requests: number; tool_calls: number; models: ModelCall[]; open_ms: number }): Promise<void> {
    const opening = performance.now();
    const runtime = await AgentRuntime.instantiate(await module(), journal, {
      published: events => {
        for (const logged of events) {
          const call = modelCall(logged);
          if (call) counts.models.push(call);
        }
        publish(ctx, events);
      },
    });
    const channel = (ctx.config as { hand?: unknown } | undefined)?.hand;
    const hands = options.hands;
    const executor = hands && typeof channel === "string" && HAND_CHANNEL.test(channel)
      ? await RemoteExecutor.connect(signal => openSocket(hands.relay(channel), signal), { max_frame_bytes: hands.maxFrameBytes ?? 1_048_576, timeout_ms: hands.timeoutMs ?? 30_000 }).catch(() => undefined)
      : undefined;
    const handName = hands?.name ?? "browser";
    const connection = executor ? handName + "#" + sessionUuid() : undefined;
    const shell = options.workspace === false || executor ? undefined : await Bash.create({ fs: new SqlFileSystem(journal, SCOPE), cwd: options.workspace?.cwd ?? "/workspace", ...(options.workspace?.files ? { files: options.workspace.files } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
    const mcpServers = options.mcp?.servers ?? [];
    const mcpFetch = options.mcp?.fetch?.(ctx.runId) ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const stop = () => void runtime.dispose().catch(() => undefined);
    ctx.signal.addEventListener("abort", stop, { once: true });
    try {
      try {
        await runtime.open({
          scope: SCOPE,
          session_id: session.session_id,
          provider: session.provider,
          model: session.model,
          thinking: session.thinking,
          max_tokens: session.max_tokens,
          service_tier: session.service_tier,
          subagents: options.subagents,
          instructions: options.instructions,
          subscription: false,
          endpoint: options.endpoint ?? gatewayEndpoint(session.provider),
          gateway,
          event_coalesce_ms: options.eventCoalesceMs ?? DEFAULT_EVENT_COALESCE_MS,
          stream_tool_input: options.streamToolInput,
          code_mode: executor ? false : options.codeMode,
          ...(executor ? { hands: true } : {}),
          tools: definitions,
          ...(mcpServers.length ? { mcp_servers: mcpServers } : {}),
          ...(shell ? { workspace: shell.cwd } : {}),
        }, {
          ...(shell ? { workspace: shell.workspace() } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(executor ? {
            remote: {
              failed: () => executor.failure !== undefined,
              execute: async (request: { op: string; durable?: boolean }, id: number) => {
                if (request.op === "remote_send" && request.durable !== false) await journal.durable();
                return executor.execute(request as Parameters<typeof executor.execute>[0], id);
              },
              cancel: (id: number) => executor.cancel(id),
              dispose: () => executor.dispose(),
            },
          } : {}),
          dispatch: (request, signal) => {
            if (request.provider == null && mcpServers.length) return mcpFetch(request.endpoint, { method: request.method, headers: request.headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body as Uint8Array<ArrayBuffer>, signal });
            counts.model_requests++;
            return dispatch(request, signal);
          },
          tools: {
            call: (name, input, signal, { call_id }) => {
              counts.tool_calls++;
              return callTool(ctx, journal, tools, name, input, signal, call_id);
            },
          },
        });
      } catch (error) {
        if (error instanceof HostFailure && error.permanent) throw new Fatal(`nanocode refused its configuration: ${error.message}`);
        throw error;
      }
      if (executor && connection) {
        executor.claim(runtime);
        await runtime.attach(handName, connection);
      }
      counts.open_ms = performance.now() - opening;
      let applied: Thinking | undefined;
      for (;;) {
        await ctx.refresh();
        const pending = ctx.pending();
        let thinking = pending[0] && effort(ctx.state(), pending[0].id, session.thinking);
        for (const submission of pending) thinking = await place(ctx, journal, runtime, submission, thinking, options.maxPrompts, executor ? handName : undefined);
        const next = (await runtime.pending(SCOPE))[0];
        if (!next) {
          if (await runtime.settle()) return;
          await changed(runtime, ctx.signal);
          continue;
        }
        const wanted = (next.metadata as { thinking?: Thinking } | null)?.thinking;
        if (wanted && wanted !== applied) {
          await runtime.setThinking(wanted);
          applied = wanted;
        }
        const driving = runtime.drive(next.report.request_id);
        const steering = steer(ctx, journal, runtime, driving, options.maxPrompts);
        const driven = await driving;
        await steering;
        if (ctx.signal.aborted) return;
        if (driven.retry) {
          if (ctx.attempt === 0) throw new Restart(`nanocode asked to reopen its runtime for ${driven.request_id ?? next.report.request_id}`);
          throw new Error(`nanocode asked again to reopen its runtime for ${driven.request_id ?? next.report.request_id}`);
        }
        if (driven.waiting) await changed(runtime, ctx.signal);
      }
    } catch (error) {
      if (ctx.signal.aborted) return;
      throw error;
    } finally {
      ctx.signal.removeEventListener("abort", stop);
      await executor?.dispose().catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
    }
  }

  return {
    name: options.name ?? "nanocode",
    modelCalls: "self",
    async drive(ctx) {
      const started = performance.now();
      const journal = new SqlJournal(ctx, durability, options.batchMs);
      const replay_ms = performance.now() - started;
      const counts = { model_requests: 0, tool_calls: 0, models: [] as ModelCall[], open_ms: 0 };
      let outcome: DriveReport["outcome"] = "idle";
      let failure: unknown;
      try {
        if (ctx.pending().length === 0 && isIdle(ctx.state(), journal.batches)) return;
        const chosen = (ctx.config as { nanocode?: { provider?: ModelProvider; model?: string; thinking?: Thinking; max_tokens?: number; service_tier?: ServiceTier } } | undefined)?.nanocode;
        const provider = chosen?.provider ?? options.provider ?? "claude";
        const model = chosen?.provider ? chosen.model : options.model;
        const thinking = chosen?.provider ? chosen.thinking : options.thinking;
        const max_tokens = chosen?.provider ? chosen.max_tokens : undefined;
        const service_tier = chosen?.provider ? chosen.service_tier : undefined;
        const session = await ctx.effect(SESSION_KEY, { name: SESSION_KEY, replay: "safe", input: { provider, model, thinking, ...(max_tokens ? { max_tokens } : {}), ...(service_tier ? { service_tier } : {}) } }, async (): Promise<NanocodeSession> => ({
          session_id: sessionUuid(),
          provider,
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(max_tokens ? { max_tokens } : {}),
          ...(service_tier ? { service_tier } : {}),
        }));
        await run(ctx, journal, session, counts);
        if (ctx.signal.aborted) {
          outcome = "stopped";
          throw ctx.signal.reason;
        }
        await journal.durable();
        await ctx.effect(settledKey(journal.batches), { name: "nanocode.settled", replay: "safe", input: { batches: journal.batches } }, async () => ({}));
        ctx.live({ type: "idle" });
        outcome = "settled";
      } catch (error) {
        if (outcome !== "stopped") outcome = "failed";
        failure = error;
        throw error;
      } finally {
        journal.close();
        options.report?.({
          run_id: ctx.runId,
          attempt: ctx.attempt,
          durability,
          opened: outcome !== "idle",
          duration_ms: performance.now() - started,
          replay_ms,
          journal: journal.stats,
          ...counts,
          outcome,
          ...(failure !== undefined ? { error: failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure) } : {}),
        });
      }
    },
  };
}

export function effort(state: SessionState, before: string, initial: Thinking | undefined): Thinking | undefined {
  let current = initial;
  for (const submission of state.submissions) {
    if (submission.id === before) break;
    const placed = state.effects.get(`nanocode.place:${submission.id}`)?.output as { thinking?: Thinking } | undefined;
    if (placed?.thinking) current = placed.thinking;
  }
  return current;
}

export function exceeds(state: SessionState, id: string, limit: number | undefined): boolean {
  if (limit === undefined) return false;
  let index = 0;
  for (const submission of state.submissions) {
    if (submission.id === id) return index >= limit;
    if (submission.kind !== "chaos" && submission.kind !== "withdraw") index++;
  }
  return false;
}

async function place(ctx: DriveContext, journal: SqlJournal, runtime: AgentRuntime, submission: Submission, thinking: Thinking | undefined, limit: number | undefined, hand?: string): Promise<Thinking | undefined> {
  if (exceeds(ctx.state(), submission.id, limit)) {
    await ctx.effect(`nanocode.place:${submission.id}`, { name: "nanocode.refused", replay: "safe", placed: [submission.id], input: { request_id: submission.id } }, async () => ({ refused: "limit" }));
    ctx.live({ type: "error", message: `this session takes at most ${limit} prompts; start a new session`, request_id: submission.id });
    return thinking;
  }
  const command = submission.kind === "prompt" ? EFFORT_COMMAND.exec(submission.text ?? "") : null;
  if (command) {
    const level = command[1] as Thinking;
    const outcome = await ctx.effect(`nanocode.place:${submission.id}`, { name: "nanocode.effort", replay: "safe", placed: [submission.id], input: { thinking: level } }, () =>
      runtime.checkThinking(level).then(() => ({ thinking: level }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))) as { thinking?: Thinking; error?: string };
    ctx.live(outcome.thinking ? { type: "effort", thinking: outcome.thinking, request_id: submission.id } : { type: "error", message: outcome.error, request_id: submission.id });
    return outcome.thinking ?? thinking;
  }
  const submitted = await runtime.submit(SCOPE, { request_id: submission.id, prompt: submission.text ?? "", ...(hand ? { hand } : {}), metadata: { kind: submission.kind, ...(thinking ? { thinking } : {}) } });
  await journal.durable();
  await ctx.effect(`nanocode.place:${submission.id}`, { name: "nanocode.place", replay: "safe", placed: [submission.id], input: { request_id: submission.id } }, async () => ({ submitted: submitted.submitted }));
  if (submitted.submitted === "too_large") ctx.live({ type: "error", message: `the prompt needs ${submitted.bytes} bytes and the session log stores ${submitted.limit}` });
  else if (submitted.submitted === "conflict") ctx.live({ type: "error", message: `message ${submission.id} was already submitted with another prompt` });
  return thinking;
}

async function steer(ctx: DriveContext, journal: SqlJournal, runtime: AgentRuntime, driving: Promise<unknown>, limit: number | undefined): Promise<void> {
  let done = false;
  const finished = driving.then(() => { done = true; }, () => { done = true; });
  for (;;) {
    await Promise.race([finished, submitted(ctx)]);
    if (done || ctx.signal.aborted) return;
    await ctx.refresh();
    for (const submission of ctx.pending()) {
      if (submission.kind !== "steer" || exceeds(ctx.state(), submission.id, limit) || !await runtime.steer(submission.id, submission.text ?? "")) continue;
      await journal.durable();
      await ctx.effect(`nanocode.place:${submission.id}`, { name: "nanocode.steer", replay: "safe", placed: [submission.id], input: { request_id: submission.id } }, async () => ({ steered: true }));
      ctx.live({ type: "steered", request_id: submission.id });
    }
  }
}

function submitted(ctx: DriveContext): Promise<void> {
  return new Promise(resolve => {
    let unsubscribe: (() => void) | undefined;
    const timer = ctx.onHint ? undefined : setTimeout(done, WAIT_POLL_MS);
    unsubscribe = ctx.onHint?.(hint => {
      if (hint.eventType === "hook_received") done();
    });
    function done() {
      clearTimeout(timer);
      unsubscribe?.();
      resolve();
    }
  });
}

async function callTool(ctx: DriveContext, journal: SqlJournal, tools: Map<string, HostTool>, name: string, input: unknown, signal: AbortSignal, callId: string): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no host tool is named ${name}`);
  try {
    await journal.durable();
    return await ctx.effect(`tool:${callId}`, { name: `tool.${name}`, replay: tool.replay, input }, io => tool.execute(input, hostToolIO(io, ctx, { signal: AbortSignal.any([signal, io.signal]) })));
  } catch (error) {
    if (error instanceof EffectFailure) throw new Error(error.error.interrupted ? `${name} was interrupted before it reported a result, so it may have run` : error.message);
    ctx.halt?.(error);
    throw error;
  }
}

function changed(runtime: AgentRuntime, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, WAIT_POLL_MS);
    void runtime.changed(signal).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function modelCall(logged: LoggedEvent): ModelCall | undefined {
  const body = logged.event as { source?: string; event?: { type: string; payload: { call_index: number; duration_ns: number; time_to_first_output_ns: number | null; timing?: { replayed?: boolean }; usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens?: number } } } };
  if (body.source !== "agent" || body.event?.type !== "model.call.completed") return undefined;
  const { call_index, duration_ns, time_to_first_output_ns, timing, usage } = body.event.payload;
  return {
    index: call_index,
    replayed: timing?.replayed ?? false,
    first_output_ms: time_to_first_output_ns === null ? null : time_to_first_output_ns / 1e6,
    duration_ms: duration_ns / 1e6,
    input_tokens: usage?.input_tokens ?? 0,
    cached_tokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
  };
}

function publish(ctx: DriveContext, events: LoggedEvent[]): void {
  for (const logged of events) {
    const live = liveEvent(logged);
    if (live) ctx.live(live);
  }
}



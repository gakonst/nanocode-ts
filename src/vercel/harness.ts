import { type DriveContext, EffectFailure, Fatal, type Harness, type HostTool, hostToolIO, Restart, type SessionState, type Submission } from "durable-harness";
import { AgentRuntime, type AgentConfiguration, HostFailure, type LoggedEvent, type ModelProvider, sessionUuid } from "../index.ts";
import { type Dispatch, gatewayDispatch, gatewayEndpoint } from "./gateway.ts";
import { type Durability, type JournalStats, SqlJournal } from "./journal.ts";
import { nanocodeModule } from "./module.ts";

export const SCOPE = "session";

export const SESSION_KEY = "nanocode.session";

export const WAIT_POLL_MS = 250;

export const DEFAULT_EVENT_COALESCE_MS = 50;

export type NanocodeSession = { session_id: string; provider: ModelProvider; model?: string; thinking?: AgentConfiguration["thinking"] };

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
  dispatch?: Dispatch;
  endpoint?: string;
  gateway?: "vercel";
  eventCoalesceMs?: number;
  module?: () => Promise<WebAssembly.Module>;
  report?: (report: DriveReport) => void;
}

const settledKey = (batches: number) => `nanocode.settled:${batches}`;

export function isIdle(state: SessionState, batches: number): boolean {
  return batches === 0 || state.effects.get(settledKey(batches))?.status === "completed";
}

export function nanocodeHarness(options: NanocodeHarnessOptions = {}): Harness {
  const provider = options.provider ?? "claude";
  const tools = new Map((options.tools ?? []).map(tool => [tool.name, tool]));
  const definitions = [...tools.values()].map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema as Record<string, unknown> }));
  const dispatch = options.dispatch ?? gatewayDispatch();
  const endpoint = options.endpoint ?? gatewayEndpoint(provider);
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
          instructions: options.instructions,
          subscription: false,
          endpoint,
          gateway,
          event_coalesce_ms: options.eventCoalesceMs ?? DEFAULT_EVENT_COALESCE_MS,
          tools: definitions,
        }, {
          dispatch: (request, signal) => {
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
      counts.open_ms = performance.now() - opening;
      for (;;) {
        await ctx.refresh();
        for (const submission of ctx.pending()) await place(ctx, journal, runtime, submission);
        const next = (await runtime.pending(SCOPE))[0];
        if (!next) {
          if (await runtime.settle()) return;
          await changed(runtime, ctx.signal);
          continue;
        }
        const driven = await runtime.drive(next.report.request_id);
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
      await runtime.dispose().catch(() => undefined);
    }
  }

  return {
    name: options.name ?? "nanocode",
    modelCalls: "self",
    async drive(ctx) {
      const started = performance.now();
      const journal = new SqlJournal(ctx, durability);
      const replay_ms = performance.now() - started;
      const counts = { model_requests: 0, tool_calls: 0, models: [] as ModelCall[], open_ms: 0 };
      let outcome: DriveReport["outcome"] = "idle";
      let failure: unknown;
      try {
        if (ctx.pending().length === 0 && isIdle(ctx.state(), journal.batches)) return;
        const session = await ctx.effect(SESSION_KEY, { name: SESSION_KEY, replay: "safe", input: { provider, model: options.model, thinking: options.thinking } }, async (): Promise<NanocodeSession> => ({
          session_id: sessionUuid(),
          provider,
          ...(options.model ? { model: options.model } : {}),
          ...(options.thinking ? { thinking: options.thinking } : {}),
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

async function place(ctx: DriveContext, journal: SqlJournal, runtime: AgentRuntime, submission: Submission): Promise<void> {
  const submitted = await runtime.submit(SCOPE, { request_id: submission.id, prompt: submission.text ?? "", metadata: { kind: submission.kind } });
  await journal.durable();
  await ctx.effect(`nanocode.place:${submission.id}`, { name: "nanocode.place", replay: "safe", placed: [submission.id], input: { request_id: submission.id } }, async () => ({ submitted: submitted.submitted }));
  if (submitted.submitted === "too_large") ctx.live({ type: "error", message: `the prompt needs ${submitted.bytes} bytes and the session log stores ${submitted.limit}` });
  else if (submitted.submitted === "conflict") ctx.live({ type: "error", message: `message ${submission.id} was already submitted with another prompt` });
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

type AgentEvent = { type: string; payload: Record<string, unknown> };

type LoggedBody = { source?: string; event?: AgentEvent; type?: string; status?: string; ok?: { message?: string }; error?: unknown };

export function liveEvent(logged: LoggedEvent): Record<string, unknown> | undefined {
  const body = logged.event as LoggedBody;
  const base = { seq: logged.seq, request_id: logged.request_id };
  if (body.source === "agent" && body.event) {
    const { type, payload } = body.event;
    switch (type) {
      case "assistant.delta": return { type: "text", delta: payload.text, ...base };
      case "reasoning.summary.delta": return { type: "reasoning", delta: payload.text, ...base };
      case "tool.call": return { type: "tool_start", name: payload.tool, args: payload.arguments, call_id: payload.call_id, ...base };
      case "tool.result": return { type: "tool_end", name: payload.tool, call_id: payload.call_id, status: payload.status, result: payload.result, ...base };
      default: return undefined;
    }
  }
  if (body.type === "result") return { type: "turn", status: body.status, ...(body.ok?.message !== undefined ? { message: body.ok.message } : {}), ...(body.error !== undefined ? { error: body.error } : {}), ...base };
  if (body.type === "retrying") return { type: "retrying", ...body, ...base };
  return undefined;
}

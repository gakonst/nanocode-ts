import { EffectFailure, Fatal, hostToolIO, Restart } from "durable-harness";
import { AgentRuntime, HostFailure, sessionUuid } from "../index.js";
import { gatewayDispatch, gatewayEndpoint } from "./gateway.js";
import { SqlJournal } from "./journal.js";
import { nanocodeModule } from "./module.js";
export const SCOPE = "session";
export const SESSION_KEY = "nanocode.session";
export const WAIT_POLL_MS = 250;
export const DEFAULT_EVENT_COALESCE_MS = 50;
export const EFFORT_COMMAND = /^\/effort\s+(\S+)\s*$/;
const settledKey = (batches) => `nanocode.settled:${batches}`;
export function isIdle(state, batches) {
    return batches === 0 || state.effects.get(settledKey(batches))?.status === "completed";
}
export function nanocodeHarness(options = {}) {
    const tools = new Map((options.tools ?? []).map(tool => [tool.name, tool]));
    const definitions = [...tools.values()].map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }));
    const dispatch = options.dispatch ?? gatewayDispatch();
    const gateway = options.endpoint ? options.gateway : "vercel";
    const module = options.module ?? nanocodeModule;
    const durability = options.durability ?? "on";
    async function run(ctx, journal, session, counts) {
        const opening = performance.now();
        const runtime = await AgentRuntime.instantiate(await module(), journal, {
            published: events => {
                for (const logged of events) {
                    const call = modelCall(logged);
                    if (call)
                        counts.models.push(call);
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
                    endpoint: options.endpoint ?? gatewayEndpoint(session.provider),
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
            }
            catch (error) {
                if (error instanceof HostFailure && error.permanent)
                    throw new Fatal(`nanocode refused its configuration: ${error.message}`);
                throw error;
            }
            counts.open_ms = performance.now() - opening;
            let applied;
            for (;;) {
                await ctx.refresh();
                const pending = ctx.pending();
                let thinking = pending[0] && effort(ctx.state(), pending[0].id, session.thinking);
                for (const submission of pending)
                    thinking = await place(ctx, journal, runtime, submission, thinking, options.maxPrompts);
                const next = (await runtime.pending(SCOPE))[0];
                if (!next) {
                    if (await runtime.settle())
                        return;
                    await changed(runtime, ctx.signal);
                    continue;
                }
                const wanted = next.metadata?.thinking;
                if (wanted && wanted !== applied) {
                    await runtime.setThinking(wanted);
                    applied = wanted;
                }
                const driving = runtime.drive(next.report.request_id);
                const steering = steer(ctx, journal, runtime, driving, options.maxPrompts);
                const driven = await driving;
                await steering;
                if (ctx.signal.aborted)
                    return;
                if (driven.retry) {
                    if (ctx.attempt === 0)
                        throw new Restart(`nanocode asked to reopen its runtime for ${driven.request_id ?? next.report.request_id}`);
                    throw new Error(`nanocode asked again to reopen its runtime for ${driven.request_id ?? next.report.request_id}`);
                }
                if (driven.waiting)
                    await changed(runtime, ctx.signal);
            }
        }
        catch (error) {
            if (ctx.signal.aborted)
                return;
            throw error;
        }
        finally {
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
            const counts = { model_requests: 0, tool_calls: 0, models: [], open_ms: 0 };
            let outcome = "idle";
            let failure;
            try {
                if (ctx.pending().length === 0 && isIdle(ctx.state(), journal.batches))
                    return;
                const chosen = ctx.config?.nanocode;
                const provider = chosen?.provider ?? options.provider ?? "claude";
                const model = chosen?.provider ? chosen.model : options.model;
                const thinking = chosen?.provider ? chosen.thinking : options.thinking;
                const session = await ctx.effect(SESSION_KEY, { name: SESSION_KEY, replay: "safe", input: { provider, model, thinking } }, async () => ({
                    session_id: sessionUuid(),
                    provider,
                    ...(model ? { model } : {}),
                    ...(thinking ? { thinking } : {}),
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
            }
            catch (error) {
                if (outcome !== "stopped")
                    outcome = "failed";
                failure = error;
                throw error;
            }
            finally {
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
export function effort(state, before, initial) {
    let current = initial;
    for (const submission of state.submissions) {
        if (submission.id === before)
            break;
        const placed = state.effects.get(`nanocode.place:${submission.id}`)?.output;
        if (placed?.thinking)
            current = placed.thinking;
    }
    return current;
}
export function exceeds(state, id, limit) {
    if (limit === undefined)
        return false;
    let index = 0;
    for (const submission of state.submissions) {
        if (submission.id === id)
            return index >= limit;
        if (submission.kind !== "chaos" && submission.kind !== "withdraw")
            index++;
    }
    return false;
}
async function place(ctx, journal, runtime, submission, thinking, limit) {
    if (exceeds(ctx.state(), submission.id, limit)) {
        await ctx.effect(`nanocode.place:${submission.id}`, { name: "nanocode.refused", replay: "safe", placed: [submission.id], input: { request_id: submission.id } }, async () => ({ refused: "limit" }));
        ctx.live({ type: "error", message: `this session takes at most ${limit} prompts; start a new session`, request_id: submission.id });
        return thinking;
    }
    const command = submission.kind === "prompt" ? EFFORT_COMMAND.exec(submission.text ?? "") : null;
    if (command) {
        const level = command[1];
        const outcome = await ctx.effect(`nanocode.place:${submission.id}`, { name: "nanocode.effort", replay: "safe", placed: [submission.id], input: { thinking: level } }, () => runtime.checkThinking(level).then(() => ({ thinking: level }), (error) => ({ error: error instanceof Error ? error.message : String(error) })));
        ctx.live(outcome.thinking ? { type: "effort", thinking: outcome.thinking, request_id: submission.id } : { type: "error", message: outcome.error, request_id: submission.id });
        return outcome.thinking ?? thinking;
    }
    const submitted = await runtime.submit(SCOPE, { request_id: submission.id, prompt: submission.text ?? "", metadata: { kind: submission.kind, ...(thinking ? { thinking } : {}) } });
    await journal.durable();
    await ctx.effect(`nanocode.place:${submission.id}`, { name: "nanocode.place", replay: "safe", placed: [submission.id], input: { request_id: submission.id } }, async () => ({ submitted: submitted.submitted }));
    if (submitted.submitted === "too_large")
        ctx.live({ type: "error", message: `the prompt needs ${submitted.bytes} bytes and the session log stores ${submitted.limit}` });
    else if (submitted.submitted === "conflict")
        ctx.live({ type: "error", message: `message ${submission.id} was already submitted with another prompt` });
    return thinking;
}
async function steer(ctx, journal, runtime, driving, limit) {
    let done = false;
    const finished = driving.then(() => { done = true; }, () => { done = true; });
    for (;;) {
        await Promise.race([finished, submitted(ctx)]);
        if (done || ctx.signal.aborted)
            return;
        await ctx.refresh();
        for (const submission of ctx.pending()) {
            if (submission.kind !== "steer" || exceeds(ctx.state(), submission.id, limit) || !await runtime.steer(submission.id, submission.text ?? ""))
                continue;
            await journal.durable();
            await ctx.effect(`nanocode.place:${submission.id}`, { name: "nanocode.steer", replay: "safe", placed: [submission.id], input: { request_id: submission.id } }, async () => ({ steered: true }));
            ctx.live({ type: "steered", request_id: submission.id });
        }
    }
}
function submitted(ctx) {
    return new Promise(resolve => {
        let unsubscribe;
        const timer = ctx.onHint ? undefined : setTimeout(done, WAIT_POLL_MS);
        unsubscribe = ctx.onHint?.(hint => {
            if (hint.eventType === "hook_received")
                done();
        });
        function done() {
            clearTimeout(timer);
            unsubscribe?.();
            resolve();
        }
    });
}
async function callTool(ctx, journal, tools, name, input, signal, callId) {
    const tool = tools.get(name);
    if (!tool)
        throw new Error(`no host tool is named ${name}`);
    try {
        await journal.durable();
        return await ctx.effect(`tool:${callId}`, { name: `tool.${name}`, replay: tool.replay, input }, io => tool.execute(input, hostToolIO(io, ctx, { signal: AbortSignal.any([signal, io.signal]) })));
    }
    catch (error) {
        if (error instanceof EffectFailure)
            throw new Error(error.error.interrupted ? `${name} was interrupted before it reported a result, so it may have run` : error.message);
        ctx.halt?.(error);
        throw error;
    }
}
function changed(runtime, signal) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, WAIT_POLL_MS);
        void runtime.changed(signal).then(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}
function modelCall(logged) {
    const body = logged.event;
    if (body.source !== "agent" || body.event?.type !== "model.call.completed")
        return undefined;
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
function publish(ctx, events) {
    for (const logged of events) {
        const live = liveEvent(logged);
        if (live)
            ctx.live(live);
    }
}
export function liveEvent(logged) {
    const body = logged.event;
    const base = { seq: logged.seq, request_id: logged.request_id };
    if (body.source === "agent" && body.event) {
        const { type, payload } = body.event;
        switch (type) {
            case "assistant.delta": return { type: "text", delta: payload.text, item: payload.item_id, ...base };
            case "reasoning.summary.delta": return { type: "reasoning", delta: payload.text, item: `reasoning:${payload.model_call_index}`, ...base };
            case "tool.call": return { type: "tool_start", name: payload.tool, args: payload.arguments, call_id: payload.call_id, ...base };
            case "tool.result": return { type: "tool_end", name: payload.tool, call_id: payload.call_id, status: payload.status, result: payload.result, ...base };
            default: return undefined;
        }
    }
    if (body.type === "result")
        return { type: "turn", status: body.status, ...(body.ok?.message !== undefined ? { message: body.ok.message } : {}), ...(body.error !== undefined ? { error: body.error } : {}), ...base };
    if (body.type === "retrying")
        return { type: "retrying", ...body, ...base };
    return undefined;
}

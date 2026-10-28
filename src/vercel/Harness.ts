/**
 * durable-harness kernel `Harness` that runs a nanocode session on a Workflow run, with its SQL in the run's log.
 *
 * @module
 */
import {
  type DriveContext,
  EffectFailure,
  Fatal,
  type Harness,
  type HostTool,
  hostToolIO,
  Restart,
  type SessionState,
  type Submission,
} from 'durable-harness'
import * as LiveEvent from '../client/LiveEvent.ts'
import * as Contracts from '../Contracts.ts'
import * as AgentRuntime from '../AgentRuntime.ts'
import * as Remote from '../Remote.ts'
import * as Gateway from './Gateway.ts'
import * as Journal from './Journal.ts'
import * as Thread from '../internal/Thread.ts'
import * as Wasm from './Wasm.ts'
import * as Bash from '../bash/Bash.ts'
import type * as FileSystem from '../bash/FileSystem.ts'
import * as GitHub from '../bash/GitHub.ts'
import * as SqlFileSystem from '../bash/SqlFileSystem.ts'
import * as Files from '../internal/Files.ts'
// Aliased, since `Hands` names the hand options of this module.
import * as HandStreams from './Hands.ts'
import * as Attachments from './internal/Attachments.ts'
import * as Egress from './internal/Egress.ts'

/** Submission text that cancels the active turn. The value is durable. */
export const cancelText = '\u0000nanocode:cancel'

/** Default time in milliseconds over which the runtime coalesces streamed events. */
export const defaultEventCoalesceMs = 50

/** Prompt that sets the reasoning effort of later turns, such as `/effort high`. */
export const effortCommand = /^\/effort\s+(\S+)\s*$/

/** Pattern of a session's hand channel. */
export const handChannel = /^[A-Za-z0-9_-]{16,64}$/

/** SQL scope of every session's runtime. The value is durable. */
export const scope = 'session'

/** Effect key and step name of the session record. The value is durable. */
export const sessionKey = 'nanocode.session'

/** Time in milliseconds between two polls when the drive has no live hints. */
export const waitPollMs = 250

const streamedWasmCalls = 20

/** Report of one drive, which `create.Options.report` receives. */
export type DriveReport = {
  /** Run of the session. */
  run_id: string
  /** Delivery attempt of the drive, from 0. */
  attempt: number
  durability: Journal.Durability
  /** Whether the drive opened the runtime. */
  opened: boolean
  /** Duration of the drive in milliseconds. */
  duration_ms: number
  /** Time in milliseconds to replay the journal. */
  replay_ms: number
  /** Time in milliseconds to open the runtime. */
  open_ms: number
  journal: Journal.Stats
  /** Model requests that the drive sent. */
  model_requests: number
  /** Host tool calls that the drive ran. */
  tool_calls: number
  /** Completed model calls, in order. */
  models: ModelCall[]
  /** How the drive ended. */
  outcome: 'idle' | 'settled' | 'stopped' | 'failed'
  /** Name and message of the failure, when the drive failed or stopped. */
  error?: string
}

/** Hands that a session connects to. */
export type Hands = {
  /** Time in milliseconds that a hand's event stream stays open. */
  holdMs?: number
  /** Largest frame in bytes. Defaults to 1 MiB. */
  maxFrameBytes?: number
  /** Name of the hand in the session. Defaults to `browser`. */
  name?: string
  /** Returns the URL of an external hand relay for a channel, instead of Workflow streams. */
  relay?(channel: string): string
  /** Time in milliseconds to wait for the hand's catalog. Defaults to 30 seconds. */
  timeoutMs?: number
  /** Upgrades a request to a hand's WebSocket on the Function. */
  upgrade?: HandStreams.UpgradeWebSocket
}

/** Completed model call of a drive. */
export type ModelCall = {
  /** Call index in the session. */
  index: number
  /** Whether the call replayed from the log. */
  replayed: boolean
  /** Time in milliseconds to the first output, or `null` without output. */
  first_output_ms: number | null
  /** Duration of the call in milliseconds. */
  duration_ms: number
  input_tokens: number
  cached_tokens: number
  output_tokens: number
}

export type ServiceTier = Contracts.ServiceTier

/** Model selection of a session, recorded once under `sessionKey`. */
export type Session = {
  /** SDK session ID. */
  session_id: string
  provider: Contracts.ModelProvider
  model?: string
  thinking?: Contracts.Thinking
  max_tokens?: number
  service_tier?: Contracts.ServiceTier
}

export type Thinking = Contracts.Thinking

function openSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const fail = (reason: string) => {
      try {
        socket.close()
      } catch {}
      reject(new Error(reason))
    }
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', () => fail('the hand relay refused the connection'), {
      once: true,
    })
    signal.addEventListener('abort', () => fail('the hand relay did not answer in time'), {
      once: true,
    })
  })
}

// The `nanocode.settled:` key is durable.
const settledKey = (batches: number) => `nanocode.settled:${batches}`

/** Returns a durable-harness kernel `Harness` that drives nanocode sessions. */
export function create(options: create.Options = {}): Harness {
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]))
  const definitions = [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as Record<string, unknown>,
  }))
  const dispatch = options.dispatch ?? Gateway.dispatch()
  const gateway = options.endpoint ? options.gateway : 'vercel'
  const module = options.module ?? Wasm.load
  const durability = options.durability ?? 'on'
  const engine = Thread.engine()

  async function run(
    ctx: DriveContext,
    journal: Journal.Journal,
    session: Session,
    counts: { model_requests: number; tool_calls: number; models: ModelCall[]; open_ms: number },
  ): Promise<void> {
    const opening = performance.now()
    const publish = publisher(ctx)
    const runtime = await AgentRuntime.instantiate(await module(), journal, {
      ...(engine ? { engine } : {}),
      published: (events) => {
        for (const logged of events) {
          const call = modelCall(logged)
          if (!call) continue
          counts.models.push(call)
          ctx.live({ type: 'usage', ...call } as never)
        }
        publish(events)
      },
    })
    const channel = (ctx.config as { hand?: unknown } | undefined)?.hand
    const hands = options.hands || undefined
    const executor =
      hands && typeof channel === 'string' && handChannel.test(channel)
        ? await Remote.connect(
            (signal) =>
              hands.relay
                ? openSocket(hands.relay(channel), signal)
                : HandStreams.dial(ctx.world, { resumes: true, runId: ctx.runId, signal }),
            {
              max_frame_bytes: hands.maxFrameBytes ?? 1_048_576,
              timeout_ms: hands.timeoutMs ?? 30_000,
              ...(hands.relay ? {} : { resumes: true }),
            },
          ).catch(() => undefined)
        : undefined
    const handName = hands?.name ?? 'browser'
    const connection = executor ? handName + '#' + Contracts.sessionUuid() : undefined
    const configuredFetch = options.sessionFetch?.(ctx.runId) ?? options.fetch
    const githubToken = options.github?.token
    const cellFetch = GitHub.wrap(Egress.guard(configuredFetch), {
      token: githubToken ? () => githubToken(ctx.runId) : undefined,
    })
    const files =
      options.workspace === false || executor ? undefined : SqlFileSystem.create(journal, { scope })
    const shell =
      !files || options.workspace === false
        ? undefined
        : await Bash.create({
            fs: files,
            cwd: options.workspace?.cwd ?? '/workspace',
            python: { mirror: ctx.runId },
            ...(options.workspace?.files ? { files: options.workspace.files } : {}),
            ...(configuredFetch ? { fetch: cellFetch } : {}),
          })
    const mcpServers = options.mcp?.servers ?? []
    const mcpFetch =
      options.mcp?.fetch?.(ctx.runId) ??
      ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
    const stop = () => void runtime.dispose().catch(() => undefined)
    ctx.signal.addEventListener('abort', stop, { once: true })
    try {
      try {
        await runtime.open(
          {
            scope,
            session_id: session.session_id,
            provider: session.provider,
            model: session.model,
            thinking: session.thinking,
            max_tokens: session.max_tokens,
            service_tier: session.service_tier,
            subagents: options.subagents,
            instructions:
              executor && options.handInstructions
                ? [options.instructions, options.handInstructions].filter(Boolean).join('\n\n')
                : options.instructions,
            subscription: false,
            endpoint: options.endpoint ?? Gateway.endpoint(session.provider),
            gateway,
            event_coalesce_ms: options.eventCoalesceMs ?? defaultEventCoalesceMs,
            stream_tool_input: options.streamToolInput,
            code_mode: executor ? false : options.codeMode,
            ...(executor ? { hands: true } : {}),
            tools: definitions,
            ...(options.webSearch === false ? { web_search: false } : {}),
            ...(mcpServers.length ? { mcp_servers: mcpServers } : {}),
            ...(shell ? { workspace: shell.cwd } : {}),
            ...(shell && options.workspaceTools ? { workspace_tools: options.workspaceTools } : {}),
          },
          {
            ...(shell ? { workspace: shell.workspace() } : {}),
            fetch: cellFetch,
            ...(executor
              ? {
                  remote: {
                    failed: () => executor.failure !== undefined,
                    execute: async (request: { op: string; durable?: boolean }, id: number) => {
                      if (request.op === 'remote_send' && request.durable !== false)
                        await journal.durable()
                      return executor.execute(request as Parameters<typeof executor.execute>[0], id)
                    },
                    cancel: (id: number) => executor.cancel(id),
                    dispose: () => executor.dispose(),
                  },
                }
              : {}),
            dispatch: (request, signal) => {
              if (request.provider == null && mcpServers.length)
                return mcpFetch(request.endpoint, {
                  method: request.method,
                  headers: request.headers,
                  body:
                    request.method === 'GET' || request.method === 'HEAD'
                      ? undefined
                      : (request.body as Uint8Array<ArrayBuffer>),
                  signal,
                })
              counts.model_requests++
              return dispatch(request, signal)
            },
            tools: {
              call: (name, input, signal, { call_id }) => {
                counts.tool_calls++
                return callTool(ctx, journal, tools, name, input, signal, call_id)
              },
            },
          },
        )
      } catch (error) {
        if (error instanceof Contracts.HostFailureError && error.permanent)
          throw new Fatal(`nanocode refused its configuration: ${error.message}`)
        throw error
      }
      if (executor && connection) {
        executor.claim(runtime)
        await runtime.attach(handName, connection)
      }
      counts.open_ms = performance.now() - opening
      let applied: Contracts.Thinking | undefined
      for (;;) {
        await ctx.refresh()
        const pending = ctx.pending()
        let thinking =
          pending[0] && effort(ctx.state(), { before: pending[0].id, initial: session.thinking })
        for (const submission of pending)
          thinking = await place(
            ctx,
            journal,
            runtime,
            submission,
            thinking,
            options.maxPrompts,
            executor ? handName : undefined,
            files,
            options.promptImages?.(session) ?? true,
          )
        const next = (await runtime.pending(scope))[0]
        if (!next) {
          if (await runtime.settle()) return
          await changed(runtime, ctx.signal)
          continue
        }
        const wanted = (next.metadata as { thinking?: Contracts.Thinking } | null)?.thinking
        if (wanted && wanted !== applied) {
          await runtime.setThinking(wanted)
          applied = wanted
        }
        const driving = runtime.drive(next.report.request_id)
        const steering = steer(
          ctx,
          journal,
          runtime,
          driving,
          next.report.request_id,
          options.maxPrompts,
        )
        const driven = await driving
        await steering
        if (ctx.signal.aborted) return
        if (driven.retry) {
          if (ctx.attempt === 0)
            throw new Restart(
              `nanocode asked to reopen its runtime for ${driven.request_id ?? next.report.request_id}`,
            )
          throw new Error(
            `nanocode asked again to reopen its runtime for ${driven.request_id ?? next.report.request_id}`,
          )
        }
        if (driven.waiting) await changed(runtime, ctx.signal)
      }
    } catch (error) {
      if (ctx.signal.aborted) return
      throw error
    } finally {
      ctx.signal.removeEventListener('abort', stop)
      await executor?.dispose().catch(() => undefined)
      await runtime.dispose().catch(() => undefined)
    }
  }

  return {
    name: options.name ?? 'nanocode',
    modelCalls: 'self',
    async drive(ctx) {
      const started = performance.now()
      const journal = Journal.create(ctx, { batchMs: options.batchMs, durability })
      const replay_ms = performance.now() - started
      const counts = { model_requests: 0, tool_calls: 0, models: [] as ModelCall[], open_ms: 0 }
      let outcome: DriveReport['outcome'] = 'idle'
      let failure: unknown
      try {
        if (ctx.pending().length === 0 && isIdle(ctx.state(), { batches: journal.batches })) return
        const chosen = (
          ctx.config as
            | {
                nanocode?: {
                  provider?: Contracts.ModelProvider
                  model?: string
                  thinking?: Contracts.Thinking
                  max_tokens?: number
                  service_tier?: Contracts.ServiceTier
                }
              }
            | undefined
        )?.nanocode
        const provider = chosen?.provider ?? options.provider ?? 'claude'
        const model = chosen?.provider ? chosen.model : options.model
        const thinking = chosen?.provider ? chosen.thinking : options.thinking
        const max_tokens = chosen?.provider ? chosen.max_tokens : undefined
        const service_tier = chosen?.provider ? chosen.service_tier : undefined
        const session = await ctx.effect(
          sessionKey,
          {
            name: sessionKey,
            replay: 'safe',
            input: {
              provider,
              model,
              thinking,
              ...(max_tokens ? { max_tokens } : {}),
              ...(service_tier ? { service_tier } : {}),
            },
          },
          async (): Promise<Session> => ({
            session_id: Contracts.sessionUuid(),
            provider,
            ...(model ? { model } : {}),
            ...(thinking ? { thinking } : {}),
            ...(max_tokens ? { max_tokens } : {}),
            ...(service_tier ? { service_tier } : {}),
          }),
        )
        await run(ctx, journal, session, counts)
        if (ctx.signal.aborted) {
          outcome = 'stopped'
          throw ctx.signal.reason
        }
        await journal.durable()
        await ctx.effect(
          settledKey(journal.batches),
          { name: 'nanocode.settled', replay: 'safe', input: { batches: journal.batches } },
          async () => ({}),
        )
        ctx.live({ type: 'idle' })
        outcome = 'settled'
      } catch (error) {
        if (outcome !== 'stopped') outcome = 'failed'
        failure = error
        throw error
      } finally {
        journal.close()
        options.report?.({
          run_id: ctx.runId,
          attempt: ctx.attempt,
          durability,
          opened: outcome !== 'idle',
          duration_ms: performance.now() - started,
          replay_ms,
          journal: journal.stats,
          ...counts,
          outcome,
          ...(failure !== undefined
            ? {
                error:
                  failure instanceof Error
                    ? `${failure.name}: ${failure.message}`
                    : String(failure),
              }
            : {}),
        })
      }
    },
  }
}

export declare namespace create {
  type Options = {
    /** Minimum time in milliseconds between two SQL batches with `on` durability. */
    batchMs?: number
    /** Whether the runtime runs agent code in Code Mode cells. */
    codeMode?: boolean
    /** Sends model requests. Defaults to `Gateway.dispatch()`. */
    dispatch?: Gateway.Dispatch
    /** Defaults to `on`. */
    durability?: Journal.Durability
    /** Model endpoint. Defaults to the AI Gateway endpoint of the session's provider. */
    endpoint?: string
    /** Time in milliseconds over which the runtime coalesces streamed events. Defaults to `defaultEventCoalesceMs`. */
    eventCoalesceMs?: number
    /** `fetch` of agent code, behind the public-address guard. */
    fetch?: typeof fetch
    /** Gateway of a custom `endpoint`. With no `endpoint`, the gateway is `vercel`. */
    gateway?: 'vercel'
    github?: {
      /** Returns the GitHub token that agent requests to GitHub carry. */
      token?(sessionId: string): string | null | undefined | Promise<string | null | undefined>
    }
    /** Instructions added when a hand is attached. */
    handInstructions?: string
    /** Hands of the session, or `false` for none. */
    hands?: false | Hands
    /** Host instructions of the session. */
    instructions?: string
    /** Largest number of prompts in a session. */
    maxPrompts?: number
    mcp?: {
      /** Returns the `fetch` for MCP requests of a session. */
      fetch?(sessionId: string): typeof fetch
      /** MCP servers of every session. */
      servers: Contracts.McpServer[]
    }
    /** Default model, when the session config names none. */
    model?: string
    /** Loads the WebAssembly module. Defaults to `Wasm.load`. */
    module?: () => Promise<WebAssembly.Module>
    /** Harness name. Defaults to `nanocode`. */
    name?: string
    /** Whether a session's prompts carry images. Defaults to `true`. */
    promptImages?: (session: Session) => boolean
    /** Default provider, when the session config names none. Defaults to `claude`. */
    provider?: Contracts.ModelProvider
    /** Receives the report of each drive. */
    report?: (report: DriveReport) => void
    /** Returns the `fetch` of agent code for one session, instead of `fetch`. */
    sessionFetch?(sessionId: string): typeof fetch
    /** Whether the runtime streams tool input. */
    streamToolInput?: boolean
    /** Whether the agent starts subagents. */
    subagents?: boolean
    /** Default reasoning effort, when the session config names none. */
    thinking?: Contracts.AgentConfiguration['thinking']
    /** Host tools, run as durable effects. */
    tools?: HostTool[]
    /** `false` for no workspace, or the workspace's directory and seed files. */
    workspace?: false | { cwd?: string; files?: Record<string, string> }
    /** Workspace tools of the provider. */
    workspaceTools?: Contracts.AgentConfiguration['workspace_tools']
    /** `false` turns web search off. */
    webSearch?: false
  }
}

/** Returns the reasoning effort in force before submission `before`, after the `/effort` commands placed earlier. */
export function effort(
  state: SessionState,
  options: effort.Options,
): Contracts.Thinking | undefined {
  let current = options.initial
  for (const submission of state.submissions) {
    if (submission.id === options.before) break
    const placed = state.effects.get(`nanocode.place:${submission.id}`)?.output as
      | { thinking?: Contracts.Thinking }
      | undefined
    if (placed?.thinking) current = placed.thinking
  }
  return current
}

export declare namespace effort {
  type Options = {
    /** Submission ID. */
    before: string
    /** Effort of the session. */
    initial: Contracts.Thinking | undefined
  }
}

/** Returns whether submission `id` is past the prompt limit. Cancels, chaos, and withdrawals do not count. */
export function exceeds(state: SessionState, options: exceeds.Options): boolean {
  const { id, limit } = options
  if (limit === undefined) return false
  let index = 0
  for (const submission of state.submissions) {
    if (submission.id === id) return index >= limit
    if (submission.kind !== 'chaos' && submission.kind !== 'withdraw' && !cancels(submission))
      index++
  }
  return false
}

export declare namespace exceeds {
  type Options = {
    /** Submission ID. */
    id: string
    /** Largest number of prompts, or `undefined` for no limit. */
    limit: number | undefined
  }
}

/** Returns whether a session is idle: it has no SQL batches, or it settled after its last batch. */
export function isIdle(state: SessionState, options: isIdle.Options): boolean {
  const { batches } = options
  return batches === 0 || state.effects.get(settledKey(batches))?.status === 'completed'
}

export declare namespace isIdle {
  type Options = {
    /** Committed SQL batches of the session. */
    batches: number
  }
}

async function place(
  ctx: DriveContext,
  journal: Journal.Journal,
  runtime: AgentRuntime.AgentRuntime,
  submission: Submission,
  thinking: Contracts.Thinking | undefined,
  limit: number | undefined,
  hand?: string,
  workspace?: FileSystem.FileSystem,
  seesImages = true,
): Promise<Contracts.Thinking | undefined> {
  if (cancels(submission)) {
    await cancelTurn(
      ctx,
      journal,
      runtime,
      submission,
      (await runtime.pending(scope))[0]?.report.request_id,
    )
    return thinking
  }
  if (exceeds(ctx.state(), { id: submission.id, limit })) {
    await ctx.effect(
      `nanocode.place:${submission.id}`,
      {
        name: 'nanocode.refused',
        replay: 'safe',
        placed: [submission.id],
        input: { request_id: submission.id },
      },
      async () => ({ refused: 'limit' }),
    )
    ctx.live({
      type: 'error',
      message: `this session takes at most ${limit} prompts; start a new session`,
      request_id: submission.id,
    })
    return thinking
  }
  const command = submission.kind === 'prompt' ? effortCommand.exec(submission.text ?? '') : null
  if (command) {
    const level = command[1] as Contracts.Thinking
    const outcome = (await ctx.effect(
      `nanocode.place:${submission.id}`,
      {
        name: 'nanocode.effort',
        replay: 'safe',
        placed: [submission.id],
        input: { thinking: level },
      },
      () =>
        runtime.checkThinking(level).then(
          () => ({ thinking: level }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        ),
    )) as { thinking?: Contracts.Thinking; error?: string }
    ctx.live(
      outcome.thinking
        ? { type: 'effort', thinking: outcome.thinking, request_id: submission.id }
        : { type: 'error', message: outcome.error, request_id: submission.id },
    )
    return outcome.thinking ?? thinking
  }
  const attached = Attachments.parse(submission.text ?? '')
  const images: string[] = []
  for (const file of attached.files) {
    if (workspace) await Files.write(workspace, file.path, file.bytes)
    const type = Files.sniff(file.bytes)
    if (seesImages && Files.promptImageTypes.has(type) && images.length < Files.maxPromptImages)
      images.push(Files.dataUrl(file.bytes, type))
  }
  const submitted = await runtime.submit(scope, {
    request_id: submission.id,
    prompt: attached.text,
    ...(images.length ? { images } : {}),
    ...(hand ? { hand } : {}),
    metadata: { kind: submission.kind, ...(thinking ? { thinking } : {}) },
  })
  await journal.durable()
  await ctx.effect(
    `nanocode.place:${submission.id}`,
    {
      name: 'nanocode.place',
      replay: 'safe',
      placed: [submission.id],
      input: { request_id: submission.id },
    },
    async () => ({ submitted: submitted.submitted }),
  )
  if (submitted.submitted === 'too_large')
    ctx.live({
      type: 'error',
      message: `the prompt needs ${submitted.bytes} bytes and the session log stores ${submitted.limit}`,
    })
  else if (submitted.submitted === 'conflict')
    ctx.live({
      type: 'error',
      message: `message ${submission.id} was already submitted with another prompt`,
    })
  return thinking
}

async function steer(
  ctx: DriveContext,
  journal: Journal.Journal,
  runtime: AgentRuntime.AgentRuntime,
  driving: Promise<unknown>,
  active: string,
  limit: number | undefined,
): Promise<void> {
  let done = false
  const finished = driving.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  for (;;) {
    await Promise.race([finished, submitted(ctx)])
    if (done || ctx.signal.aborted) return
    await ctx.refresh()
    for (const submission of ctx.pending()) {
      if (cancels(submission)) {
        await cancelTurn(ctx, journal, runtime, submission, active)
        continue
      }
      if (
        submission.kind !== 'steer' ||
        exceeds(ctx.state(), { id: submission.id, limit }) ||
        !(await runtime.steer(submission.id, Attachments.parse(submission.text ?? '').text))
      )
        continue
      await journal.durable()
      await ctx.effect(
        `nanocode.place:${submission.id}`,
        {
          name: 'nanocode.steer',
          replay: 'safe',
          placed: [submission.id],
          input: { request_id: submission.id },
        },
        async () => ({ steered: true }),
      )
      ctx.live({ type: 'steered', request_id: submission.id })
    }
  }
}

async function cancelTurn(
  ctx: DriveContext,
  journal: Journal.Journal,
  runtime: AgentRuntime.AgentRuntime,
  submission: Submission,
  active: string | undefined,
): Promise<void> {
  const turn = active
    ? (await runtime.cancel(scope, active, { cancelled: true, error: 'request cancelled' })).turn
    : null
  await journal.durable()
  await ctx.effect(
    `nanocode.place:${submission.id}`,
    {
      name: 'nanocode.cancel',
      replay: 'safe',
      placed: [submission.id],
      input: { request_id: active ?? null },
    },
    async () => ({ cancelled: turn?.report.status ?? null }),
  )
}

function submitted(ctx: DriveContext): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    const timer = ctx.onHint ? undefined : setTimeout(done, waitPollMs)
    unsubscribe = ctx.onHint?.((hint) => {
      if (hint.eventType === 'hook_received') done()
    })
    function done() {
      clearTimeout(timer)
      unsubscribe?.()
      resolve()
    }
  })
}

async function callTool(
  ctx: DriveContext,
  journal: Journal.Journal,
  tools: Map<string, HostTool>,
  name: string,
  input: unknown,
  signal: AbortSignal,
  callId: string,
): Promise<unknown> {
  const tool = tools.get(name)
  if (!tool) throw new Error(`no host tool is named ${name}`)
  try {
    await journal.durable()
    return await ctx.effect(
      `tool:${callId}`,
      { name: `tool.${name}`, replay: tool.replay, input },
      (io) =>
        tool.execute(input, hostToolIO(io, ctx, { signal: AbortSignal.any([signal, io.signal]) })),
    )
  } catch (error) {
    if (error instanceof EffectFailure)
      throw new Error(
        error.error.interrupted
          ? `${name} was interrupted before it reported a result, so it may have run`
          : error.message,
      )
    ctx.halt?.(error)
    throw error
  }
}

function changed(runtime: AgentRuntime.AgentRuntime, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, waitPollMs)
    void runtime.changed(signal).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function modelCall(logged: Contracts.LoggedEvent): ModelCall | undefined {
  const body = logged.event as {
    source?: string
    event?: {
      type: string
      payload: {
        call_index: number
        duration_ns: number
        time_to_first_output_ns: number | null
        timing?: { replayed?: boolean }
        usage?: {
          input_tokens?: number
          input_tokens_details?: { cached_tokens?: number }
          output_tokens?: number
        }
      }
    }
  }
  if (body.source !== 'agent' || body.event?.type !== 'model.call.completed') return undefined
  const { call_index, duration_ns, time_to_first_output_ns, timing, usage } = body.event.payload
  return {
    index: call_index,
    replayed: timing?.replayed ?? false,
    first_output_ms: time_to_first_output_ns === null ? null : time_to_first_output_ns / 1e6,
    duration_ms: duration_ns / 1e6,
    input_tokens: usage?.input_tokens ?? 0,
    cached_tokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
  }
}

function cancels(submission: Submission): boolean {
  return submission.kind === 'steer' && submission.text === cancelText
}

function publisher(ctx: DriveContext): (events: Contracts.LoggedEvent[]) => void {
  const calls = new Map<string, number>()
  const quiet = new Set<string>()
  return (events) => {
    for (const logged of events) {
      if (
        (logged.event as { event?: { type?: unknown } } | undefined)?.event?.type ===
        'assistant.message'
      )
        continue
      const live = LiveEvent.fromLogged(logged) as
        | (Record<string, unknown> & { type: string })
        | undefined
      if (!live) continue
      const parent = typeof live['parent'] === 'string' ? live['parent'] : undefined
      const id = typeof live['call_id'] === 'string' ? live['call_id'] : undefined
      if (
        live.type === 'tool_start' &&
        parent &&
        id &&
        live['name'] === 'wasm' &&
        (live['args'] as { op?: unknown } | undefined)?.op === 'call'
      ) {
        const count = (calls.get(parent) ?? 0) + 1
        calls.set(parent, count)
        if (count > streamedWasmCalls) {
          quiet.add(id)
          continue
        }
      }
      if (
        (live.type === 'tool_end' || live.type === 'tool_input' || live.type === 'tool_output') &&
        id &&
        quiet.has(id)
      ) {
        if (live.type === 'tool_end') quiet.delete(id)
        continue
      }
      if (live.type === 'tool_end' && id && calls.has(id)) {
        const skipped = (calls.get(id) ?? 0) - streamedWasmCalls
        calls.delete(id)
        if (skipped > 0)
          ctx.live({
            type: 'tool_output',
            call_id: id,
            text: skipped + ' more wasm calls in this cell were not streamed',
          } as never)
      }
      ctx.live(live as never)
    }
  }
}

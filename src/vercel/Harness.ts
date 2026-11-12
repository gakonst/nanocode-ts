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
import * as Wasm from './Wasm.ts'
import * as Bash from '../bash/Bash.ts'
import type * as FileSystem from '../bash/FileSystem.ts'
import * as GitHub from '../bash/GitHub.ts'
import * as Sources from '../bash/Sources.ts'
import * as SqlFileSystem from '../bash/SqlFileSystem.ts'
import * as Files from '../internal/Files.ts'
import * as HandStreams from './Hands.ts'
import * as Attachments from './internal/Attachments.ts'
import * as Egress from './internal/Egress.ts'

export const cancelText = '\u0000nanocode:cancel'

export const defaultEventCoalesceMs = 50

export const effortCommand = /^\/effort\s+(\S+)\s*$/

export const handChannel = /^[A-Za-z0-9_-]{16,64}$/

export const scope = 'session'

export const sessionKey = 'nanocode.session'

export const subagentText = '\u0000nanocode:subagent '

export const waitPollMs = 250

const streamedWasmCalls = 20

export type DriveReport = {
  run_id: string
  attempt: number
  durability: Journal.Durability
  opened: boolean
  duration_ms: number
  replay_ms: number
  open_ms: number
  journal: Journal.Stats
  model_requests: number
  tool_calls: number
  models: ModelCall[]
  outcome: 'idle' | 'settled' | 'stopped' | 'failed'
  error?: string
}

export type Hands = {
  holdMs?: number
  maxFrameBytes?: number
  name?: string
  relay?(channel: string): string
  timeoutMs?: number
  upgrade?: HandStreams.UpgradeWebSocket
}

export type ModelCall = {
  index: number
  replayed: boolean
  first_output_ms: number | null
  duration_ms: number
  input_tokens: number
  cached_tokens: number
  output_tokens: number
}

export type ServiceTier = Contracts.ServiceTier

export type SubagentCommand =
  | { action: 'close' | 'interrupt'; agent_id: number }
  | {
      action: 'send_user_message'
      agent_id: number
      message: string
      priority?: Contracts.MessagePriority | undefined
    }
  | { action: 'side_question'; agent_id: number; question: string }

export type SubagentOutcome = { error: string } | { ok: unknown }

export type Session = {
  session_id: string
  provider: Contracts.ModelProvider
  model?: string
  thinking?: Contracts.Thinking
  max_tokens?: number
  service_tier?: Contracts.ServiceTier
  payer?: Contracts.Payer
}

export type Thinking = Contracts.Thinking

export type Subscription = {
  dispatch: Gateway.Dispatch
  socket?: NonNullable<Contracts.RuntimeOptions['socket']> | undefined
}

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

const settledKey = (batches: number) => `nanocode.settled:${batches}`

const ulid = /^wrun_([0-9A-HJKMNP-TV-Z]{26})$/

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function runSessionUuid(runId: string): string | undefined {
  const match = ulid.exec(runId)
  if (!match) return undefined
  let value = 0n
  for (const char of match[1]!) value = (value << 5n) | BigInt(crockford.indexOf(char))
  const bytes = new Uint8Array(16)
  for (let index = 15; index >= 0; index--) {
    bytes[index] = Number(value & 255n)
    value >>= 8n
  }
  bytes[6] = (bytes[6]! & 15) | 112
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

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

  async function run(
    ctx: DriveContext,
    journal: Journal.Journal,
    session: Session,
    counts: { model_requests: number; tool_calls: number; models: ModelCall[]; open_ms: number },
  ): Promise<void> {
    const opening = performance.now()
    const publish = publisher(ctx)
    const runtime = await AgentRuntime.instantiate(await module(), journal, {
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
    const account = (ctx.config as { account?: unknown } | undefined)?.account
    const plan =
      session.payer !== 'deployment' &&
      session.payer !== 'wallet' &&
      typeof account === 'string' &&
      options.subscription
        ? await options.subscription({
            account,
            provider: session.provider,
            ...(session.model ? { model: session.model } : {}),
          })
        : undefined
    if (session.payer === 'plan' && !plan)
      throw new Error(
        `the ${session.provider === 'codex' ? 'ChatGPT' : 'Claude'} plan that pays for this session is signed out; sign in again or start a new session`,
      )
    const wallet = session.payer === 'wallet' ? options.wallet?.(ctx.runId) : undefined
    if (session.payer === 'wallet' && !wallet)
      throw new Error('this deployment has no Tempo Wallet to pay for models')
    const configuredFetch = options.sessionFetch?.(ctx.runId) ?? options.fetch
    const githubToken = options.github?.token
    const cellFetch = GitHub.wrap(Egress.guard(configuredFetch), {
      token: githubToken ? () => githubToken(ctx.runId) : undefined,
    })
    const files =
      options.workspace === false
        ? undefined
        : SqlFileSystem.create(journal, {
            scope,
            sources: Sources.create({
              fetch: Egress.guard(),
              ...(githubToken ? { token: () => githubToken(ctx.runId) } : {}),
            }),
          })
    const shell =
      !files || options.workspace === false
        ? undefined
        : await Bash.create({
            fs: files,
            cwd: options.workspace?.cwd ?? '/workspace',
            python: { mirror: ctx.runId },
            ...(options.workspace?.files ? { files: options.workspace.files } : {}),
            ...(options.workspace?.github ? { github: options.workspace.github } : {}),
            ...(options.workspace?.psh ? { psh: options.workspace.psh } : {}),
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
        const defaults: create.configure.Options = {
          configuration: {
            scope,
            session_id: session.session_id,
            provider: session.provider,
            model: session.model,
            thinking: session.thinking,
            max_tokens: session.max_tokens,
            service_tier: session.service_tier,
            subagents: options.subagents,
            ...(options.codeMode === false ? { code_mode: false } : {}),
            ...(options.cellMemoryBytes === undefined
              ? {}
              : { cell_memory_bytes: options.cellMemoryBytes }),
            instructions:
              executor && options.handInstructions
                ? [options.instructions, options.handInstructions].filter(Boolean).join('\n\n')
                : options.instructions,
            subscription: plan !== undefined,
            endpoint: plan
              ? Gateway.planEndpoint(session.provider)
              : wallet
                ? Gateway.walletEndpoint(session.provider)
                : (options.endpoint ?? Gateway.endpoint(session.provider)),
            gateway: plan || wallet ? undefined : gateway,
            event_coalesce_ms: options.eventCoalesceMs ?? defaultEventCoalesceMs,
            stream_tool_input: options.streamToolInput,
            ...(executor ? { hands: true } : {}),
            tools: definitions,
            ...(options.webSearch === false ? { web_search: false } : {}),
            ...(mcpServers.length ? { mcp_servers: mcpServers } : {}),
            ...(shell ? { workspace: shell.cwd } : {}),
            ...(shell && options.workspaceTools ? { workspace_tools: options.workspaceTools } : {}),
          },
          runtime: {
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
              return plan
                ? plan.dispatch(request, signal)
                : wallet
                  ? wallet(request, signal)
                  : dispatch(request, signal)
            },
            ...(plan?.socket ? { socket: plan.socket } : {}),
          },
        }
        const opening = options.configure ? await options.configure(session, defaults) : defaults
        await runtime.open(opening.configuration, {
          ...opening.runtime,
          tools: {
            call: (name, input, signal, { call_id }) => {
              counts.tool_calls++
              return callTool(ctx, journal, tools, name, input, signal, call_id)
            },
          },
        })
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
      const placing = new Map<string, Promise<unknown>>()
      let read = ctx.pending().length > 0
      for (;;) {
        await Promise.all(placing.values())
        if (read) read = false
        else await ctx.refresh()
        const pending = ctx.pending()
        let thinking =
          pending[0] && effort(ctx.state(), { before: pending[0].id, initial: session.thinking })
        for (const submission of pending) {
          const placed = await place(
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
          thinking = placed.thinking
          if (!placed.placing) continue
          placing.set(submission.id, placed.placing)
          placed.placing.then(
            () => placing.delete(submission.id),
            (error: unknown) => ctx.halt?.(error),
          )
        }
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
          placing,
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
      const journal = Journal.create(ctx, {
        batchMs: options.batchMs,
        durability,
        replicas: options.replicas,
      })
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
                  payer?: Contracts.Payer
                }
              }
            | undefined
        )?.nanocode
        const provider = chosen?.provider ?? options.provider ?? 'claude'
        const model = chosen?.provider ? chosen.model : options.model
        const thinking = chosen?.provider ? chosen.thinking : options.thinking
        const max_tokens = chosen?.provider ? chosen.max_tokens : undefined
        const service_tier = chosen?.provider ? chosen.service_tier : undefined
        const payer = chosen?.provider ? chosen.payer : undefined
        const derived = ctx.isMemoized(sessionKey) ? undefined : runSessionUuid(ctx.runId)
        const chosenSession: Session = {
          session_id: derived ?? Contracts.sessionUuid(),
          provider,
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(max_tokens ? { max_tokens } : {}),
          ...(service_tier ? { service_tier } : {}),
          ...(payer ? { payer } : {}),
        }
        const recording = ctx.effect(
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
              ...(payer ? { payer } : {}),
            },
          },
          async (): Promise<Session> => chosenSession,
        )
        const recorded = recording.then((stored) => {
          if (derived && JSON.stringify(stored) !== JSON.stringify(chosenSession))
            throw new Restart(`${sessionKey} was recorded by another drive`)
          return stored
        })
        if (derived) recorded.catch((error: unknown) => ctx.halt?.(error))
        const session = derived ? chosenSession : await recorded
        await run(ctx, journal, session, counts)
        await recorded
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
    batchMs?: number
    cellMemoryBytes?: number
    codeMode?: boolean
    configure?: (session: Session, options: configure.Options) => configure.Options | Promise<configure.Options>
    dispatch?: Gateway.Dispatch
    durability?: Journal.Durability
    endpoint?: string
    eventCoalesceMs?: number
    fetch?: typeof fetch
    gateway?: 'vercel'
    github?: {
      token?(sessionId: string): string | null | undefined | Promise<string | null | undefined>
    }
    handInstructions?: string
    hands?: false | Hands
    instructions?: string
    maxPrompts?: number
    mcp?: {
      fetch?(sessionId: string): typeof fetch
      servers: Contracts.McpServer[]
    }
    model?: string
    module?: () => Promise<WebAssembly.Module>
    name?: string
    promptImages?: (session: Session) => boolean
    provider?: Contracts.ModelProvider
    replicas?: Journal.Replicas
    report?: (report: DriveReport) => void
    sessionFetch?(sessionId: string): typeof fetch
    streamToolInput?: boolean
    subscription?(session: {
      account: string
      provider: Contracts.ModelProvider
      model?: string
    }): Promise<Subscription | undefined> | Subscription | undefined
    subagents?: boolean
    thinking?: Contracts.AgentConfiguration['thinking']
    tools?: HostTool[]
    wallet?(sessionId: string): Gateway.Dispatch
    workspace?:
      | false
      | {
          cwd?: string
          files?: Record<string, string>
          github?: GitHub.Options
          psh?: WebAssembly.Module | Promise<WebAssembly.Module>
        }
    workspaceTools?: Contracts.AgentConfiguration['workspace_tools']
    webSearch?: false
  }

  namespace configure {
    type Options = {
      configuration: Contracts.AgentConfiguration
      runtime: Omit<Contracts.RuntimeOptions, 'tools'>
    }
  }
}

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
    before: string
    initial: Contracts.Thinking | undefined
  }
}

export function exceeds(state: SessionState, options: exceeds.Options): boolean {
  const { id, limit } = options
  if (limit === undefined) return false
  let index = 0
  for (const submission of state.submissions) {
    if (submission.id === id) return index >= limit
    if (
      submission.kind !== 'chaos' &&
      submission.kind !== 'withdraw' &&
      !cancels(submission) &&
      !commanded(submission)
    )
      index++
  }
  return false
}

export declare namespace exceeds {
  type Options = {
    id: string
    limit: number | undefined
  }
}

export function isIdle(state: SessionState, options: isIdle.Options): boolean {
  const { batches } = options
  return batches === 0 || state.effects.get(settledKey(batches))?.status === 'completed'
}

export declare namespace isIdle {
  type Options = {
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
): Promise<{ thinking: Contracts.Thinking | undefined; placing?: Promise<unknown> }> {
  if (cancels(submission)) {
    await cancelTurn(
      ctx,
      journal,
      runtime,
      submission,
      (await runtime.pending(scope))[0]?.report.request_id,
    )
    return { thinking }
  }
  const command = commanded(submission)
  if (command) {
    await control(ctx, journal, runtime, submission, command)
    return { thinking }
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
    return { thinking }
  }
  const effortLevel =
    submission.kind === 'prompt' ? effortCommand.exec(submission.text ?? '') : null
  if (effortLevel) {
    const level = effortLevel[1] as Contracts.Thinking
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
    return { thinking: outcome.thinking ?? thinking }
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
  const placing = journal.durable().then(() =>
    ctx.effect(
      `nanocode.place:${submission.id}`,
      {
        name: 'nanocode.place',
        replay: 'safe',
        placed: [submission.id],
        input: { request_id: submission.id },
      },
      async () => ({ submitted: submitted.submitted }),
    ),
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
  return { thinking, placing }
}

async function steer(
  ctx: DriveContext,
  journal: Journal.Journal,
  runtime: AgentRuntime.AgentRuntime,
  driving: Promise<unknown>,
  active: string,
  limit: number | undefined,
  placing: ReadonlyMap<string, Promise<unknown>>,
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
      if (placing.has(submission.id)) continue
      if (cancels(submission)) {
        await cancelTurn(ctx, journal, runtime, submission, active)
        continue
      }
      const command = commanded(submission)
      if (command) {
        await control(ctx, journal, runtime, submission, command)
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

async function control(
  ctx: DriveContext,
  journal: Journal.Journal,
  runtime: AgentRuntime.AgentRuntime,
  submission: Submission,
  command: SubagentCommand,
): Promise<void> {
  const outcome = (await ctx.effect(
    `nanocode.place:${submission.id}`,
    { name: 'nanocode.subagent', replay: 'safe', placed: [submission.id], input: command },
    async (): Promise<SubagentOutcome> => {
      try {
        if (command.action === 'close')
          return { ok: { agents: await runtime.subagents.close(command.agent_id) } }
        if (command.action === 'interrupt')
          return { ok: { agents: await runtime.subagents.interrupt(command.agent_id) } }
        if (command.action === 'send_user_message') {
          const receipt = await runtime.subagents.sendUserMessage(command.agent_id, {
            message: command.message,
            priority: command.priority,
          })
          await journal.durable()
          return { ok: receipt }
        }
        if (command.action === 'side_question')
          return {
            ok: await runtime.subagents.sideQuestion(command.agent_id, {
              question: command.question,
            }),
          }
        return { error: `unknown subagent action ${(command as { action: unknown }).action}` }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  )) as SubagentOutcome
  ctx.live({ type: 'subagent_control', request_id: submission.id, ...command, ...outcome } as never)
}

export function commanded(submission: Submission): SubagentCommand | undefined {
  if (submission.kind !== 'steer' || !submission.text?.startsWith(subagentText)) return undefined
  try {
    return JSON.parse(submission.text.slice(subagentText.length)) as SubagentCommand
  } catch {
    return undefined
  }
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
    if (tool.replay !== 'safe') await journal.durable()
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

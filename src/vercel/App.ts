import * as AsyncHooks from 'node:async_hooks'
import {
  chatRoute,
  createDriveRoute,
  durableAgent,
  getWorld,
  type HostTool,
  waitUntil,
} from 'durable-harness'
import * as AgentRuntime from '../AgentRuntime.ts'
import * as Subagents from '../client/Subagents.ts'
import * as Hands from './Hands.ts'
import * as Harness from './Harness.ts'
import * as Journal from './Journal.ts'
import * as Sources from '../bash/Sources.ts'
import * as SqlFileSystem from '../bash/SqlFileSystem.ts'
import * as Files from '../internal/Files.ts'
import * as Tempo from '../machines/Tempo.ts'
import * as Attachments from './internal/Attachments.ts'
import * as Egress from './internal/Egress.ts'
import * as Plans from './Plans.ts'
import * as Transport from './Transport.ts'
import * as Wasm from './Wasm.ts'
import type * as Contracts from '../Contracts.ts'

export type Authorize = ((request: Request) => Promise<void> | void) | 'public'

export type Selection = {
  provider: Contracts.ModelProvider
  model: string
  thinking: Harness.Thinking
  max_tokens?: number
  service_tier?: Harness.ServiceTier
}

export type SelectionHarness = {
  id: Contracts.ModelProvider
  label: string
  models: SelectionModel[]
}

export type SelectionModel = {
  id: string
  label: string
  name: string
  efforts: Harness.Thinking[]
  effort: Harness.Thinking
  maxTokens?: number
  serviceTier?: Harness.ServiceTier
}

export function select(
  harnesses: readonly SelectionHarness[],
  options: select.Options,
): Selection | undefined {
  const entry = harnesses.find((candidate) => candidate.id === options.harness)
  const found = entry?.models.find((candidate) => candidate.id === options.model)
  if (!entry || !found) return undefined
  const thinking =
    options.effort === undefined
      ? found.effort
      : found.efforts.includes(options.effort as Harness.Thinking)
        ? (options.effort as Harness.Thinking)
        : undefined
  if (!thinking) return undefined
  return {
    model: found.id,
    provider: entry.id,
    thinking,
    ...(found.maxTokens ? { max_tokens: found.maxTokens } : {}),
    ...(found.serviceTier ? { service_tier: found.serviceTier } : {}),
  }
}

export declare namespace select {
  type Options = {
    effort?: unknown
    harness: unknown
    model: unknown
  }
}

function served(options: select.Options): Selection | undefined {
  if (options.harness !== 'claude' && options.harness !== 'codex') return undefined
  if (typeof options.model !== 'string' || !options.model.trim()) return undefined
  const thinking = Tempo.efforts.find((level) => level === options.effort)
  if (!thinking) return undefined
  return {
    model: options.model,
    provider: options.harness,
    thinking,
    ...(options.harness === 'claude' && !/^claude-/.test(options.model)
      ? { max_tokens: Tempo.outputTokens }
      : {}),
  }
}

type Body = {
  action?: unknown
  agent_id?: unknown
  attachments?: unknown
  effort?: unknown
  hand?: unknown
  harness?: unknown
  kind?: unknown
  message?: unknown
  model?: unknown
  payer?: unknown
  priority?: unknown
  question?: unknown
  sessionId?: unknown
  text?: unknown
  warm?: unknown
}

function command(body: Body): Harness.SubagentCommand | string {
  const id = body.agent_id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    return 'agent_id must be a positive integer'
  if (body.action === 'close' || body.action === 'interrupt')
    return { action: body.action, agent_id: id }
  if (body.action === 'side_question')
    return typeof body.question === 'string' && body.question.trim()
      ? { action: 'side_question', agent_id: id, question: body.question }
      : 'question must be a nonempty string'
  if (body.action !== 'send_user_message')
    return 'action must be close, interrupt, send_user_message or side_question'
  if (typeof body.message !== 'string' || !body.message.trim())
    return 'message must be a nonempty string'
  if (body.priority !== undefined && body.priority !== 'urgent' && body.priority !== 'deferred')
    return 'priority must be urgent or deferred'
  return {
    action: 'send_user_message',
    agent_id: id,
    message: body.message,
    ...(body.priority ? { priority: body.priority } : {}),
  }
}

type Sending = { fresh: boolean; kind: string; text: string; sent?: Promise<string> }

function carried(value: unknown): Attachments.File[] | string {
  if (!Array.isArray(value) || value.length > 8) return 'attachments must be at most 8 files'
  let total = 0
  for (const item of value as Partial<Attachments.File>[]) {
    if (
      typeof item?.path !== 'string' ||
      !Attachments.path.test(item.path) ||
      typeof item.data !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
    )
      return 'each attachment needs a /workspace/uploads/ path and base64 data'
    total += Math.floor((item.data.length * 3) / 4)
  }
  if (total > Transport.attachmentBytes)
    return `a message carries at most ${Transport.attachmentBytes} bytes of attachments`
  return value as Attachments.File[]
}

export function create(options: create.Options) {
  const {
    harnesses,
    account,
    authorize,
    maxPromptCharacters,
    chaos,
    marks,
    traceAudience,
    runAhead,
    drive,
    directDriveMs,
    deadlineMarginMs,
    defaultSelection: chosenDefault,
    hands: chosenHands,
    plans: planOptions,
    payers: chosenPayers,
    payerHarnesses,
    replicaBytes,
    ...rest
  } = options
  const hands = chosenHands ?? {}
  const plans = planOptions ? Plans.create(planOptions, account) : undefined
  const harness = { ...rest, hands, subscription: rest.subscription ?? plans?.subscription }
  const payers: readonly Contracts.Payer[] = chosenPayers ?? [
    'deployment',
    ...(harness.subscription ? (['plan'] as const) : []),
    ...(harness.wallet ? (['wallet'] as const) : []),
  ]
  const first = harnesses[0]!.models[0]!
  const defaultSelection = chosenDefault ?? {
    provider: harnesses[0]!.id,
    model: first.id,
    thinking: first.efforts.includes('low') ? 'low' : first.effort,
  }
  const durability = options.durability ?? 'on'
  const replicas =
    replicaBytes === undefined ? undefined : Journal.replicas({ bytes: replicaBytes })
  const kernel = durability === 'on' && runAhead === true ? 'on' : 'strict'
  const agent = durableAgent({
    harness: Harness.create({
      subagents: true,
      streamToolInput: true,
      ...harness,
      provider: defaultSelection.provider,
      model: defaultSelection.model,
      thinking: defaultSelection.thinking,
      durability,
      ...(replicas ? { replicas } : {}),
    }),
    durability: kernel,
    marks: marks ?? false,
    ...(directDriveMs ? { directDriveMs } : {}),
    ...(deadlineMarginMs ? { deadlineMarginMs } : {}),
  })
  const sessions = agent.sessions
  const turns =
    drive === 'queue'
      ? undefined
      : createDriveRoute({
          after: (work) => waitUntil(work()),
          drive: (id, meta) => sessions.drive(id, meta),
        })
  const sending = new AsyncHooks.AsyncLocalStorage<Sending>()
  const submit = (id: string, text: string, kind: string) =>
    sessions.send(
      id,
      text,
      kind as Parameters<typeof sessions.send>[2],
      turns ? { wake: 'backstop', waitUntil } : {},
    )
  const chat = chatRoute(
    {
      start: () =>
        sessions.start({ config: { durability: kernel === 'on' ? 'run-ahead' : 'strict' } }),
      send: (id, text, kind) => sessions.send(id, text, kind),
      inspect: (id) => sessions.inspect(id),
      liveEnd: (id) => {
        const current = sending.getStore()
        if (current && !current.sent) {
          current.sent = submit(id, current.text, current.kind)
          current.sent.catch(() => undefined)
        }
        return current?.fresh ? Promise.resolve(0) : sessions.liveEnd(id)
      },
      liveEntries: (id, entries) => sessions.liveEntries(id, entries),
    },
    {
      ...(authorize ? { authorize } : {}),
      async send(id, text, kind) {
        const current = sending.getStore()
        const submission = await (current?.sent && current.text === text && current.kind === kind
          ? current.sent
          : submit(id, text, kind))
        turns?.drive(id, { why: kind })
        return submission
      },
    },
  )
  const post = (request: Request, body: Body, fresh: boolean) =>
    typeof body.text === 'string'
      ? sending.run(
          {
            fresh,
            kind: typeof body.kind === 'string' ? body.kind : 'prompt',
            text: body.text,
          },
          () => chat.POST(request),
        )
      : chat.POST(request)
  const handRoutes = Hands.route({
    world: getWorld,
    owns: async (sessionId, channel) =>
      ((await agent.sessions.inspect(sessionId)).config as { hand?: unknown } | undefined)?.hand ===
      channel,
    ...(hands && hands.holdMs ? { holdMs: hands.holdMs } : {}),
    ...(hands && hands.maxFrameBytes ? { maxFrameBytes: hands.maxFrameBytes } : {}),
  })
  const upgrade = hands ? hands.upgrade : undefined
  const streamsHands = hands !== false && !hands.relay

  const admit = async (request: Request): Promise<Response | undefined> => {
    if (typeof authorize === 'function') {
      try {
        await authorize(request)
      } catch (refusal) {
        if (refusal instanceof Response) return refusal
        throw refusal
      }
      return undefined
    }
    if (authorize !== 'public' && process.env.NODE_ENV === 'production')
      return new Response(
        'set an authorize function or authorize: "public" to start sessions in production',
        { status: 401 },
      )
    return undefined
  }

  const start = async (
    request: Request,
    body: Body,
  ): Promise<{ sessionId: string; hand?: string } | Response> => {
    if (body.payer !== undefined && !payers.includes(body.payer as Contracts.Payer))
      return new Response(`payer must be one of ${payers.join(', ')}`, { status: 400 })
    const payer = body.payer as Contracts.Payer | undefined
    const gateway = payer === 'wallet' && !payerHarnesses?.wallet
    const offered = (payer && payerHarnesses?.[payer]) || harnesses
    const selection = (() => {
      const chosen = { effort: body.effort, harness: body.harness, model: body.model }
      if (body.harness === undefined && body.model === undefined) return defaultSelection
      if (gateway) return served(chosen)
      return select(offered, chosen)
    })()
    if (!selection && gateway)
      return new Response(
        `harness must be claude or codex, model one that the Tempo gateway lists at ${Tempo.listing}, and effort one of ${Tempo.efforts.join(', ')}`,
        { status: 400 },
      )
    if (!selection)
      return new Response(
        `harness, model and effort must name one of ${offered.map((entry) => `${entry.id} (${entry.models.map((model) => `${model.id}: ${model.efforts.join('|')}`).join(', ')})`).join(' or ')}`,
        { status: 400 },
      )
    const refused = await admit(request)
    if (refused) return refused
    const hand = !harness.hands
      ? {}
      : body.hand === true
        ? { hand: Hands.id() }
        : typeof body.hand === 'string' && Harness.handChannel.test(body.hand)
          ? { hand: body.hand }
          : {}
    const owner = account ? await account(request) : undefined
    if (
      payer === 'plan' &&
      !(owner && (await harness.subscription?.({ account: owner, ...selection })))
    )
      return new Response(
        `sign in to your ${selection.provider === 'codex' ? 'ChatGPT' : 'Claude'} plan first, or choose another payer`,
        { status: 403 },
      )
    const config = {
      ...hand,
      ...(owner ? { account: owner } : {}),
      durability: kernel === 'on' ? 'run-ahead' : 'strict',
      nanocode: { ...selection, ...(payer ? { payer } : {}) } satisfies Omit<
        Harness.Session,
        'session_id'
      >,
      traceAudience: traceAudience ?? (authorize === 'public' ? 'public' : 'unknown'),
    }
    const { sessionId } = await agent.sessions.start({ config })
    return { sessionId, ...hand }
  }

  const file = async (request: Request, params: URLSearchParams): Promise<Response> => {
    const refused = await admit(request)
    if (refused) return refused
    const sessionId = params.get('sessionId')
    if (!sessionId) return Response.json({ error: 'sessionId is required' }, { status: 400 })
    if (harness.workspace === false)
      return Response.json({ error: 'this deployment has no workspace' }, { status: 404 })
    const state = await agent.sessions.inspect(sessionId).catch(() => undefined)
    if (!state) return Response.json({ error: 'no such session' }, { status: 404 })
    const journal = Journal.read(state, replicas)
    try {
      return await Files.response(
        SqlFileSystem.create(
          {
            transaction: (_kind, _operation, statements, access) =>
              journal.sql.run(statements, access),
          },
          {
            scope: Harness.scope,
            sources: Sources.create({
              fetch: Egress.guard(),
              ...(harness.github?.token ? { token: () => harness.github!.token!(sessionId) } : {}),
            }),
          },
        ),
        params.get('file') ?? '',
        { root: harness.workspace?.cwd ?? '/workspace' },
      )
    } finally {
      journal.close()
    }
  }

  const subagents = async (request: Request, sessionId: string): Promise<Response> => {
    const refused = await admit(request)
    if (refused) return refused
    const state = await agent.sessions.inspect(sessionId).catch(() => undefined)
    if (!state) return Response.json({ error: 'no such session' }, { status: 404 })
    const journal = Journal.read(state, replicas)
    const runtime = await AgentRuntime.instantiate(
      await Wasm.load(),
      {
        transaction: (_kind, _operation, statements, access) => journal.sql.run(statements, access),
      },
      { published: () => {} },
    )
    try {
      const updates: Subagents.Update[] = []
      for (let after = 0; ; ) {
        const page = await runtime.page(Harness.scope, after, 512)
        for (const event of page.events) {
          const update = Subagents.update(event)
          if (update) updates.push(update)
        }
        if (!page.has_more || page.next_cursor <= after) break
        after = page.next_cursor
      }
      return Response.json(
        { agents: Subagents.entries(updates) },
        { headers: { 'cache-control': 'no-store' } },
      )
    } finally {
      await runtime.dispose().catch(() => undefined)
      journal.close()
    }
  }

  const control = async (request: Request, body: Body): Promise<Response> => {
    if (typeof body.sessionId !== 'string')
      return new Response('sessionId is required', { status: 400 })
    const parsed = command(body)
    if (typeof parsed === 'string') return Response.json({ error: parsed }, { status: 400 })
    const refused = await admit(request)
    if (refused) return refused
    const sessionId = body.sessionId
    if (!(await agent.sessions.inspect(sessionId).catch(() => undefined)))
      return Response.json({ error: 'no such session' }, { status: 404 })
    const submission = await agent.sessions.send(
      sessionId,
      Harness.subagentText + JSON.stringify(parsed),
      'steer',
    )
    while (!request.signal.aborted) {
      const effect = (await agent.sessions.inspect(sessionId)).effects.get(
        `nanocode.place:${submission}`,
      )
      if (effect?.status === 'completed') {
        const outcome = effect.output as Harness.SubagentOutcome
        if ('ok' in outcome)
          return Response.json(outcome.ok, {
            status: parsed.action === 'send_user_message' ? 202 : 200,
          })
        return Response.json(
          { error: outcome.error },
          {
            status: /unknown agent_id|no subagents|not a root session/.test(outcome.error)
              ? 404
              : 409,
          },
        )
      }
      if (effect?.status === 'failed')
        return Response.json(
          { error: effect.error?.message ?? 'subagent control failed' },
          { status: 503 },
        )
      await new Promise((resolve) => setTimeout(resolve, Harness.waitPollMs))
    }
    return Response.json({ submission }, { status: 202 })
  }

  async function GET(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams
    if (params.has('file')) return file(request, params)
    if (params.has('subagents') && params.get('sessionId'))
      return subagents(request, params.get('sessionId')!)
    if (upgrade && request.headers.get('upgrade')?.toLowerCase() === 'websocket')
      return handRoutes.SOCKET(request, upgrade)
    if (hands !== false && params.has('hands') && params.get('sessionId')) {
      const refused = await admit(request)
      if (refused) return refused
      return Response.json(
        await Hands.listing(await getWorld(), { runId: params.get('sessionId')! }),
        { headers: { 'cache-control': 'no-store' } },
      )
    }
    if (streamsHands && params.has('hand')) return handRoutes.GET(request)
    if (params.get('cursor') === Transport.firstCursor && params.get('sessionId')) {
      const state = await agent.sessions.inspect(params.get('sessionId')!).catch(() => undefined)
      if (state && !state.submissions.length)
        return new Response('event: end\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
        })
    }
    if (!params.has('keepwarm')) return chat.GET(request)
    await Wasm.load()
    return new Response(null, { status: 204 })
  }

  async function POST(original: Request): Promise<Response> {
    if (streamsHands && new URL(original.url).searchParams.has('hand'))
      return handRoutes.POST(original)
    const sent = (await original
      .clone()
      .json()
      .catch(() => undefined)) as Body | undefined
    if (!sent || typeof sent !== 'object') return chat.POST(original)
    if (sent.kind === 'subagent') return control(original, sent)
    if (sent.kind === 'cancel') {
      if (typeof sent.sessionId !== 'string')
        return new Response('sessionId is required', { status: 400 })
      const refused = await admit(original)
      if (refused) return refused
      const state = await agent.sessions.inspect(sent.sessionId).catch(() => undefined)
      if (!state) return Response.json({ error: 'no such session' }, { status: 404 })
      return Response.json(
        { submission: await agent.sessions.send(sent.sessionId, Harness.cancelText, 'steer') },
        { status: 202 },
      )
    }
    if (
      maxPromptCharacters &&
      typeof sent.text === 'string' &&
      sent.text.length > maxPromptCharacters
    )
      return new Response(`A prompt is at most ${maxPromptCharacters} characters.`, { status: 413 })
    let body = sent
    let request = original
    if (sent.attachments !== undefined) {
      const files = carried(sent.attachments)
      if (typeof files === 'string') return new Response(files, { status: 400 })
      const { attachments: _, ...rest } = sent
      body = {
        ...rest,
        text: Attachments.carry(typeof sent.text === 'string' ? sent.text : '', files),
      }
      const headers = new Headers(original.headers)
      headers.delete('content-length')
      request = new Request(original.url, {
        body: JSON.stringify(body),
        headers,
        method: 'POST',
        signal: original.signal,
      })
    }
    if (typeof body.sessionId === 'string') return post(request, body, false)
    if (body.warm === true) {
      const started = await start(request, body)
      if (started instanceof Response) return started
      void Wasm.load()
      return Response.json(started)
    }
    if (body.sessionId !== undefined || typeof body.text !== 'string' || !body.text)
      return chat.POST(request)
    const started = await start(request, body)
    if (started instanceof Response) return started
    const { sessionId } = started
    return post(
      new Request(request.url, {
        body: JSON.stringify({ ...body, sessionId }),
        headers: request.headers,
        method: 'POST',
        signal: request.signal,
      }),
      body,
      true,
    )
  }

  async function crash(request: Request): Promise<Response> {
    if (!chaos) return new Response('chaos is off for this deployment', { status: 404 })
    const refused = await admit(request)
    if (refused) return refused
    const {
      sessionId,
      at = 'tool',
      afterMs = 500,
    } = (await request.json()) as { sessionId?: string; at?: 'tool' | 'any'; afterMs?: number }
    if (!sessionId) return new Response('sessionId is required', { status: 400 })
    const id = await agent.sessions.chaos(sessionId, { at, afterMs })
    return Response.json({ armed: id, at, afterMs })
  }

  return {
    agent,
    GET,
    POST,
    chaos: { POST: crash },
    defaultSelection,
    harnesses,
    plans: plans?.routes,
  }
}

export declare namespace create {
  type Options = Omit<
    Harness.create.Options,
    'provider' | 'model' | 'thinking' | 'tools' | 'durability' | 'replicas'
  > & {
    account?(request: Request): string | null | undefined | Promise<string | null | undefined>
    authorize?: Authorize
    chaos?: boolean
    deadlineMarginMs?: number
    defaultSelection?: Selection
    directDriveMs?: number
    drive?: 'route' | 'queue'
    durability?: 'on' | 'strict'
    harnesses: SelectionHarness[]
    marks?: boolean
    payerHarnesses?: Partial<Record<Contracts.Payer, SelectionHarness[]>>
    payers?: readonly Contracts.Payer[]
    plans?: Plans.Options
    maxPromptCharacters?: number
    replicaBytes?: number
    runAhead?: boolean
    tools?: HostTool[]
    traceAudience?: string
  }
}

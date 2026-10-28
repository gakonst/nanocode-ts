/**
 * Next.js route handlers for nanocode sessions on Vercel: chat, files, hands, cancel, and chaos, around a durable-harness agent.
 *
 * @module
 */
import { durableAgent, getWorld, type HostTool } from 'durable-harness'
import * as Hands from './Hands.ts'
import * as Harness from './Harness.ts'
import * as Journal from './Journal.ts'
import * as SqlFileSystem from '../bash/SqlFileSystem.ts'
import * as Files from '../internal/Files.ts'
import * as Attachments from './internal/Attachments.ts'
import * as LocalSql from './internal/LocalSql.ts'
import * as Transport from './Transport.ts'
import * as Wasm from './Wasm.ts'
import type * as Contracts from '../Contracts.ts'

/** Authorizes a request that starts or reads a session, or `public` for none. A thrown `Response` refuses it. */
export type Authorize = ((request: Request) => Promise<void> | void) | 'public'

/** Model choice of a session. */
export type Selection = {
  provider: Contracts.ModelProvider
  model: string
  thinking: Harness.Thinking
  max_tokens?: number
  service_tier?: Harness.ServiceTier
}

/** Harness that a session can select, with its models. */
export type SelectionHarness = {
  /** Provider of the harness. */
  id: Contracts.ModelProvider
  /** Display label. */
  label: string
  models: SelectionModel[]
}

/** Model that a session can select. */
export type SelectionModel = {
  /** Model ID. */
  id: string
  /** Display label. */
  label: string
  /** Display name. */
  name: string
  /** Reasoning efforts that the model accepts. */
  efforts: Harness.Thinking[]
  /** Default reasoning effort. */
  effort: Harness.Thinking
  /** Largest output in tokens. */
  maxTokens?: number
  serviceTier?: Harness.ServiceTier
}

/** Returns the selection that a request names, or `undefined` when the harness, model, or effort is not offered. */
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
    /** Requested effort. Defaults to the model's effort. */
    effort?: unknown
    /** Requested harness ID. */
    harness: unknown
    /** Requested model ID. */
    model: unknown
  }
}

type Body = {
  attachments?: unknown
  effort?: unknown
  hand?: unknown
  harness?: unknown
  kind?: unknown
  model?: unknown
  sessionId?: unknown
  text?: unknown
  warm?: unknown
}

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

/** Returns the route handlers and the agent of a nanocode deployment on Vercel. */
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
    directDriveMs,
    deadlineMarginMs,
    defaultSelection: chosenDefault,
    hands: chosenHands,
    ...rest
  } = options
  const hands = chosenHands ?? {}
  const harness = { ...rest, hands }
  const first = harnesses[0]!.models[0]!
  const defaultSelection = chosenDefault ?? {
    provider: harnesses[0]!.id,
    model: first.id,
    thinking: first.efforts.includes('low') ? 'low' : first.effort,
  }
  const durability = options.durability ?? 'on'
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
    }),
    durability: kernel,
    marks: marks ?? false,
    ...(directDriveMs ? { directDriveMs } : {}),
    ...(deadlineMarginMs ? { deadlineMarginMs } : {}),
  })
  const chat = agent.chatRoute(authorize ? { authorize } : {})
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
    const selection =
      body.harness === undefined && body.model === undefined
        ? defaultSelection
        : select(harnesses, { effort: body.effort, harness: body.harness, model: body.model })
    if (!selection)
      return new Response(
        `harness, model and effort must name one of ${harnesses.map((entry) => `${entry.id} (${entry.models.map((model) => `${model.id}: ${model.efforts.join('|')}`).join(', ')})`).join(' or ')}`,
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
    const config = {
      ...hand,
      ...(owner ? { account: owner } : {}),
      durability: kernel === 'on' ? 'run-ahead' : 'strict',
      nanocode: selection satisfies Omit<Harness.Session, 'session_id'>,
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
    const sql = LocalSql.create(Journal.committed(state))
    try {
      return await Files.response(
        SqlFileSystem.create(
          { transaction: (_kind, _operation, statements) => sql.run(statements) },
          { scope: Harness.scope },
        ),
        params.get('file') ?? '',
        { root: harness.workspace?.cwd ?? '/workspace' },
      )
    } finally {
      sql.close()
    }
  }

  async function GET(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams
    if (params.has('file')) return file(request, params)
    if (upgrade && request.headers.get('upgrade')?.toLowerCase() === 'websocket')
      return handRoutes.SOCKET(request, upgrade)
    if (hands !== false && params.has('hands') && params.get('sessionId')) {
      const refused = await admit(request)
      if (refused) return refused
      return Response.json(
        { hands: await Hands.attached(await getWorld(), { runId: params.get('sessionId')! }) },
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
    if (typeof body.sessionId === 'string') return chat.POST(request)
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
    return chat.POST(
      new Request(request.url, {
        body: JSON.stringify({ ...body, sessionId }),
        headers: request.headers,
        method: 'POST',
        signal: request.signal,
      }),
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

  return { agent, GET, POST, chaos: { POST: crash }, defaultSelection, harnesses }
}

export declare namespace create {
  type Options = Omit<
    Harness.create.Options,
    'provider' | 'model' | 'thinking' | 'tools' | 'durability'
  > & {
    /** Returns the account that a new session runs as, such as a signed-in user's ID, which `subscription` receives. */
    account?(request: Request): string | null | undefined | Promise<string | null | undefined>
    /** Authorizes requests that start or read sessions. Production deployments need one. */
    authorize?: Authorize
    /** Whether `chaos.POST` arms crashes for tests. */
    chaos?: boolean
    /** Time in milliseconds that the drive keeps for itself before its deadline. */
    deadlineMarginMs?: number
    /** Selection of a session that names no harness or model. Defaults to the first model of the first harness. */
    defaultSelection?: Selection
    /** Time in milliseconds that a request drives the session before it hands off to the queue. */
    directDriveMs?: number
    /** Defaults to `on`. */
    durability?: 'on' | 'strict'
    /** Harnesses and models that sessions can select. */
    harnesses: SelectionHarness[]
    /** Whether the kernel publishes timing marks. */
    marks?: boolean
    /** Largest prompt in characters. */
    maxPromptCharacters?: number
    /** Whether the kernel runs ahead of the log with `on` durability. */
    runAhead?: boolean
    /** Host tools. */
    tools?: HostTool[]
    /** Audience of the session's traces. Defaults to `public` for public deployments. */
    traceAudience?: string
  }
}

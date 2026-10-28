import { durableAgent, getWorld, type HostTool } from 'durable-harness'
import { attachedHands, handId, handRoute } from './hands.ts'
import {
  ATTACHMENT_PATH,
  CANCEL,
  type CarriedFile,
  carryAttachments,
  HAND_CHANNEL,
  nanocodeHarness,
  type NanocodeHarnessOptions,
  type NanocodeSession,
  SCOPE,
  type ServiceTier,
  type Thinking,
} from './harness.ts'
import { committedBatches, LocalSql } from './journal.ts'
import { SqlFileSystem } from '../bash/index.ts'
import { fileResponse } from '../files.ts'
import { FIRST_CURSOR, VERCEL_ATTACHMENT_BYTES } from './transport.ts'
import { nanocodeModule } from './module.ts'
import type { ModelProvider } from '../contracts.ts'

export type Selection = {
  provider: ModelProvider
  model: string
  thinking: Thinking
  max_tokens?: number
  service_tier?: ServiceTier
}

export type SelectionModel = {
  id: string
  label: string
  name: string
  efforts: Thinking[]
  effort: Thinking
  maxTokens?: number
  serviceTier?: ServiceTier
}

export type SelectionHarness = { id: ModelProvider; label: string; models: SelectionModel[] }

export type Authorize = ((request: Request) => Promise<void> | void) | 'public'

export type NanocodeAppOptions = Omit<
  NanocodeHarnessOptions,
  'provider' | 'model' | 'thinking' | 'tools' | 'durability'
> & {
  harnesses: SelectionHarness[]
  defaultSelection?: Selection
  tools?: HostTool[]
  authorize?: Authorize
  durability?: 'on' | 'strict'
  runAhead?: boolean
  maxPromptCharacters?: number
  chaos?: boolean
  marks?: boolean
  traceAudience?: string
  directDriveMs?: number
  deadlineMarginMs?: number
}

export function selectionOf(
  harnesses: SelectionHarness[],
  harness: unknown,
  chosen: unknown,
  effort: unknown,
): Selection | undefined {
  const entry = harnesses.find((candidate) => candidate.id === harness)
  const found = entry?.models.find((candidate) => candidate.id === chosen)
  if (!entry || !found) return undefined
  const thinking =
    effort === undefined
      ? found.effort
      : found.efforts.includes(effort as Thinking)
        ? (effort as Thinking)
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

function carried(value: unknown): CarriedFile[] | string {
  if (!Array.isArray(value) || value.length > 8) return 'attachments must be at most 8 files'
  let total = 0
  for (const item of value as Partial<CarriedFile>[]) {
    if (
      typeof item?.path !== 'string' ||
      !ATTACHMENT_PATH.test(item.path) ||
      typeof item.data !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
    )
      return 'each attachment needs a /workspace/uploads/ path and base64 data'
    total += Math.floor((item.data.length * 3) / 4)
  }
  if (total > VERCEL_ATTACHMENT_BYTES)
    return `a message carries at most ${VERCEL_ATTACHMENT_BYTES} bytes of attachments`
  return value as CarriedFile[]
}

export function createNanocode(options: NanocodeAppOptions) {
  const {
    harnesses,
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
    harness: nanocodeHarness({
      codeMode: true,
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
  const handRoutes = handRoute({
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
        : selectionOf(harnesses, body.harness, body.model, body.effort)
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
        ? { hand: handId() }
        : typeof body.hand === 'string' && HAND_CHANNEL.test(body.hand)
          ? { hand: body.hand }
          : {}
    const config = {
      ...hand,
      durability: kernel === 'on' ? 'run-ahead' : 'strict',
      nanocode: selection satisfies Omit<NanocodeSession, 'session_id'>,
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
    const sql = new LocalSql(committedBatches(state))
    try {
      return await fileResponse(
        new SqlFileSystem(
          { transaction: (_kind, _operation, statements) => sql.run(statements) },
          SCOPE,
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
        { hands: await attachedHands(await getWorld(), params.get('sessionId')!) },
        { headers: { 'cache-control': 'no-store' } },
      )
    }
    if (streamsHands && params.has('hand')) return handRoutes.GET(request)
    if (params.get('cursor') === FIRST_CURSOR && params.get('sessionId')) {
      const state = await agent.sessions.inspect(params.get('sessionId')!).catch(() => undefined)
      if (state && !state.submissions.length)
        return new Response('event: end\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
        })
    }
    if (!params.has('keepwarm')) return chat.GET(request)
    await nanocodeModule()
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
        { submission: await agent.sessions.send(sent.sessionId, CANCEL, 'steer') },
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
        text: carryAttachments(typeof sent.text === 'string' ? sent.text : '', files),
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
      void nanocodeModule()
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

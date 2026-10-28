/**
 * Hands over Workflow streams: a hand's socket on one Function instance reaches a brain that runs on another.
 *
 * @module
 */
import type { DriveContext } from 'durable-harness'
import type * as Contracts from '../Contracts.ts'
import * as Remote from '../Remote.ts'

type World = DriveContext['world']

/** One JSON line of a hand stream. */
export type Line = {
  /** Brain that frames go to or come from. */
  brain?: string
  /** Catalog frame of a hand that attached. */
  catalog?: string
  /** Whether the hand's connection closed. */
  closed?: boolean
  /** Connection of the hand. */
  connection?: string
  /** Remote frames in order. */
  frames?: string[]
}

/** Pattern of a hand's connection ID. */
export const connectionPattern = /^[A-Za-z0-9_-]{8,64}$/

/** Default time in milliseconds that a hand's event stream stays open. */
export const defaultHoldMs = 240_000

/** Server side of a hand's WebSocket, in the `ws` package's shape. */
export type Socket = {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: Uint8Array | string, isBinary: boolean) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** Upgrades a request to a WebSocket and serves it with `handler`, as `@vercel/functions` does. */
export type UpgradeWebSocket = (
  handler: (socket: Socket) => void | Promise<void>,
  options?: { maxPayload?: number },
) => Promise<Response>

type Brain = {
  receive(frame: string): void
  shut(code: number, reason: string): void
  lost(hand: LocalHand): void
  rebind(hand: LocalHand): void
}

type LocalHand = { connection: string; catalog: string; socket: Socket; brain?: Brain }

const OPEN = 1

// The `Symbol.for` keys are durable: every copy of the package in one process shares these maps.
const local: Map<string, LocalHand> = ((globalThis as { [key: symbol]: unknown })[
  Symbol.for('nanocode-ts.vercel.hands')
] ??= new Map()) as Map<string, LocalHand>

const parked: Map<string, Brain> = ((globalThis as { [key: symbol]: unknown })[
  Symbol.for('nanocode-ts.vercel.parked')
] ??= new Map()) as Map<string, Brain>

const encoder = new TextEncoder()

const decoder = new TextDecoder()

/** Returns the Workflow stream names of a session's hands, and of one connection when `connection` is set. */
export function streams(runId: string, options: streams.Options = {}): streams.ReturnType {
  const connection = options.connection ?? ''
  return {
    attach: runId + '_hand',
    down: runId + '_hand_down_' + connection,
    up: runId + '_hand_up_' + connection,
  }
}

export declare namespace streams {
  type Options = {
    /** Connection of one hand. Defaults to an empty string. */
    connection?: string | undefined
  }

  type ReturnType = {
    /** Stream of attach and close lines. */
    attach: string
    /** Stream of frames from brains to the hand. */
    down: string
    /** Stream of frames from the hand to brains. */
    up: string
  }
}

/** Returns a random 32-character hex ID for a hand channel, connection, or brain. */
export function id(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/** Returns a writer that appends lines to a stream in call order. */
export function append(world: World, options: append.Options): (line: Line) => Promise<void> {
  const { name, runId } = options
  let last = Promise.resolve()
  return (line) => {
    const next = last.then(() =>
      world.streams.write(runId, name, encoder.encode(JSON.stringify(line) + '\n')),
    )
    last = next.catch(() => undefined)
    return next
  }
}

export declare namespace append {
  type Options = {
    /** Stream name. */
    name: string
    /** Run of the session. */
    runId: string
  }
}

function frameWriter(
  write: (line: Line) => Promise<void>,
  failed: () => void,
): (brain: string, frame: string) => void {
  let pending: { brain: string; frames: string[] }[] = []
  let writing = false
  const pump = async () => {
    while (pending.length) {
      const lines = pending
      pending = []
      for (const line of lines) {
        try {
          await write(line)
        } catch {
          writing = false
          failed()
          return
        }
      }
    }
    writing = false
  }
  return (brain, frame) => {
    const last = pending.at(-1)
    if (last?.brain === brain) last.frames.push(frame)
    else pending.push({ brain, frames: [frame] })
    if (writing) return
    writing = true
    queueMicrotask(() => void pump())
  }
}

/** Yields each line of a stream from `start` with its 1-based index, and follows the stream until it ends or `signal` aborts. */
export async function* tail(world: World, options: tail.Options): AsyncGenerator<[number, Line]> {
  const { name, runId, signal } = options
  let index = options.start
  while (!signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancel = () => void reader?.cancel().catch(() => undefined)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      reader = (await world.streams.get(runId, name, index)).getReader()
      if (signal.aborted) cancel()
      const decoder = new TextDecoder()
      let buffered = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end)
          buffered = buffered.slice(end + 1)
          if (!line) continue
          index++
          yield [index, JSON.parse(line) as Line]
        }
      }
      if (signal.aborted) return
      const info = await world.streams.getInfo(runId, name).catch(() => undefined)
      if (info?.done) return
    } catch {
      if (signal.aborted) return
    } finally {
      signal.removeEventListener('abort', cancel)
      try {
        reader?.releaseLock()
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export declare namespace tail {
  type Options = {
    /** Stream name. */
    name: string
    /** Run of the session. */
    runId: string
    /** Stops the generator. */
    signal: AbortSignal
    /** Index of the first line to read. */
    start: number
  }
}

function dialLocal(
  world: World,
  runId: string,
  first: LocalHand,
  resumes: boolean,
): Contracts.MessageSocket {
  const listeners: Record<'close' | 'error' | 'message', ((event: any) => void)[]> = {
    close: [],
    error: [],
    message: [],
  }
  const emit = (type: 'close' | 'error' | 'message', event: unknown) => {
    for (const listener of listeners[type]) listener(event)
  }
  let closed = false
  let current: LocalHand | undefined = first
  let catalog = first.catalog
  let held: string[] | undefined = []
  let queued: string[] = []
  let watching: AbortController | undefined
  const brain: Brain = {
    receive(frame) {
      if (held) held.push(frame)
      else emit('message', { data: frame })
    },
    shut(code, reason) {
      if (closed) return
      closed = true
      watching?.abort()
      if (current?.brain === brain) current.brain = undefined
      if (parked.get(runId) === brain) parked.delete(runId)
      emit('close', { code, reason })
    },
    lost(hand) {
      if (closed || current !== hand) return
      if (!resumes) return brain.shut(1011, 'the hand disconnected')
      current = undefined
      parked.set(runId, brain)
      watching = new AbortController()
      void elsewhere(world, runId, watching.signal, () =>
        brain.shut(1011, 'the hand reconnected to another instance'),
      )
    },
    rebind(hand) {
      if (closed) return
      if (!resumes) return brain.shut(1011, 'the hand reconnected')
      watching?.abort()
      watching = undefined
      if (parked.get(runId) === brain) parked.delete(runId)
      if (current?.brain === brain) current.brain = undefined
      current = hand
      hand.brain = brain
      if (held) catalog = hand.catalog
      else emit('message', { data: hand.catalog })
      const frames = queued
      queued = []
      for (const frame of frames) hand.socket.send(frame)
    },
  }
  parked.get(runId)?.shut(1011, 'the hand moved to a newer brain')
  first.brain?.shut(1011, 'the hand moved to a newer brain')
  first.brain = brain
  setTimeout(() => {
    const frames = held ?? []
    held = undefined
    if (closed) return
    emit('message', { data: catalog })
    for (const frame of frames) emit('message', { data: frame })
  }, 0)
  return {
    send(message: string) {
      if (closed) throw new Error('the hand disconnected')
      if (current?.socket.readyState === OPEN) current.socket.send(message)
      else if (resumes) queued.push(message)
      else throw new Error('the hand disconnected')
    },
    close(code?: number, reason?: string) {
      brain.shut(code ?? 1000, reason ?? '')
    },
    addEventListener(type: 'close' | 'error' | 'message', listener: (event: any) => void) {
      listeners[type].push(listener)
    },
  }
}

async function elsewhere(
  world: World,
  runId: string,
  signal: AbortSignal,
  moved: () => void,
): Promise<void> {
  const attach = streams(runId).attach
  const info = await world.streams.getInfo(runId, attach).catch(() => undefined)
  for await (const [, line] of tail(world, {
    name: attach,
    runId,
    signal,
    start: (info?.tailIndex ?? -1) + 1,
  })) {
    if (line.catalog === undefined || line.connection === local.get(runId)?.connection) continue
    moved()
    return
  }
}

async function find(
  world: World,
  runId: string,
  signal: AbortSignal,
): Promise<{ current?: Line; attached: AsyncGenerator<[number, Line]> } | undefined> {
  const attach = streams(runId).attach
  const info = await world.streams.getInfo(runId, attach).catch(() => undefined)
  if (!info || info.tailIndex < 0) return undefined
  const attached = tail(world, {
    name: attach,
    runId,
    signal,
    start: Math.max(0, info.tailIndex - 15),
  })
  let current: Line | undefined
  for (;;) {
    const next = await attached.next()
    if (next.done) break
    const [index, line] = next.value
    if (line.closed) {
      if (current?.connection === line.connection) current = undefined
    } else if (
      line.catalog !== undefined &&
      typeof line.connection === 'string' &&
      connectionPattern.test(line.connection)
    )
      current = line
    if (index > info.tailIndex) break
  }
  return { ...(current ? { current } : {}), attached }
}

function handName(catalog: string): string | null {
  try {
    const name = (JSON.parse(catalog) as { name?: unknown }).name
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}

/** Returns the name of the hand attached to a session, or an empty list when none is attached. A hand without a name is `null`. */
export async function attached(
  world: World,
  options: attached.Options,
): Promise<(string | null)[]> {
  const { runId } = options
  const nearby = local.get(runId)
  if (nearby?.socket.readyState === OPEN) return [handName(nearby.catalog)]
  const stop = new AbortController()
  try {
    const found = await find(world, runId, stop.signal)
    return found?.current?.catalog !== undefined ? [handName(found.current.catalog)] : []
  } finally {
    stop.abort()
  }
}

export declare namespace attached {
  type Options = {
    /** Run of the session. */
    runId: string
  }
}

/**
 * Returns a socket to the hand attached to a session: the hand's own socket on this instance, or else its Workflow streams.
 * Throws when no hand is attached.
 */
export async function dial(world: World, options: dial.Options): Promise<Contracts.MessageSocket> {
  const { runId, signal } = options
  const resumes = options.resumes === true
  const nearby = local.get(runId)
  if (nearby && nearby.socket.readyState === OPEN) return dialLocal(world, runId, nearby, resumes)
  const watch = new AbortController()
  const dialing = () => watch.abort()
  signal.addEventListener('abort', dialing, { once: true })
  let found: { current?: Line; attached: AsyncGenerator<[number, Line]> } | undefined
  try {
    found = await find(world, runId, watch.signal)
  } finally {
    signal.removeEventListener('abort', dialing)
  }
  const current = found?.current
  if (!found || !current || watch.signal.aborted) {
    watch.abort()
    throw new Error('no hand is attached to this session')
  }
  const attached = found.attached
  let connection = current.connection!
  const catalog = current.catalog!
  const named = streams(runId, { connection })
  const up = await world.streams.getInfo(runId, named.up).catch(() => ({ tailIndex: -1 }))
  const brain = id()
  const listeners: Record<'close' | 'error' | 'message', ((event: any) => void)[]> = {
    close: [],
    error: [],
    message: [],
  }
  const emit = (type: 'close' | 'error' | 'message', event: unknown) => {
    for (const listener of listeners[type]) listener(event)
  }
  let closed = false
  let lost = false
  let queued: string[] = []
  let following = new AbortController()
  const close = (code: number, reason: string) => {
    if (closed) return
    closed = true
    watch.abort()
    following.abort()
    void attached.return(undefined)
    emit('close', { code, reason })
  }
  const writer = (to: string) =>
    frameWriter(append(world, { name: streams(runId, { connection: to }).down, runId }), () =>
      close(1011, 'the hand stream refused a frame'),
    )
  let write = writer(connection)
  const follow = async (name: string, start: number, stop: AbortSignal) => {
    for await (const [, line] of tail(world, { name, runId, signal: stop, start })) {
      if (closed) return
      if (line.brain !== brain) continue
      for (const frame of line.frames ?? []) emit('message', { data: frame })
    }
  }
  setTimeout(() => {
    if (closed) return
    emit('message', { data: catalog })
    void follow(named.up, up.tailIndex + 1, following.signal)
    void (async () => {
      for (;;) {
        const next = await attached.next().catch(() => ({ done: true as const, value: undefined }))
        if (next.done || closed) return
        const line = next.value[1]
        if (line.closed) {
          if (line.connection !== connection) continue
          if (!resumes) return close(1011, 'the hand disconnected')
          lost = true
          continue
        }
        if (
          line.catalog === undefined ||
          typeof line.connection !== 'string' ||
          !connectionPattern.test(line.connection) ||
          line.connection === connection
        )
          continue
        if (!resumes) return close(1011, 'the hand reconnected')
        following.abort()
        following = new AbortController()
        connection = line.connection
        write = writer(connection)
        lost = false
        emit('message', { data: line.catalog })
        void follow(streams(runId, { connection }).up, 0, following.signal)
        const frames = queued
        queued = []
        for (const frame of frames) write(brain, frame)
      }
    })()
  }, 0)
  return {
    send(message: string) {
      if (closed) throw new Error('the hand disconnected')
      if (lost) queued.push(message)
      else write(brain, message)
    },
    close(code?: number, reason?: string) {
      close(code ?? 1000, reason ?? '')
    },
    addEventListener(type: 'close' | 'error' | 'message', listener: (event: any) => void) {
      listeners[type].push(listener)
    },
  }
}

export declare namespace dial {
  type Options = {
    /** Whether the socket waits for the hand to reconnect after it disconnects. */
    resumes?: boolean | undefined
    /** Run of the session. */
    runId: string
    /** Stops the search for an attached hand. */
    signal: AbortSignal
  }
}

function serveSocket(world: World, sessionId: string, socket: Socket): void {
  socket.send(Remote.handAccepted)
  const connection = id()
  const names = streams(sessionId, { connection })
  const attach = append(world, { name: names.attach, runId: sessionId })
  const up = frameWriter(append(world, { name: names.up, runId: sessionId }), () =>
    socket.close(1011, 'the hand stream refused a frame'),
  )
  const stop = new AbortController()
  let hand: LocalHand | undefined
  let brain: string | undefined
  socket.on('message', (data, binary) => {
    if (binary) return socket.close(1003, 'remote code mode requires JSON text frames')
    const frame = typeof data === 'string' ? data : decoder.decode(data)
    if (!hand) {
      hand = { connection, catalog: frame, socket }
      const waiting = parked.get(sessionId) ?? local.get(sessionId)?.brain
      local.set(sessionId, hand)
      waiting?.rebind(hand)
      void attach({ catalog: frame, connection }).catch(() =>
        socket.close(1011, 'the hand stream refused the catalog'),
      )
      void (async () => {
        for await (const [, line] of tail(world, {
          name: names.down,
          runId: sessionId,
          signal: stop.signal,
          start: 0,
        })) {
          if (typeof line.brain === 'string') brain = line.brain
          for (const sent of line.frames ?? []) if (socket.readyState === OPEN) socket.send(sent)
        }
      })()
      return
    }
    if (hand.brain) return hand.brain.receive(frame)
    if (brain) up(brain, frame)
  })
  const closed = () => {
    if (stop.signal.aborted) return
    stop.abort()
    if (!hand) return
    if (local.get(sessionId) === hand) local.delete(sessionId)
    hand.brain?.lost(hand)
    void attach({ closed: true, connection }).catch(() => undefined)
  }
  socket.on('close', closed)
  socket.on('error', closed)
}

/**
 * Returns the hand routes of a session: `GET` streams frames to a hand, `POST` accepts its lines, and `SOCKET` serves its WebSocket.
 * Each route admits a hand only on the channel that `owns` accepts.
 */
export function route(options: route.Options): route.ReturnType {
  const known = new Map<string, Promise<boolean>>()
  const admit = async (
    url: URL,
    bearer = '',
  ): Promise<{ sessionId: string; channel: string } | Response> => {
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const channel = url.searchParams.get('hand') ?? bearer
    if (
      !sessionId ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(sessionId) ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(channel)
    )
      return new Response('sessionId and hand must name a session and its hand channel', {
        status: 400,
      })
    const key = sessionId + '/' + channel
    let owned = known.get(key)
    if (!owned) {
      owned = options.owns(sessionId, channel).catch(() => false)
      known.set(key, owned)
      void owned.then((yes) => {
        if (!yes) known.delete(key)
      })
    }
    if (!(await owned))
      return new Response('this session has no hand on that channel', { status: 404 })
    return { sessionId, channel }
  }

  async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const admitted = await admit(url)
    if (admitted instanceof Response) return admitted
    const connection = url.searchParams.get('connection') ?? ''
    if (!connectionPattern.test(connection))
      return new Response("connection must name the hand's connection", { status: 400 })
    const cursor = Number(
      url.searchParams.get('cursor') ?? request.headers.get('last-event-id') ?? 0,
    )
    const start = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
    const world = await options.world()
    const name = streams(admitted.sessionId, { connection }).down
    const stop = new AbortController()
    const hold = setTimeout(() => stop.abort(), options.holdMs ?? defaultHoldMs)
    request.signal.addEventListener('abort', () => stop.abort(), { once: true })
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(': attached\n\n'))
        try {
          for await (const [index, line] of tail(world, {
            name,
            runId: admitted.sessionId,
            signal: stop.signal,
            start,
          }))
            controller.enqueue(
              encoder.encode('id: ' + index + '\ndata: ' + JSON.stringify(line) + '\n\n'),
            )
        } catch {}
        clearTimeout(hold)
        try {
          controller.close()
        } catch {}
      },
      cancel() {
        clearTimeout(hold)
        stop.abort()
      },
    })
    return new Response(body, {
      headers: {
        'cache-control': 'no-cache, no-transform',
        'content-type': 'text/event-stream',
        'x-accel-buffering': 'no',
      },
    })
  }

  async function POST(request: Request): Promise<Response> {
    const admitted = await admit(new URL(request.url))
    if (admitted instanceof Response) return admitted
    const body = (await request.json().catch(() => undefined)) as
      | {
          brain?: unknown
          catalog?: unknown
          close?: unknown
          connection?: unknown
          frames?: unknown
        }
      | undefined
    if (!body || typeof body.connection !== 'string' || !connectionPattern.test(body.connection))
      return new Response("connection must name the hand's connection", { status: 400 })
    const world = await options.world()
    const names = streams(admitted.sessionId, { connection: body.connection })
    if (body.close === true) {
      await append(world, { name: names.attach, runId: admitted.sessionId })({
        closed: true,
        connection: body.connection,
      })
      return new Response(null, { status: 204 })
    }
    if (typeof body.catalog === 'string') {
      await append(world, { name: names.attach, runId: admitted.sessionId })({
        catalog: body.catalog,
        connection: body.connection,
      })
      return new Response(null, { status: 204 })
    }
    if (
      typeof body.brain !== 'string' ||
      !Array.isArray(body.frames) ||
      !body.frames.every((frame) => typeof frame === 'string')
    )
      return new Response('frames must be strings sent to a brain', { status: 400 })
    await append(world, { name: names.up, runId: admitted.sessionId })({
      brain: body.brain,
      frames: body.frames as string[],
    })
    return new Response(null, { status: 204 })
  }

  async function SOCKET(request: Request, upgrade: UpgradeWebSocket): Promise<Response> {
    const bearer = Remote.bearerToken(request)
    const admitted = await admit(new URL(request.url), bearer)
    if (
      admitted instanceof Response &&
      /^\s*bearer\s*,/.test(request.headers.get('sec-websocket-protocol') ?? '')
    )
      return upgrade((socket) => socket.close(1008, 'this hand token is not valid for the session'))
    if (admitted instanceof Response) return new Response(admitted.body, { status: 403 })
    const world = await options.world()
    return upgrade((socket) => serveSocket(world, admitted.sessionId, socket), {
      maxPayload: options.maxFrameBytes ?? 1_048_576,
    })
  }

  return { GET, POST, SOCKET }
}

export declare namespace route {
  type Options = {
    /** Time in milliseconds that an event stream stays open. Defaults to `defaultHoldMs`. */
    holdMs?: number | undefined
    /** Largest WebSocket frame in bytes. Defaults to 1 MiB. */
    maxFrameBytes?: number | undefined
    /** Whether `channel` is the hand channel of the session. */
    owns(sessionId: string, channel: string): Promise<boolean>
    /** Returns the Workflow world. */
    world(): Promise<World>
  }

  type ReturnType = {
    /** Streams the frames that brains send to a hand connection, as Server-Sent Events. */
    GET(request: Request): Promise<Response>
    /** Appends a hand's catalog, close, or frames to its streams. */
    POST(request: Request): Promise<Response>
    /** Serves a hand's WebSocket through `upgrade`. */
    SOCKET(request: Request, upgrade: UpgradeWebSocket): Promise<Response>
  }
}

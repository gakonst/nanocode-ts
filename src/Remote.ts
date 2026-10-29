import * as Contracts from './Contracts.ts'

export type Policy = {
  max_frame_bytes: number
  resumes?: boolean | undefined
  timeout_ms: number
}

export type Executor<S extends Contracts.MessageSocket = Contracts.MessageSocket> = {
  readonly catalog: string | undefined
  readonly closed: Promise<string>
  readonly failure: string | undefined
  readonly parked: boolean
  readonly socket: S
  cancel(id: number): void
  claim(owner: object): void
  disconnected(reason?: string): void
  dispose(): Promise<void>
  execute(request: Contracts.RemoteRequest, id: number): Promise<unknown>
  host(): NonNullable<Contracts.RuntimeOptions['remote']>
  owns(owner: object): boolean
  park(reason?: string): void
  ready(): Promise<void>
  rebind(socket: S, catalog: string): boolean
  receive(data: unknown): void
  refuse(reason: string): void
  reject(reason: string): void
  release(): void
}

export const handLeft = 4001

export const brainReplaced = 4002

export const handAccepted = JSON.stringify({ type: 'ack', ids: [] })

export function toolsOnly(catalog: string): boolean {
  return (JSON.parse(catalog) as { tools_only?: unknown }).tools_only === true
}

const encoder = new TextEncoder()

export function accept<S extends Contracts.MessageSocket>(socket: S, policy: Policy): Executor<S> {
  validate(policy)
  return create(socket, { listen: false, policy })
}

export function bearerProtocols(token: string): string[] {
  return ['bearer', token]
}

export function bearerToken(request: Request): string | undefined {
  const header = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
  if (header) return header

  const [scheme, token] = (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((value) => value.trim())
  return scheme === 'bearer' && token ? token : undefined
}

export function bearerAccepted(request: Request): Record<string, string> {
  return /^\s*bearer\s*,/.test(request.headers.get('sec-websocket-protocol') ?? '')
    ? { 'sec-websocket-protocol': 'bearer' }
    : {}
}

export async function connect<S extends Contracts.MessageSocket>(
  open: (signal: AbortSignal) => Promise<S>,
  policy: Policy,
): Promise<Executor<S>> {
  validate(policy)

  const controller = new AbortController()
  let expire!: (error: Error) => void
  const deadline = new Promise<never>((_, reject) => {
    expire = reject
  })
  const timer = setTimeout(() => {
    controller.abort()
    expire(new Error('remote executor connection deadline elapsed'))
  }, policy.timeout_ms)

  let executor: Executor<S> | undefined
  try {
    const socket = await Promise.race([open(controller.signal), deadline])
    executor = create(socket, { listen: true, policy })
    await Promise.race([executor.ready(), deadline])
    return executor
  } catch (error) {
    executor?.disconnected(error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function restore<S extends Contracts.MessageSocket>(
  socket: S,
  options: restore.Options,
): Executor<S> {
  validate(options.policy)
  return create(socket, { catalog: options.catalog, listen: false, policy: options.policy })
}

export declare namespace restore {
  type Options = {
    catalog: string
    policy: Policy
  }
}

function create<S extends Contracts.MessageSocket>(
  socket: S,
  options: { catalog?: string | undefined; listen: boolean; policy: Policy },
): Executor<S> {
  const policy = options.policy
  let catalog = options.catalog
  let catalogWaiter: { resolve(): void; reject(error: Error): void } | undefined
  let failure: string | undefined
  let frames: string[] = []
  let owner: object | undefined
  let parked: ReturnType<typeof setTimeout> | undefined
  let queued: string[] = []
  let waiter: { id: number; resolve(value: unknown): void } | undefined

  let close!: (reason: string) => void
  const closed = new Promise<string>((resolve) => {
    close = resolve
  })

  const catalogReady = (): Promise<void> => {
    if (catalog !== undefined) return Promise.resolve()
    if (failure !== undefined) return Promise.reject(new Error(failure))
    return new Promise((resolve, reject) => {
      catalogWaiter = { reject, resolve }
    })
  }

  const fail = (reason: string, code: number, told?: string) => {
    if (failure !== undefined) return
    failure = reason
    if (parked !== undefined) clearTimeout(parked)
    parked = undefined
    queued = []
    close(reason)

    try {
      socket.close(code, told)
    } catch {}

    catalogWaiter?.reject(new Error(reason))
    catalogWaiter = undefined
    const pending = waiter
    waiter = undefined
    pending?.resolve({ closed: reason })
  }

  const executor: Executor<S> = {
    get catalog() {
      return catalog
    },
    closed,
    get failure() {
      return failure
    },
    get parked() {
      return parked !== undefined
    },
    get socket() {
      return socket
    },

    cancel(id) {
      if (waiter?.id !== id) return
      waiter.resolve(null)
      waiter = undefined
    },

    claim(next) {
      if (owner === next) return
      owner = next
      const pending = waiter
      waiter = undefined
      pending?.resolve({ closed: 'connection moved to a newer runtime' })
    },

    disconnected(reason = 'runner disconnected') {
      fail(reason, reason === 'runner disconnected' ? 1000 : 1011)
    },

    async dispose() {
      fail('remote executor disposed', 1000)
    },

    async execute(request, id) {
      switch (request.op) {
        case 'remote_catalog':
          return {
            frame: catalog,
            max_frame_bytes: policy.max_frame_bytes,
            timeout_ms: policy.timeout_ms,
            ...(policy.resumes ? { resumes: true } : {}),
          }
        case 'remote_send': {
          if (failure !== undefined) throw new Contracts.RemoteRefusalError(failure)
          const refused = new Set(request.refused)

          if (parked !== undefined) {
            for (const [index, frame] of (request.frames ?? []).entries())
              if (!refused.has(index)) queued.push(frame)
            return refused.size ? { refused: [...refused], reason: request.reason } : null
          }

          let sent = 0
          try {
            for (const [index, frame] of (request.frames ?? []).entries())
              if (!refused.has(index)) {
                socket.send(frame)
                sent++
              }
          } catch (error) {
            throw sent
              ? error
              : new Contracts.RemoteRefusalError(
                  error instanceof Error ? error.message : String(error),
                )
          }
          return refused.size ? { refused: [...refused], reason: request.reason } : null
        }
        case 'remote_poll':
          if (frames.length) return { frames: frames.splice(0) }
          if (failure !== undefined) return { closed: failure }
          if (waiter) throw new Error('remote_poll is already pending')
          return new Promise((resolve) => {
            waiter = { id, resolve }
          })
        case 'remote_close':
          fail(String(request.reason), 1000)
          return null
        default:
          throw new Error(`unsupported remote operation ${request.op}`)
      }
    },

    host() {
      const claimed = {}
      executor.claim(claimed)
      return {
        cancel: (id) => executor.cancel(id),
        dispose: async () => {},
        execute: async (request, id) => {
          if (executor.owns(claimed)) return executor.execute(request, id)
          if (request.op === 'remote_send')
            throw new Contracts.RemoteRefusalError('hand connection moved to a newer runtime')
          return request.op === 'remote_poll'
            ? { closed: 'connection moved to a newer runtime' }
            : null
        },
        failed: () => failure !== undefined,
      }
    },

    owns(candidate) {
      return owner === candidate
    },

    park(reason = 'runner disconnected') {
      if (!policy.resumes || catalog === undefined || failure !== undefined)
        return executor.disconnected(reason)
      if (parked !== undefined) return
      parked = setTimeout(() => executor.disconnected(reason), policy.timeout_ms)
    },

    async ready() {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          catalogReady(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('hand catalog deadline elapsed')),
              policy.timeout_ms,
            )
          }),
        ])
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1011)
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },

    rebind(next, frame) {
      if (failure !== undefined) return false
      if (parked !== undefined) clearTimeout(parked)
      parked = undefined
      socket = next
      executor.receive(frame)

      const pending = queued
      queued = []
      for (const item of pending) next.send(item)
      return true
    },

    receive(data) {
      if (failure !== undefined) return
      if (typeof data !== 'string') return fail('remote code mode requires JSON text frames', 1003)
      if (encoder.encode(data).byteLength > policy.max_frame_bytes)
        return fail('remote code mode frame exceeds caller max_frame_bytes policy', 1009)

      if (catalog === undefined) {
        catalog = data
        catalogWaiter?.resolve()
        catalogWaiter = undefined
        return
      }

      frames.push(data)
      const pending = waiter
      if (!pending) return
      waiter = undefined
      pending.resolve({ frames: frames.splice(0) })
    },

    refuse(reason) {
      fail(reason, 1008, reason)
    },

    reject(reason) {
      fail(reason, 1002)
    },

    release() {
      owner = {}
    },
  }

  if (options.listen) {
    socket.addEventListener('message', (event) => executor.receive(event.data))
    socket.addEventListener('close', () => executor.disconnected())
    socket.addEventListener('error', () => executor.disconnected('runner connection failed'))
  }

  return executor
}

function validate(policy: Policy) {
  for (const key of ['max_frame_bytes', 'timeout_ms'] as const)
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0)
      throw new Error(`remote ${key} must be a positive integer`)
}

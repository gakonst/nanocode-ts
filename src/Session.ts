/**
 * Sessions: one runtime per scope that reopens when its hand changes, with an optional relay for remote hands.
 *
 * @module
 */
import * as Bridge from './Bridge.ts'
import * as ClientRelay from './client/Relay.ts'
import type * as Contracts from './Contracts.ts'
import type * as AgentRuntime from './AgentRuntime.ts'
import type * as Remote from './Remote.ts'

/** Relay that a session dials for remote hands. */
export type Relay = {
  url: string
  token?: string
  policy: Remote.Policy
  keep?(token: string): void
}

/** Options of `open`. */
export type Options = {
  scope: string
  open(hand: Bridge.Hand | undefined): Promise<AgentRuntime.AgentRuntime>
  relay?: Relay
  waitMs?: number
}

/** Open session. */
export type Session = {
  readonly interrupted: boolean
  ask(prompt: string): Promise<Contracts.TurnReport | undefined>
  steer(prompt: string): Promise<'queued' | 'steered'>
  resume(): Promise<Contracts.TurnReport | undefined>
  hand(): ClientRelay.Access | undefined
  hands(): readonly (string | null)[]
  runtime(): AgentRuntime.AgentRuntime
  dispose(): Promise<void>
}

/** Returns the name that a relayed hand attaches as. */
export function handName(hand: Bridge.Hand): string {
  return hand.name ?? 'machine'
}

/** Opens a session and its runtime, and reopens the runtime when a hand attaches or leaves. */
export async function open(options: Options): Promise<Session> {
  const { scope } = options
  let hand: Bridge.Hand | undefined
  let placed: Bridge.Hand | undefined
  let disposed = false
  const arrivals = new Set<() => void>()
  const launch = async () => {
    placed = hand
    const runtime = await options.open(placed)
    if (placed) await runtime.attach(handName(placed), placed.connection)
    return runtime
  }
  let runtime = await launch()
  let leases = 0
  let reopening: Promise<void> | undefined
  const reopen = () => {
    reopening = (async () => {
      if (!runtime.closed) await runtime.dispose()
      try {
        runtime = await launch()
      } catch (error) {
        if (!placed) throw error
        hand = undefined
        runtime = await launch()
      }
    })()
      .catch(() => {})
      .finally(() => {
        reopening = undefined
        if (!runtime.closed) settle()
      })
  }
  const settle = () => {
    if (disposed || leases || reopening) return
    if (placed !== hand || runtime.closed) reopen()
  }
  const lease = async <T>(work: () => Promise<T>): Promise<T> => {
    while (reopening) await reopening
    if (runtime.closed && !disposed) {
      reopen()
      await reopening
    }
    leases++
    try {
      return await work()
    } finally {
      leases--
      settle()
    }
  }
  const relay = new AbortController()
  let token = options.relay?.token
  let relaying = false
  const connect = () => {
    if (!options.relay || !token || relaying) return
    relaying = true
    Bridge.relay(
      options.relay.url,
      token,
      options.relay.policy,
      (found) => {
        hand = found
        if (found) for (const arrived of arrivals) arrived()
        settle()
      },
      relay.signal,
    )
  }
  connect()
  const arrival = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        arrivals.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      arrivals.add(done)
    })
  const submit = async (prompt: string) => {
    const request = crypto.randomUUID()
    const on = placed && handName(placed)
    const submitted = await runtime.submit(scope, {
      ...(on ? { hand: on } : {}),
      metadata: on ? { hand: on } : {},
      prompt,
      request_id: request,
    })
    if (submitted.submitted !== 'accepted')
      throw new Error(`The session refused the prompt (${submitted.submitted}).`)
    return request
  }
  let draining: Promise<void> | undefined
  const drain = () => {
    draining ??= lease(async () => {
      try {
        for (;;) {
          const next = (await runtime.pending(scope))[0]
          if (!next) break
          const driven = await runtime.drive(next.report.request_id)
          if (driven.retry)
            throw new Error('The session must reopen. Reload the page to start again.')
          if (driven.waiting)
            await new Promise((resolve) => setTimeout(resolve, options.waitMs ?? 500))
        }
      } finally {
        draining = undefined
      }
    })
    return draining
  }
  const interrupted = (await runtime.pending(scope)).length > 0
  return {
    interrupted,
    ask: (prompt) =>
      lease(async () => {
        const request = await submit(prompt)
        await drain()
        return (await runtime.turn(scope, request))?.report
      }),
    steer: (prompt) =>
      lease(async () => {
        if (await runtime.steer(crypto.randomUUID(), prompt)) return 'steered'
        await submit(prompt)
        void drain()
        return 'queued'
      }),
    async resume() {
      const waiting = (await lease(() => runtime.pending(scope)))[0]
      const wanted = (waiting?.metadata as { hand?: unknown } | null | undefined)?.hand
      if (typeof wanted === 'string' && !placed && options.relay && token) {
        connect()
        if (!hand) await arrival(options.relay.policy.timeout_ms)
      }
      return lease(async () => {
        const pending = (await runtime.pending(scope))[0]
        if (!pending) return undefined
        await drain()
        return (await runtime.turn(scope, pending.report.request_id))?.report
      })
    },
    hand() {
      if (!options.relay) return undefined
      if (!token) {
        token = ClientRelay.createToken()
        options.relay.keep?.(token)
      }
      connect()
      return { url: ClientRelay.socketUrl(options.relay.url), token }
    },
    hands: () => (hand ? [hand.name] : []),
    runtime: () => runtime,
    async dispose() {
      disposed = true
      relay.abort()
      while (reopening) await reopening
      if (!runtime.closed) await runtime.dispose()
    },
  }
}

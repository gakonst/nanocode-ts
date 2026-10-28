import {
  type Attachment,
  attachedPrompt,
  type EntryKind,
  type HandAccess,
  type HandSource,
  type LiveEvent,
  liveEvent,
  serverEvents,
  socketUrl,
  type Transport,
  type TransportParameters,
} from '../client.ts'
import type * as Contracts from '../Contracts.ts'

export type CloudflareSession = { id?: string; cursor?: number; open?: string }

export type CloudflareModel = {
  provider: string
  model: string
  thinking?: string
  web_search?: boolean
}

export type CloudflareTransportOptions = {
  url?: string
  model(): CloudflareModel
  headers?(): Record<string, string>
  session?: { load(): CloudflareSession; save(session: CloudflareSession): void }
  reconnectMs?: number
  warmMs?: number
  hand?(session: string, signal?: AbortSignal): Promise<string | undefined>
}

export type CloudflareTransport = Transport &
  HandSource & {
    session(): CloudflareSession
    warm(): void
    crash(afterMs?: number): Promise<Response>
    forget(): void
    health(): Promise<Response | undefined>
    handToken(): Promise<{ session: string; token: string }>
    hands(): Promise<string[]>
  }

type Sink = { push(event: LiveEvent): void; note(kind: EntryKind, text: string): void }

function identifier(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function cloudflare(options: CloudflareTransportOptions): CloudflareTransport {
  const base = options.url ?? ''
  const reconnectMs = options.reconnectMs ?? 1000
  const warmMs = options.warmMs ?? 10_000
  let state: CloudflareSession = options.session?.load() ?? {}
  let warmed: string | undefined
  let used = 0
  const queued: string[] = []

  const save = (session = state) => {
    if (session === state) options.session?.save(state)
  }
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...options.headers?.() })
  const path = (suffix: string, session = state) =>
    `${base}sessions/${encodeURIComponent(session.id!)}/${suffix}`
  const pause = (signal: AbortSignal | undefined, ms = reconnectMs) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done)
    })

  const receive = (logged: Contracts.LoggedEvent, requestId: string, sink: Sink): boolean => {
    const body = (logged.event ?? {}) as { source?: string; type?: string }
    if (body.source !== undefined) {
      const event = liveEvent(logged)
      if (event) sink.push(event)
      return false
    }
    if (logged.request_id !== requestId) return false
    if (body.type === 'interrupted')
      sink.note(
        'tool',
        'The session object reset. Its alarm started it again, and the turn continues from its checkpoint.',
      )
    if (body.type !== 'retrying' && body.type !== 'result') return false
    const event = liveEvent(logged)
    if (event) sink.push(event)
    return body.type === 'result'
  }

  const follow = async (
    response: Response,
    requestId: string,
    sink: Sink,
    session: CloudflareSession,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    if (!response.ok || !response.body) {
      if (signal?.aborted) return true
      sink.note('error', `${response.status} ${await response.text()}`)
      return true
    }
    let settled = false
    try {
      for await (const message of serverEvents(response.body)) {
        if (signal?.aborted) break
        if (message.id) {
          session.cursor = Number(message.id)
          save(session)
        }
        if (
          message.data &&
          receive(JSON.parse(message.data) as Contracts.LoggedEvent, requestId, sink)
        ) {
          settled = true
          break
        }
      }
    } catch {
      if (signal?.aborted) return true
      sink.note('tool', 'The stream dropped. Reconnecting from the last event.')
      return false
    }
    if (settled || signal?.aborted) void response.body.cancel().catch(() => undefined)
    return settled || Boolean(signal?.aborted)
  }

  const reconnect = async (
    requestId: string,
    sink: Sink,
    session: CloudflareSession,
    signal?: AbortSignal,
  ) => {
    let delay = reconnectMs
    while (!signal?.aborted) {
      const response = await fetch(path(`events?live=1&after=${session.cursor ?? 0}`, session), {
        headers: headers({ accept: 'text/event-stream' }),
        signal,
      }).catch(() => undefined)
      if (
        response &&
        (response.status === 408 || response.status === 429 || response.status >= 500)
      ) {
        const after = Number(response.headers.get('retry-after'))
        void response.body?.cancel().catch(() => undefined)
        await pause(signal, after > 0 ? after * 1000 : delay)
        delay = Math.min(delay * 2, 15_000)
        continue
      }
      if (response && (await follow(response, requestId, sink, session, signal))) return
      delay = response ? reconnectMs : Math.min(delay * 2, 15_000)
      await pause(signal, delay)
    }
  }

  const turn = async (
    prompt: string,
    sink: Sink,
    signal?: AbortSignal,
    attachments: readonly Attachment[] = [],
  ) => {
    state.id ??= warmed ?? identifier('web')
    const session = state
    used = performance.now()
    const requestId = identifier('turn')
    session.open = requestId
    save(session)
    const model = options.model()
    try {
      const hand = await options.hand?.(session.id!, signal)
      const response = await fetch(path(`turns?live=1&after=${session.cursor ?? 0}`, session), {
        method: 'POST',
        headers: headers({ accept: 'text/event-stream', 'content-type': 'application/json' }),
        body: JSON.stringify({
          request_id: requestId,
          prompt: attachedPrompt(prompt, attachments),
          ...(images(attachments).length ? { images: images(attachments) } : {}),
          provider: model.provider,
          model: model.model,
          ...(model.thinking ? { thinking: model.thinking } : {}),
          ...(model.web_search !== undefined ? { web_search: model.web_search } : {}),
          ...(hand ? { hand } : {}),
        }),
        signal,
      }).catch((error: unknown) => {
        if (signal?.aborted) return undefined
        throw error
      })
      if (response && !(await follow(response, requestId, sink, session, signal)))
        await reconnect(requestId, sink, session, signal)
    } finally {
      if (!signal?.aborted) {
        session.open = undefined
        used = performance.now()
        save(session)
      }
    }
  }

  const images = (attachments: readonly Attachment[]) =>
    attachments.filter((item) => item.type.startsWith('image/')).map((item) => item.path)

  const failure = async (response: Response) => {
    const body = await response.text()
    try {
      return (JSON.parse(body) as { error?: string }).error ?? body
    } catch {
      return body || `${response.status}`
    }
  }

  return {
    files: {
      maxBytes: 5 * 1024 * 1024,
      scope: () => state.id,
      async upload(file, name, signal) {
        if (!state.id) {
          state.id = warmed ?? identifier('web')
          save()
        }
        const response = await fetch(path(`files?name=${encodeURIComponent(name)}`), {
          method: 'POST',
          headers: headers({ 'content-type': 'application/octet-stream' }),
          body: file,
          ...(signal ? { signal } : {}),
        })
        if (!response.ok) throw new Error(await failure(response))
        return (await response.json()) as Attachment
      },
      async read(file, signal) {
        if (!state.id) throw new Error('no session yet')
        const response = await fetch(
          path('files' + file.split('/').map(encodeURIComponent).join('/')),
          { headers: headers(), ...(signal ? { signal } : {}) },
        )
        if (!response.ok) throw new Error(await failure(response))
        return await response.blob()
      },
    },
    async send({ prompt, attachments, push, note, signal }: TransportParameters) {
      await turn(prompt, { push, note }, signal, attachments)
      for (let next = queued.shift(); next && !signal?.aborted; next = queued.shift())
        await turn(next, { push, note }, signal)
    },
    async steer({ prompt }: TransportParameters) {
      if (!state.id) return false
      const model = options.model()
      const response = await fetch(path('turns'), {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          request_id: identifier('steer'),
          prompt,
          provider: model.provider,
          model: model.model,
          steer: true,
        }),
      })
      if (response.ok) return true
      if (response.status === 409) {
        queued.push(prompt)
        return false
      }
      throw new Error(`${response.status} ${await response.text()}`)
    },
    async cancel() {
      if (!state.open || !state.id) return
      queued.length = 0
      const response = await fetch(path(`turns/${encodeURIComponent(state.open)}/cancel`), {
        method: 'POST',
        headers: headers(),
      })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    },
    async resume({ push, note, signal }) {
      const session = state
      const open = session.open
      if (!open || !session.id) return
      try {
        await reconnect(open, { push, note }, session, signal)
      } finally {
        if (!signal?.aborted) {
          session.open = undefined
          save(session)
        }
      }
    },
    session: () => state,
    snapshot: () => ({ ...state }),
    restore(saved) {
      state = saved && typeof saved === 'object' ? { ...(saved as CloudflareSession) } : {}
      warmed = undefined
      used = 0
      queued.length = 0
    },
    warm() {
      if (used && performance.now() - used < warmMs) return
      used = performance.now()
      const id = state.id ?? (warmed ??= identifier('web'))
      const model = options.model()
      void options.hand?.(id).catch(() => undefined)
      void fetch(`${base}sessions/${encodeURIComponent(id)}/warm`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ provider: model.provider, model: model.model }),
      }).catch(() => undefined)
    },
    crash(afterMs = 1500) {
      return fetch(path('crash'), {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ after_ms: afterMs }),
      })
    },
    forget() {
      state = {}
      warmed = undefined
      used = 0
      queued.length = 0
      save()
    },
    async handToken() {
      const id = state.id ?? (warmed ??= identifier('web'))
      const response = await fetch(path('hands', { id }), { method: 'POST', headers: headers() })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      return { session: id, token: ((await response.json()) as { token: string }).token }
    },
    async hand(): Promise<HandAccess | undefined> {
      const { session, token } = await this.handToken()
      return {
        url: socketUrl(`${base}sessions/${encodeURIComponent(session)}/hands/machine`),
        token,
      }
    },
    async hands() {
      const id = state.id ?? warmed
      if (!id) return []
      const response = await fetch(path('hands', { id }), { headers: headers() }).catch(
        () => undefined,
      )
      if (!response?.ok) return []
      return ((await response.json()) as { hands?: string[] }).hands ?? []
    },
    async health() {
      const open = await fetch(`${base}health`).catch(() => undefined)
      return open?.ok
        ? open
        : await fetch(`${base}health`, { headers: headers() }).catch(() => undefined)
    },
  }
}

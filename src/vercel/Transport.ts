/**
 * Browser transport for a nanocode deployment on Vercel: prompts over `POST`, and events over a resumable event stream.
 *
 * @module
 */
import {
  type Attachment,
  attachedPrompt,
  type HandAccess,
  type HandSource,
  type LiveEvent,
  serverEvents,
  socketUrl,
  type Transport as ClientTransport,
  type TransportParameters,
} from '../client.ts'
import * as Files from '../internal/Files.ts'

/** Largest total size in bytes of the attachments of one message. */
export const attachmentBytes = 3 * 1024 * 1024

/** Event stream cursor of a session's first event. */
export const firstCursor = '0.0'

/** Model choice that a new session sends. */
export type Selection = {
  /** Reasoning effort. Defaults to the model's effort. */
  effort?: string
  /** Harness ID. */
  harness: string
  /** Model ID. */
  model: string
}

/** Saved state of the transport's session. */
export type Session = {
  /** Event stream cursor of the last event read. */
  cursor?: string
  /** Hand channel of the session. */
  hand?: string
  /** Session ID, once the server started the session. */
  id?: string
  /** Whether a turn is in flight. */
  open?: boolean
}

/** Transport of a deployment on Vercel, with its session and hand operations. */
export type Transport = ClientTransport &
  HandSource & {
    /** Arms a crash of the session's drive, for tests of a deployment with `chaos`. */
    crash(options?: { at?: 'tool' | 'any'; afterMs?: number }): Promise<Response>
    /** Clears the session. */
    forget(): void
    /** Returns the names of the hands attached to the session. */
    hands(): Promise<(string | null)[]>
    /** Starts the session when it has none, and returns its ID. */
    open(): Promise<string | undefined>
    /** Returns the session state. */
    session(): Session
    /** Starts a session for the current selection ahead of the first prompt. */
    warm(): void
  }

/** Returns a browser transport that talks to the route handlers of `App.create`. */
export function create(options: create.Options): Transport {
  const url = options.url ?? '/api/chat'
  const reconnectMs = options.reconnectMs ?? 1000
  let state: Session = options.session?.load() ?? {}
  let warmed: { key: string; session: Promise<string | undefined> } | undefined
  const pending = new Map<string, { bytes: Uint8Array; type: string }>()

  const save = (session = state) => {
    if (session === state) options.session?.save(state)
  }
  const headers = (extra: Record<string, string> = {}) => ({ ...extra, ...options.headers?.() })
  const key = () => {
    const selection = options.selection()
    return `${selection.harness}/${selection.model}/${selection.effort ?? ''}`
  }
  const chosen = () => {
    const selection = options.selection()
    return {
      harness: selection.harness,
      model: selection.model,
      ...(selection.effort ? { effort: selection.effort } : {}),
    }
  }
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

  const follow = async (
    response: Response,
    parameters: Omit<TransportParameters, 'prompt'>,
    session: Session,
  ): Promise<boolean> => {
    const { signal } = parameters
    if (!response.ok || !response.body) {
      if (signal?.aborted) return true
      parameters.note('error', `${response.status} ${await response.text()}`)
      return true
    }
    try {
      for await (const message of serverEvents(response.body)) {
        if (signal?.aborted) break
        if (message.id) {
          session.cursor = message.id
          save(session)
        }
        if (message.event === 'end') return true
        if (message.data) parameters.push(JSON.parse(message.data) as LiveEvent)
      }
    } catch {
      if (signal?.aborted) return true
      parameters.note('tool', 'The stream dropped. Reconnecting from the last event.')
      return false
    }
    if (signal?.aborted) {
      void response.body.cancel().catch(() => undefined)
      return true
    }
    return false
  }

  const channel = () =>
    options.hands
      ? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
      : undefined
  const begun = new Map<string, string>()
  const adopt = (session: Session, id: string) => {
    session.id = id
    const hand = begun.get(id)
    if (hand) session.hand = hand
  }

  const begin = async (hand: string | undefined, signal?: AbortSignal) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ ...chosen(), ...(hand ? { hand } : {}), warm: true }),
      ...(signal ? { signal } : {}),
    })
    const id = response.ok
      ? ((await response.json()) as { sessionId?: string }).sessionId
      : undefined
    if (id && hand) begun.set(id, hand)
    return id
  }

  const prepare = async () => {
    const hand = (await options.hand?.().catch(() => undefined)) ?? channel()
    const id = await begin(hand).catch(() => undefined)
    if (id && hand && options.hand) await options.hand(id).catch(() => undefined)
    return id
  }

  const reconnect = async (
    id: string,
    parameters: Omit<TransportParameters, 'prompt'>,
    session: Session,
  ) => {
    const { signal } = parameters
    let delay = reconnectMs
    session.cursor ??= firstCursor
    if (session.cursor.endsWith(';end')) return
    while (!signal?.aborted) {
      const response = await fetch(
        `${url}?sessionId=${encodeURIComponent(id)}&cursor=${encodeURIComponent(session.cursor)}`,
        { headers: headers(), signal },
      ).catch(() => undefined)
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
      if (response && (await follow(response, parameters, session))) return
      delay = response ? reconnectMs : Math.min(delay * 2, 15_000)
      await pause(signal, delay)
    }
  }

  const encoded = (attachments: readonly Attachment[] = []) => {
    const files = attachments.flatMap((item) => {
      const found = pending.get(item.path)
      if (!found) return []
      let binary = ''
      for (let index = 0; index < found.bytes.length; index += 0x8000)
        binary += String.fromCharCode(...found.bytes.subarray(index, index + 0x8000))
      return [{ path: item.path, data: btoa(binary) }]
    })
    return files.length ? { attachments: files } : {}
  }

  return {
    files: {
      maxBytes: attachmentBytes,
      scope: () => state.id,
      async upload(file, name) {
        if (file.size > attachmentBytes)
          throw new Error(`attachments are at most ${attachmentBytes} bytes here`)
        const bytes = new Uint8Array(await file.arrayBuffer())
        const safe = Files.safeName(name)
        const dot = safe.lastIndexOf('.')
        const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
        const chosen =
          dot > 0 ? `${safe.slice(0, dot)}-${suffix}${safe.slice(dot)}` : `${safe}-${suffix}`
        const type = Files.sniff(bytes).split(';')[0]!
        const path = `/workspace/uploads/${chosen}`
        pending.set(path, { bytes, type })
        return { name: chosen, path, type, size: bytes.length }
      },
      async read(file, signal) {
        const local = pending.get(file)
        if (local)
          return new Blob([local.bytes.slice().buffer as ArrayBuffer], { type: local.type })
        if (!state.id) throw new Error('no session yet')
        const response = await fetch(
          `${url}?sessionId=${encodeURIComponent(state.id)}&file=${encodeURIComponent(file)}`,
          { headers: headers(), ...(signal ? { signal } : {}) },
        )
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
        return await response.blob()
      },
    },
    async send({ prompt: typed, attachments, push, note, changed, signal }: TransportParameters) {
      const prompt = attachedPrompt(typed, attachments)
      const total = (attachments ?? []).reduce(
        (sum, item) => sum + (pending.get(item.path)?.bytes.length ?? 0),
        0,
      )
      if (total > attachmentBytes)
        throw new Error(`a message carries at most ${attachmentBytes} bytes of attachments here`)
      const carried = encoded(attachments)
      const session = state
      session.open = true
      save(session)
      const started = !session.id && warmed?.key === key() ? await warmed.session : undefined
      warmed = undefined
      let existing = session.id ?? started
      try {
        let hand = await options.hand?.(existing)
        if (signal?.aborted) return
        if (!existing) {
          hand ??= channel()
          existing = await begin(hand, signal).catch(() => undefined)
          if (signal?.aborted) return
          if (existing && hand && options.hand) hand = await options.hand(existing)
        }
        if (existing && existing !== session.id) {
          adopt(session, existing)
          save(session)
          changed?.()
        }
        const response = await fetch(url, {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(
            existing
              ? { sessionId: existing, text: prompt, ...carried }
              : { ...chosen(), ...(hand ? { hand } : {}), text: prompt, ...carried },
          ),
          signal,
        }).catch((error: unknown) => {
          if (signal?.aborted) return undefined
          throw error
        })
        if (!response) return
        const id = response.headers.get('x-session-id') ?? existing
        if (id && id !== session.id) {
          session.id = id
          save(session)
        }
        if (!(await follow(response, { push, note, signal }, session)) && id)
          await reconnect(id, { push, note, signal }, session)
      } finally {
        if (!signal?.aborted) {
          session.open = false
          save(session)
        }
      }
    },
    async steer({ prompt }: TransportParameters) {
      if (!state.id) return false
      const kind = /^\/effort\s/.test(prompt) ? 'prompt' : 'steer'
      const response = await fetch(url, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ kind, sessionId: state.id, text: prompt }),
      })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      void response.body?.cancel()
      return false
    },
    async cancel() {
      if (!state.open || !state.id) return
      const response = await fetch(url, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ kind: 'cancel', sessionId: state.id }),
      })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    },
    async resume({ push, note, signal }) {
      const session = state
      if (!session.open || !session.id) return
      try {
        await reconnect(session.id, { push, note, signal }, session)
      } finally {
        if (!signal?.aborted) {
          session.open = false
          save(session)
        }
      }
    },
    session: () => state,
    snapshot: () => ({ ...state }),
    restore(saved) {
      state = saved && typeof saved === 'object' ? { ...(saved as Session) } : {}
      warmed = undefined
    },
    warm() {
      if (state.id || warmed?.key === key()) return
      const session = prepare()
      warmed = { key: key(), session }
    },
    async open() {
      const session = state
      if (session.id) return session.id
      const pending = warmed?.key === key() ? warmed.session : prepare()
      warmed = { key: key(), session: pending }
      const id = await pending
      if (warmed?.session === pending) warmed = undefined
      if (id && !session.id) {
        adopt(session, id)
        save(session)
      }
      return session.id
    },
    async hand(): Promise<HandAccess | undefined> {
      const id = await this.open()
      const hand = state.hand
      if (!id || !hand || state.id !== id) return undefined
      return { url: `${socketUrl(url)}?sessionId=${encodeURIComponent(id)}`, token: hand }
    },
    async hands() {
      if (!state.id) return []
      const response = await fetch(`${url}?sessionId=${encodeURIComponent(state.id)}&hands`, {
        headers: headers(),
      })
      if (!response.ok) return []
      return ((await response.json()) as { hands?: (string | null)[] }).hands ?? []
    },
    crash(crash = {}) {
      return fetch(options.chaosUrl ?? url.replace(/chat$/, 'chaos'), {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          sessionId: state.id,
          at: crash.at ?? 'tool',
          afterMs: crash.afterMs ?? 1500,
        }),
      })
    },
    forget() {
      state = {}
      warmed = undefined
      save()
    },
  }
}

export declare namespace create {
  type Options = {
    /** Chaos route. Defaults to `url` with `chat` replaced by `chaos`. */
    chaosUrl?: string
    /** Returns the hand channel for a session, or for a new session without `session`. */
    hand?(session?: string): Promise<string | undefined>
    /** Whether new sessions get a random hand channel. */
    hands?: boolean
    /** Returns headers that every request carries. */
    headers?(): Record<string, string>
    /** Base delay in milliseconds before a reconnect. Defaults to 1000. */
    reconnectMs?: number
    /** Returns the model choice of a new session. */
    selection(): Selection
    /** Loads and saves the session state. */
    session?: { load(): Session; save(session: Session): void }
    /** Chat route. Defaults to `/api/chat`. */
    url?: string
  }
}

import * as LiveEvent from './LiveEvent.ts'
import * as Tool from './Tool.ts'
import * as Transcript from './Transcript.ts'
import type * as Transport from './Transport.ts'

export type Config = {
  readonly cancellable: boolean
  readonly detachable: boolean
  readonly files: Transport.Files | undefined
  cancel(): Promise<void>
  clear(): void
  create(): string | undefined
  getState(): State
  getServerState(): State
  note(kind: Transcript.EntryKind, text: string): void
  push(event: LiveEvent.LiveEvent): void
  remove(id: string): void
  reset(): void
  resume(): Promise<void>
  run(callback: () => void): void
  select(id: string): void
  send(prompt: string, attachments?: readonly Transport.Attachment[]): Promise<void>
  subscribe(listener: () => void): () => void
}

export type Conversation = {
  id: string
  title: string
  updated: number
}

export type HistoryStorage = {
  getItem(key: string): string | null
  removeItem(key: string): void
  setItem(key: string, value: string): void
}

export type State = {
  entries: readonly Transcript.Entry[]
  live: readonly Transcript.Entry[]
  status: Status
  error: Error | undefined
  conversations: readonly Conversation[]
  conversation: string | undefined
}

export type Status = 'idle' | 'pending'

type TabLocks = {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>
}

type TabChannel = {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

type TabMessage =
  | {
      type: 'state'
      id: string
      status: Status
      entries?: readonly Transcript.Entry[]
      live?: readonly Transcript.Entry[]
    }
  | { type: 'hello' | 'cancel'; id: string }
  | { type: 'send'; id: string; prompt: string }

function conversationId(): string {
  const random = (globalThis as { crypto?: { randomUUID?(): string } }).crypto?.randomUUID?.()
  return random ?? Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export function create(options: create.Options): Config {
  const listeners = new Set<() => void>()
  const history = options.history && {
    key: options.history.key,
    storage:
      options.history.storage ?? (globalThis as { localStorage?: HistoryStorage }).localStorage,
    limit: options.history.limit ?? 50,
  }
  const read = <T>(key: string, fallback: T): T => {
    try {
      const value = history?.storage?.getItem(key)
      return value ? (JSON.parse(value) as T) : fallback
    } catch {
      return fallback
    }
  }
  const write = (key: string, value: unknown): boolean => {
    try {
      history?.storage?.setItem(key, JSON.stringify(value))
      return true
    } catch {
      return false
    }
  }
  const indexKey = () => `${history!.key}:history`
  const entriesKey = (id: string) => `${history!.key}:entries:${id}`
  const transportKey = (id: string) => `${history!.key}:transport:${id}`
  const liveKey = (id: string) => `${history!.key}:live:${id}`
  const lockName = (id: string) => `${history!.key}:turn:${id}`
  const scope = globalThis as {
    navigator?: { locks?: TabLocks }
    BroadcastChannel?: new (name: string) => TabChannel
  }
  const locks = history ? scope.navigator?.locks : undefined
  const channel =
    history && locks && scope.BroadcastChannel
      ? new scope.BroadcastChannel(`nanocode:${history.key}`)
      : undefined
  const coordinated = Boolean(locks && channel)
  const stale = new Set<string>()
  const leases = new Map<string, Promise<void>>()
  let owned: string | undefined
  let following: { id: string; abort: AbortController } | undefined
  let claiming = false
  let fresh = false
  let conversations: Conversation[] = []
  let current: string | undefined
  if (history) {
    const saved = read<{ current?: string; conversations?: Conversation[] }>(indexKey(), {})
    conversations = (saved.conversations ?? []).filter(
      (item) => item && typeof item.id === 'string',
    )
    current =
      saved.current && conversations.some((item) => item.id === saved.current)
        ? saved.current
        : conversations[0]?.id
    if (!current) {
      current = conversationId()
      conversations = [{ id: current, title: '', updated: Date.now() }]
      fresh = true
    }
    options.transport.restore?.(read(transportKey(current), undefined))
  }
  let state: State = {
    entries: history
      ? read<Transcript.Entry[]>(entriesKey(current!), [])
      : (options.persist?.load() ?? []),
    live: [],
    status: 'idle',
    error: undefined,
    conversations,
    conversation: current,
  }
  const server: State = {
    entries: [],
    live: [],
    status: 'idle',
    error: undefined,
    conversations: history && current ? [{ id: current, title: '', updated: 0 }] : [],
    conversation: current,
  }
  const set = (next: Partial<State>) => {
    state = { ...state, ...next }
    for (const listener of [...listeners]) listener()
  }
  const saveIndex = () => {
    if (history) write(indexKey(), { current, conversations })
  }
  const foreign = (id: string, view?: View) =>
    following?.id === id || (stale.has(id) && owned !== id && !view?.release)
  const saveTransport = () => {
    if (history && current && options.transport.snapshot && !foreign(current, views.get(current)))
      write(transportKey(current), options.transport.snapshot())
  }
  const post = (message: TabMessage) => {
    try {
      channel?.postMessage(message)
    } catch {}
  }
  const outbox = new Map<
    string,
    { entries?: readonly Transcript.Entry[]; live?: readonly Transcript.Entry[] }
  >()
  let flushing: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (flushing !== undefined) clearTimeout(flushing)
    flushing = undefined
    for (const [id, part] of outbox)
      post({ type: 'state', id, status: owned === id ? 'pending' : 'idle', ...part })
    outbox.clear()
  }
  const announce = (
    id: string | undefined,
    part: { entries?: readonly Transcript.Entry[]; live?: readonly Transcript.Entry[] },
  ) => {
    if (!channel || !id || owned !== id) return
    outbox.set(id, { ...outbox.get(id), ...part })
    flushing ??= setTimeout(flush, 16)
  }
  type View = {
    transcript: Transcript.Transcript
    live: Transcript.Entry[]
    entries?: Transcript.Entry[]
    pushed?: unknown
    processed?: unknown
    dirty: boolean
    saved: number
    timer?: ReturnType<typeof setTimeout>
    release?: () => void
  }
  const views = new Map<string | undefined, View>()
  const snapshots = new WeakMap<LiveEvent.LiveEvent, unknown>()
  const evict = (id: string, key: string, value: unknown): boolean => {
    while (!write(key, value)) {
      const oldest = [...conversations]
        .reverse()
        .find((item) => item.id !== id && item.id !== current)
      if (!oldest) return false
      forget(oldest.id)
      conversations = conversations.filter((item) => item.id !== oldest.id)
      saveIndex()
    }
    return true
  }
  const persist = (id: string | undefined, view: View) => {
    if (view.timer !== undefined) clearTimeout(view.timer)
    view.timer = undefined
    if (!history || !id || !conversations.some((item) => item.id === id)) return
    const entries = view.entries
    view.entries = undefined
    if (entries) evict(id, entriesKey(id), entries)
    if (foreign(id, view)) return
    const snapshot = !options.transport.snapshot
      ? undefined
      : view.transcript.pending()
        ? view.processed
        : id === current
          ? options.transport.snapshot()
          : view.pushed
    if (snapshot === undefined) return
    view.dirty = false
    view.saved = Date.now()
    const live = view.transcript.state()
    const idle = !live.running.length && !live.stream.text && !live.orphans.length
    if (
      !evict(
        id,
        liveKey(id),
        idle
          ? {
              running: [],
              stream: { posted: 0, text: '' },
              links: [],
              orphans: [],
              ended: live.ended?.slice(-64),
              seen: live.seen,
            }
          : live,
      )
    ) {
      try {
        history.storage?.removeItem(liveKey(id))
      } catch {}
    }
    write(transportKey(id), snapshot)
  }
  const schedule = (id: string | undefined, view: View) => {
    view.timer ??= setTimeout(() => persist(id, view), view.dirty ? 0 : 250)
  }
  const drop = (id: string | undefined) => {
    const found = views.get(id)
    views.delete(id)
    found?.release?.()
    found?.transcript.reset()
  }
  const entriesOf = (id: string): readonly Transcript.Entry[] =>
    id === current
      ? state.entries
      : (views.get(id)?.entries ?? read<Transcript.Entry[]>(entriesKey(id), []))
  const clean = (found: View | undefined) =>
    !found || !(found.entries || found.release || found.transcript.pending())
  const sync = (id: string) => {
    if (!stale.has(id) || !clean(views.get(id))) return
    stale.delete(id)
    const found = views.get(id)
    if (found?.timer !== undefined) clearTimeout(found.timer)
    drop(id)
    if (id !== current) return
    options.transport.restore?.(read(transportKey(id), undefined))
    set({ entries: read<Transcript.Entry[]>(entriesKey(id), []), live: view(id).live })
  }
  const forget = (id: string) => {
    drop(id)
    for (const key of [entriesKey(id), transportKey(id), liveKey(id)])
      try {
        history?.storage?.removeItem(key)
      } catch {}
  }
  const add = (id: string | undefined, entry: Transcript.Entry) => {
    if (!history) {
      const entries = [...state.entries, entry].slice(-(options.keep ?? 500))
      options.persist?.save(entries)
      set({ entries })
      return
    }
    const shown = id === current
    const existing = conversations.find((item) => item.id === id)
    if (!existing && !shown) return
    const target = views.get(id)
    const entries = [
      ...(shown
        ? state.entries
        : (target?.entries ?? read<Transcript.Entry[]>(entriesKey(id!), []))),
      entry.tool ? { ...entry, tool: Tool.clip(entry.tool, { limit: 65_536 }) } : entry,
    ].slice(-(options.keep ?? 500))
    store(id!, entries, target)
  }
  const store = (id: string, entries: Transcript.Entry[], target: View | undefined) => {
    const shown = id === current
    if (following?.id === id) {
      if (shown) set({ entries })
      return
    }
    if (shown) fresh = false
    announce(id, { entries })
    const existing = conversations.find((item) => item.id === id)
    const entry = entries[entries.length - 1]
    if (target) target.entries = entries
    else evict(id, entriesKey(id), entries)
    const title =
      existing?.title ||
      (entry?.kind === 'user'
        ? (entry.text || entry.attachments?.map((item) => item.name).join(', ') || '')
            .replace(/\s+/g, ' ')
            .slice(0, 80)
        : '')
    conversations = [
      { id, title, updated: Date.now() },
      ...conversations.filter((item) => item.id !== id),
    ]
    for (const dropped of conversations.slice(history!.limit)) forget(dropped.id)
    conversations = conversations.slice(0, history!.limit)
    saveIndex()
    if (target) {
      target.dirty = true
      schedule(id, target)
    }
    if (!shown) return set({ conversations })
    if (!target) saveTransport()
    set({ entries, conversations })
  }
  const end = (id: string | undefined, status: Tool.Status) => {
    const target = views.get(id)
    const entries =
      id === current
        ? state.entries
        : (target?.entries ?? (history && id ? read<Transcript.Entry[]>(entriesKey(id), []) : []))
    let start = entries.length
    while (start > 0 && !(entries[start - 1]!.kind === 'user' && !entries[start - 1]!.steer))
      start--
    const final = status === 'completed' ? 'completed' : 'cancelled'
    const settle = (cell: Tool.Cell): Tool.Cell =>
      cell.status === 'yielded' ||
      cell.status === 'running' ||
      cell.children.some((child) => settle(child) !== child)
        ? {
            ...cell,
            status: cell.status === 'yielded' || cell.status === 'running' ? final : cell.status,
            children: cell.children.map(settle),
          }
        : cell
    let changed = false
    const next = entries.map((entry, index) => {
      if (index < start || !entry.tool) return entry
      const tool = settle(entry.tool)
      if (tool === entry.tool) return entry
      changed = true
      return { ...entry, tool, text: Tool.summary(tool) }
    })
    if (!changed) return
    if (!history) {
      options.persist?.save(next)
      return set({ entries: next })
    }
    if (!id) return
    store(id, next, target)
  }
  const view = (id = current): View => {
    let found = views.get(id)
    if (found) return found
    const created: View = {
      dirty: false,
      live: [],
      saved: 0,
      transcript: Transcript.create({
        add: (entry) => add(id, entry),
        end: (status) => end(id, status),
        checkpoint: (event) => {
          created.processed = snapshots.has(event) ? snapshots.get(event) : created.processed
          if (created.dirty || Date.now() - created.saved >= 250) persist(id, created)
          else schedule(id, created)
        },
        live: (live) => {
          created.live = live
          if (id === current && following?.id !== id) set({ live })
          announce(id, { live })
        },
        apply: (event) => {
          if (id === current) options.apply?.(event)
        },
        revealMs: options.revealMs,
        reducedMotion: () => {
          const media = (globalThis as { matchMedia?: (query: string) => { matches: boolean } })
            .matchMedia
          return typeof media === 'function' && media('(prefers-reduced-motion: reduce)').matches
        },
      }),
    }
    views.set(id, created)
    if (history && id)
      created.transcript.restore(read<Transcript.State | undefined>(liveKey(id), undefined))
    return created
  }
  const note = (kind: Transcript.EntryKind, text: string) => {
    const started_at = Date.now()
    const target = current
    view().transcript.run(() => add(target, { kind, text, started_at }))
  }
  const push = (event: LiveEvent.LiveEvent) => {
    const target = view()
    target.pushed = options.transport.snapshot?.()
    snapshots.set(event, target.pushed)
    target.transcript.push(event)
  }
  let generation = 0
  let controller: AbortController | undefined
  const parameters = (
    prompt: string,
    id: number,
    signal: AbortSignal,
    attachments?: readonly Transport.Attachment[],
  ): Transport.Parameters => ({
    prompt,
    ...(attachments?.length ? { attachments } : {}),
    signal,
    push: (event) => {
      if (id === generation) push(event)
    },
    note: (kind, text) => {
      if (id === generation) note(kind, text)
    },
    changed: () => {
      if (id === generation) saveTransport()
    },
  })
  const detachable = () => Boolean(history && options.transport.resume)
  const detach = () => {
    if (state.status !== 'pending') return
    owned = undefined
    generation += 1
    controller?.abort()
    controller = undefined
  }
  const settle = (
    start: (parameters: Transport.Parameters) => Promise<void>,
    prompt = '',
    attachments?: readonly Transport.Attachment[],
    free: () => void = () => undefined,
  ) => {
    const id = ++generation
    controller?.abort()
    const signal = (controller = new AbortController()).signal
    const conversation = current
    const shown = view()
    const transcript = shown.transcript
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      if (shown.release === finish) shown.release = undefined
      if (conversation && owned === conversation) {
        owned = undefined
        flush()
        post({
          type: 'state',
          id: conversation,
          status: 'idle',
          entries: entriesOf(conversation),
          live: [],
        })
      }
      free()
    }
    shown.release = finish
    owned = conversation
    set({ status: 'pending', error: undefined })
    announce(conversation, { entries: state.entries, live: shown.live })
    let work: Promise<void>
    try {
      work = start(parameters(prompt, id, signal, attachments))
    } catch (error) {
      work = Promise.reject(error)
    }
    return work
      .catch((error: unknown) => {
        if (id !== generation) return
        const failure = error instanceof Error ? error : new Error(String(error))
        note('error', failure.message)
        set({ error: failure })
      })
      .finally(() => {
        const leave = () => {
          if (conversation) persist(conversation, shown)
          finish()
        }
        if (id !== generation) return transcript.run(leave)
        transcript.close()
        transcript.run(() => {
          if (id !== generation) return leave()
          controller = undefined
          const now = views.get(current)
          if (now) persist(current, now)
          else saveTransport()
          set({ status: 'idle' })
          finish()
        })
      })
  }
  const lease = (id: string | undefined, waitMs: number): Promise<(() => void) | undefined> => {
    if (!locks || !channel || id === undefined) return Promise.resolve(() => undefined)
    const lockManager = locks
    return (leases.get(id) ?? Promise.resolve()).then(
      () =>
        new Promise((resolve) => {
          let granted = false
          lockManager
            .request(lockName(id), { signal: AbortSignal.timeout(waitMs) }, () => {
              granted = true
              let free: () => void = () => undefined
              const held = new Promise<void>((release) => {
                free = () => {
                  if (leases.get(id) === held) leases.delete(id)
                  release()
                }
              })
              leases.set(id, held)
              resolve(free)
              return held
            })
            .catch(() => {
              if (!granted) resolve(undefined)
            })
        }),
    )
  }
  const unfollow = () => {
    following?.abort.abort()
    following = undefined
  }
  const follow = (id: string) => {
    if (!locks || !channel || following?.id === id || owned === id) return
    unfollow()
    const abort = new AbortController()
    following = { id, abort }
    if (id === current) set({ status: 'pending', error: undefined })
    post({ type: 'hello', id })
    locks
      .request(lockName(id), { signal: abort.signal }, () => {
        if (following?.abort !== abort) return
        following = undefined
        stale.add(id)
        if (id !== current) return
        sync(id)
        set({ status: 'idle' })
        setTimeout(() => void config.resume())
      })
      .catch(() => undefined)
  }
  const claim = async (
    target: string | undefined,
    waitMs: number,
  ): Promise<(() => void) | undefined> => {
    claiming = true
    try {
      return await lease(target, waitMs)
    } finally {
      claiming = false
    }
  }
  const open = (id: string, entries: Transcript.Entry[], resume = true) => {
    const detached = state.status === 'pending'
    detach()
    unfollow()
    fresh = false
    const leaving = views.get(current)
    if (leaving && conversations.some((item) => item.id === current)) persist(current, leaving)
    else if (conversations.some((item) => item.id === current)) saveTransport()
    if (!detached) drop(current)
    current = id
    if (stale.has(id) && clean(views.get(id))) {
      drop(id)
      stale.delete(id)
    }
    options.transport.restore?.(read(transportKey(id), undefined))
    saveIndex()
    set({
      conversation: id,
      conversations: [...conversations],
      entries,
      live: view(id).live,
      status: 'idle',
      error: undefined,
    })
    if (resume) void config.resume()
  }
  const config: Config = {
    getState: () => state,
    getServerState: () => server,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async send(prompt, attachments) {
      const text = prompt.trim()
      const attached = attachments?.length
        ? attachments.map((item) => ({
            name: item.name,
            path: item.path,
            type: item.type,
            size: item.size,
          }))
        : undefined
      if (!text && !attached) return
      if (claiming) return
      if (current && following?.id === current) {
        if (attached)
          note(
            'error',
            'Attachments go with a new message. Send them when the running turn finishes.',
          )
        else post({ type: 'send', id: current, prompt: text })
        return
      }
      if (state.status === 'pending' && attached) {
        note(
          'error',
          'Attachments go with a new message. Send them when the running turn finishes.',
        )
        return
      }
      if (state.status === 'pending') {
        const transcript = view().transcript
        transcript.aside({ kind: 'user', text, started_at: Date.now(), steer: true })
        if (!options.transport.steer || !controller) return
        try {
          if (await options.transport.steer(parameters(text, generation, controller.signal)))
            transcript.aside({
              kind: 'tool',
              text: 'steered into the running turn',
              started_at: Date.now(),
            })
        } catch (error) {
          note('error', error instanceof Error ? error.message : String(error))
        }
        return
      }
      const started_at = Date.now()
      const target = current
      let free: (() => void) | undefined = () => undefined
      if (coordinated && target) {
        set({ status: 'pending', error: undefined })
        free = await claim(target, 3000)
        if (target !== current) return free?.()
        if (!free) {
          follow(target)
          if (attached)
            note(
              'error',
              'Another tab is running a turn in this conversation. Send the attachments when it finishes.',
            )
          else post({ type: 'send', id: target, prompt: text })
          return
        }
        owned = target
      }
      if (target) sync(target)
      view().transcript.run(() =>
        add(target, {
          kind: 'user',
          text,
          started_at,
          ...(attached ? { attachments: attached } : {}),
        }),
      )
      await settle((parameters) => options.transport.send(parameters), text, attached, free)
    },
    async resume() {
      const resume = options.transport.resume?.bind(options.transport)
      if (!resume || state.status === 'pending' || claiming) return
      const target = current
      let free: (() => void) | undefined = () => undefined
      if (coordinated && target) {
        free = await claim(target, 250)
        if (target !== current || config.getState().status === 'pending') return free?.()
        if (!free) return follow(target)
      }
      if (target) sync(target)
      await settle(({ push, note, signal }) => resume({ push, note, signal }), '', undefined, free)
    },
    async cancel() {
      if (current && following?.id === current) return post({ type: 'cancel', id: current })
      if (!options.transport.cancel || state.status !== 'pending') return
      try {
        await options.transport.cancel()
      } catch (error) {
        note('error', error instanceof Error ? error.message : String(error))
      }
    },
    cancellable: Boolean(options.transport.cancel),
    files: options.transport.files,
    get detachable() {
      return detachable()
    },
    push,
    run: (callback) => view().transcript.run(callback),
    note,
    clear() {
      if (history) {
        config.create()
        return
      }
      view().transcript.reset()
      options.persist?.save([])
      set({ entries: [], live: [], error: undefined })
    },
    reset() {
      view().transcript.reset()
      set({ live: [], status: 'idle' })
    },
    select(id) {
      if (
        !history ||
        id === current ||
        (state.status === 'pending' && !detachable() && !following) ||
        !conversations.some((item) => item.id === id)
      )
        return
      open(id, views.get(id)?.entries ?? read<Transcript.Entry[]>(entriesKey(id), []))
    },
    create() {
      if (!history || (state.status === 'pending' && !detachable() && !following)) return current
      if (!state.entries.length) return current
      const id = conversationId()
      conversations = [{ id, title: '', updated: Date.now() }, ...conversations].slice(
        0,
        history.limit,
      )
      open(id, [], false)
      return id
    },
    remove(id) {
      if (!history) return
      if (id !== current) {
        forget(id)
        conversations = conversations.filter((item) => item.id !== id)
        saveIndex()
        set({ conversations: [...conversations] })
        return
      }
      if (state.status === 'pending') {
        if (!detachable() && !following) return
        if (following?.id === id) post({ type: 'cancel', id })
        else options.transport.cancel?.().catch(() => undefined)
        detach()
      }
      forget(id)
      conversations = conversations.filter((item) => item.id !== id)
      const next = conversations[0]
      if (next) open(next.id, read<Transcript.Entry[]>(entriesKey(next.id), []))
      else {
        conversations = [{ id: conversationId(), title: '', updated: Date.now() }]
        open(conversations[0].id, [], false)
      }
    },
  }
  if (history) {
    state = { ...state, live: view(current).live }
    const target = globalThis as {
      addEventListener?: (type: string, listener: (event: Event) => void) => void
    }
    target.addEventListener?.('pagehide', () => {
      for (const [id, entry] of views)
        if (entry.dirty || entry.entries || entry.timer !== undefined || entry.release)
          persist(id, entry)
    })
    const index = () => {
      const saved = read<{ current?: string; conversations?: Conversation[] }>(indexKey(), {})
      const list = (saved.conversations ?? []).filter((item) => item && typeof item.id === 'string')
      if (
        fresh &&
        !state.entries.length &&
        state.status !== 'pending' &&
        saved.current &&
        saved.current !== current &&
        list.some((item) => item.id === saved.current)
      ) {
        conversations = list
        open(saved.current, read<Transcript.Entry[]>(entriesKey(saved.current), []))
        return
      }
      const kept = conversations.find((item) => item.id === current)
      conversations = kept && !list.some((item) => item.id === current) ? [kept, ...list] : list
      set({ conversations: [...conversations] })
    }
    target.addEventListener?.('storage', (event) => {
      const { key, storageArea } = event as unknown as { key: string | null; storageArea: unknown }
      const prefix = `${history.key}:`
      if ((storageArea && storageArea !== history.storage) || !key?.startsWith(prefix)) return
      const rest = key.slice(prefix.length)
      if (rest === 'history') return index()
      const match = /^(entries|transport|live):(.+)$/.exec(rest)
      if (!match) return
      const id = match[2]!
      stale.add(id)
      if (
        match[1] === 'entries' &&
        id === current &&
        owned !== id &&
        following?.id !== id &&
        state.status !== 'pending'
      )
        set({ entries: read<Transcript.Entry[]>(entriesKey(id), []) })
    })
    channel?.addEventListener('message', (event) => {
      const message = event.data as TabMessage
      if (!message || typeof message.id !== 'string') return
      if (message.type === 'hello') {
        if (message.id === owned)
          post({
            type: 'state',
            id: owned,
            status: 'pending',
            entries: entriesOf(owned),
            live: views.get(owned)?.live ?? [],
          })
        return
      }
      if (message.type === 'send' || message.type === 'cancel') {
        if (message.id !== owned || owned !== current) return
        if (message.type === 'send') void config.send(message.prompt)
        else void config.cancel()
        return
      }
      if (message.type !== 'state' || message.id === owned) return
      stale.add(message.id)
      if (message.id !== current) return
      if (message.status === 'pending') follow(message.id)
      if (following?.id !== message.id) {
        if (message.entries && state.status !== 'pending') set({ entries: [...message.entries] })
        return
      }
      set({
        ...(message.entries ? { entries: [...message.entries] } : {}),
        ...(message.live ? { live: [...message.live] } : {}),
      })
    })
  }
  return config
}

export declare namespace create {
  type Options = {
    apply?(event: LiveEvent.LiveEvent): void
    history?: History | undefined
    keep?: number | undefined
    persist?: {
      load(): readonly Transcript.Entry[]
      save(entries: readonly Transcript.Entry[]): void
    }
    revealMs?: number | undefined
    transport: Transport.Transport
  }

  type History = {
    key: string
    limit?: number | undefined
    storage?: HistoryStorage | undefined
  }
}

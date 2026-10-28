/**
 * Hands: a JavaScript host that runs a session's tools for a remote brain, over a WebSocket to its session.
 *
 * @module
 */
import { serverEvents } from './client.ts'
import * as AgentRuntime from './AgentRuntime.ts'
import * as Remote from './Remote.ts'
import type * as Contracts from './Contracts.ts'

/** Options of a hand. */
export type Options = {
  url: string
  name?: string
  workspace: Contracts.WorkspaceHost
  cwd?: string
  fetch?(input: string, init: RequestInit): Promise<Response>
  tools?: {
    definitions: Contracts.HostTool[]
    call(name: string, input: unknown, signal: AbortSignal): Promise<unknown>
  }
  mcpServers?: Contracts.McpServer[]
  mcp?: Contracts.RuntimeOptions['mcp']
  protocols?: string | string[]
  maxFrameBytes?: number
  WebSocket?: typeof WebSocket
  token?: string
  transport?: 'websocket' | 'stream'
  reconnectMs?: number
  batchMs?: number
  onStatus?(status: Status): void
}

/** Connection state of a hand, with the reason it closed. */
export type Status = { state: 'connecting' | 'attached' | 'closed'; reason?: string }

/** Connected hand. */
export type Hand = { closed: Promise<Status>; close(): void }

/** Hand whose module and workspace are open and which has not connected yet. */
export type Prepared = {
  cwd: string
  connect(url: string, onStatus?: (status: Status) => void, token?: string): Promise<Hand>
  dispose(): void
}

const NO_SQL = {
  transaction() {
    throw new Error('a hand runs no SQL')
  },
}

type ModuleCache = {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
  delete(key: string | Request): Promise<boolean>
  keys(): Promise<readonly Request[]>
}

type Compiler = {
  compileStreaming(source: Response): Promise<WebAssembly.Module>
  compile(bytes: ArrayBuffer): Promise<WebAssembly.Module>
}

/** Compiles the module from a response, through the cache when one is given. */
export async function compile(
  url: string,
  options: { cache?: string | false; key?: string } = {},
): Promise<WebAssembly.Module> {
  const key = options.key
    ? url + (url.includes('?') ? '&' : '?') + 'nanocode-key=' + encodeURIComponent(options.key)
    : url
  const caches =
    options.cache === false
      ? undefined
      : (globalThis as { caches?: { open(name: string): Promise<ModuleCache> } }).caches
  const store = await caches?.open(options.cache || 'nanocode-wasm').catch(() => undefined)
  const compiler = WebAssembly as unknown as Compiler
  const compile = async (response: Response) => {
    if (!response.ok) throw new Error(url + ' answered ' + response.status)
    if (response.headers.get('content-type')?.startsWith('application/wasm'))
      return compiler.compileStreaming(response)
    return compiler.compile(await response.arrayBuffer())
  }
  const hit = await store?.match(key).catch(() => undefined)
  if (hit) {
    try {
      return await compile(hit)
    } catch {
      await store!.delete(key).catch(() => false)
    }
  }
  const response = await fetch(url)
  if (store && response.ok) {
    const copy = response.clone()
    const stored = new Request(key).url
    void store
      .put(key, copy)
      .then(async () => {
        for (const request of await store.keys())
          if (request.url !== stored) await store.delete(request)
      })
      .catch(() => {})
  }
  return compile(response)
}

const HAND_REPLACED = 'another hand attached under this name'

function tokened(
  token: string | undefined,
  protocols: string | string[] | undefined,
  Socket: typeof WebSocket,
): { protocols?: string | string[]; init?: unknown } {
  if (!token) return protocols === undefined ? {} : { protocols }
  const node =
    Socket === globalThis.WebSocket &&
    typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
      ?.node === 'string'
  if (node)
    return {
      init: {
        headers: { authorization: `Bearer ${token}` },
        ...(protocols === undefined ? {} : { protocols }),
      },
    }
  return { protocols: Remote.bearerProtocols(token) }
}

/** Instantiates the module and opens the hand's workspace, catalog, and MCP servers without a connection. */
export async function prepare(
  module: WebAssembly.Module,
  options: Omit<Options, 'url' | 'onStatus'>,
): Promise<Prepared> {
  const runtime = await AgentRuntime.instantiate(module, NO_SQL, { published() {} })
  const send =
    options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init))
  const dispatch: Contracts.RuntimeOptions['dispatch'] = (request, signal) =>
    send(request.endpoint, {
      method: request.method,
      headers: request.headers,
      ...(request.method === 'GET' || request.method === 'HEAD'
        ? {}
        : { body: request.body as Uint8Array<ArrayBuffer> }),
      signal,
    })
  const cwd = options.cwd ?? '/workspace'
  let link:
    | { connection: number; send(text: string): void; close(code: number, reason: string): void }
    | undefined
  let hand: Awaited<ReturnType<AgentRuntime.AgentRuntime['serveHand']>>
  try {
    hand = await runtime.serveHand({
      workspace: options.workspace,
      cwd,
      fetch: send,
      dispatch,
      ...(options.tools
        ? {
            tools: {
              definitions: options.tools.definitions,
              call: (name, input, signal) => options.tools!.call(name, input, signal),
            },
          }
        : {}),
      ...(options.mcpServers?.length ? { mcp_servers: options.mcpServers } : {}),
      ...(options.mcp ? { mcp: options.mcp } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.maxFrameBytes ? { max_frame_bytes: options.maxFrameBytes } : {}),
      runtime_id: crypto.randomUUID(),
      send: (text, connection) => {
        if (link?.connection === connection) link.send(text)
      },
      failed: (reason, connection) => {
        if (link?.connection === connection) link.close(1011, reason.slice(0, 120))
      },
    })
  } catch (error) {
    void runtime.dispose().catch(() => {})
    throw error
  }
  let used = false
  return {
    cwd,
    dispose() {
      if (used) return
      used = true
      void runtime.dispose().catch(() => {})
    },
    async connect(url, onStatus, token = options.token) {
      if (used) throw new Error('a prepared hand connects once')
      used = true
      const Socket = options.WebSocket ?? globalThis.WebSocket
      let done!: (status: Status) => void
      const closed = new Promise<Status>((resolve) => {
        done = resolve
      })
      let finished = false
      let stopped = false
      let socket: WebSocket | undefined
      const finish = (reason: string) => {
        if (finished) return
        finished = true
        stopped = true
        void runtime.dispose().catch(() => {})
        const status: Status = { state: 'closed', reason }
        onStatus?.(status)
        done(status)
      }
      if (options.transport === 'stream') {
        const { catalog, connection } = await hand.connect()
        let queue = Promise.resolve()
        const receive = (text: string) => {
          queue = queue.then(() => hand.receive(text)).catch(() => {})
        }
        const gone = (reason: string) => {
          void hand.closed().catch(() => {})
          finish(reason)
        }
        const stream = await streamLink({ ...options, url }, catalog, receive, gone, closed)
        link = { connection, send: (text) => stream.send(text), close: () => stream.close() }
        onStatus?.({ state: 'attached' })
        return { closed, close: () => stream.close() }
      }
      const reconnectMs = options.reconnectMs ?? 500
      let delay = reconnectMs
      const attached = new Promise<void>((resolve, reject) => {
        const dial = () => {
          if (stopped) return
          const target = tokened(token, options.protocols, Socket)
          const current =
            target.init === undefined
              ? new Socket(url, target.protocols)
              : new (Socket as unknown as new (url: string, init: unknown) => WebSocket)(
                  url,
                  target.init,
                )
          socket = current
          let connection: number | undefined
          let ready = false
          const buffered: string[] = []
          const connecting = new Promise<void>((settled) => {
            current.addEventListener(
              'open',
              () => {
                void hand
                  .connect()
                  .then(
                    (opened) => {
                      connection = opened.connection
                      link = {
                        connection: opened.connection,
                        send: (text) => {
                          if (!ready) buffered.push(text)
                          else if (current.readyState === 1) current.send(text)
                        },
                        close: (code, reason) => {
                          try {
                            current.close(code, reason)
                          } catch {}
                        },
                      }
                      current.send(opened.catalog)
                      ready = true
                      for (const text of buffered.splice(0)) current.send(text)
                    },
                    (error: unknown) => {
                      try {
                        current.close(1011, 'the hand could not open a connection')
                      } catch {}
                      reject(error)
                    },
                  )
                  .finally(settled)
              },
              { once: true },
            )
          })
          let queue: Promise<void> = connecting
          let heard = false
          current.addEventListener('message', (event) => {
            if (!heard) {
              heard = true
              delay = reconnectMs
              onStatus?.({ state: 'attached' })
              resolve()
            }
            const text =
              typeof event.data === 'string'
                ? event.data
                : new TextDecoder().decode(event.data as ArrayBuffer)
            queue = queue.then(() => hand.receive(text)).catch(() => {})
          })
          let ended = false
          const end = (code: number, reason: string) => {
            if (ended) return
            ended = true
            if (link?.connection === connection) link = undefined
            const closing =
              connection === undefined
                ? Promise.resolve()
                : queue.then(() => hand.closed()).catch(() => {})
            void closing.then(() => {
              if (stopped) return finish(reason || 'the hand closed')
              if (code === 1008) return finish(reason || 'the brain refused this hand')
              if (reason === HAND_REPLACED) return finish(reason)
              onStatus?.({ state: 'connecting', reason: reason || `closed with code ${code}` })
              setTimeout(dial, delay)
              delay = Math.min(delay * 2, reconnectMs * 64)
            })
          }
          current.addEventListener('close', (event) => end(event.code, event.reason))
          current.addEventListener('error', () => end(1006, 'the connection failed'))
        }
        dial()
      })
      await Promise.race([
        attached,
        closed.then((status) => {
          throw new Error(status.reason ?? 'the hand closed')
        }),
      ])
      return {
        closed,
        close: () => {
          stopped = true
          try {
            socket?.close(1000, 'the hand closed')
          } catch {}
          finish('the hand closed')
        },
      }
    },
  }
}

/** Prepares a hand and connects it to `options.url`. */
export async function connect(module: WebAssembly.Module, options: Options): Promise<Hand> {
  options.onStatus?.({ state: 'connecting' })
  let prepared: Prepared
  try {
    prepared = await prepare(module, options)
  } catch (error) {
    options.onStatus?.({
      state: 'closed',
      reason: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  return prepared.connect(options.url, options.onStatus)
}

async function streamLink(
  options: Options,
  catalog: string,
  receive: (text: string) => void,
  gone: (reason: string) => void,
  closed: Promise<Status>,
) {
  const connection = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  const reconnectMs = options.reconnectMs ?? 500
  const stop = new AbortController()
  let ended = false
  void closed.then(() => {
    ended = true
    stop.abort()
  })
  const post = (body: Record<string, unknown>, keepalive = false) =>
    globalThis.fetch(
      options.url,
      Object.assign(
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, connection }),
        },
        keepalive ? { keepalive } : { signal: stop.signal },
      ),
    )
  const attached = await post({ catalog })
  if (!attached.ok) {
    const reason = attached.status + ' ' + (await attached.text())
    gone(reason)
    throw new Error(reason)
  }
  let brain: string | undefined
  let cursor = 0
  let pending: string[] = []
  let sending = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    timer = undefined
    if (sending || !pending.length || ended) return
    const frames = pending
    pending = []
    sending = true
    void (async () => {
      try {
        const response = await post({ brain, frames })
        if (!response.ok) throw new Error(response.status + ' ' + (await response.text()))
      } catch (error) {
        if (!ended) gone(error instanceof Error ? error.message : String(error))
      } finally {
        sending = false
        flush()
      }
    })()
  }
  const close = () => {
    if (ended) return
    ended = true
    stop.abort()
    void post({ close: true }, true).catch(() => {})
    gone('the hand closed')
  }
  const target = globalThis as { addEventListener?(type: string, listener: () => void): void }
  target.addEventListener?.('pagehide', close)
  void (async () => {
    while (!ended) {
      try {
        const separator = options.url.includes('?') ? '&' : '?'
        const response = await globalThis.fetch(
          options.url + separator + new URLSearchParams({ connection, cursor: String(cursor) }),
          { headers: { accept: 'text/event-stream' }, signal: stop.signal },
        )
        if (response.status >= 400 && response.status < 500) {
          gone(response.status + ' ' + (await response.text()))
          return
        }
        if (response.ok && response.body) {
          for await (const message of serverEvents(response.body)) {
            if (message.id) cursor = Number(message.id)
            if (!message.data) continue
            const line = JSON.parse(message.data) as { brain?: string; frames?: string[] }
            if (line.brain) brain = line.brain
            for (const frame of line.frames ?? []) receive(frame)
          }
        }
      } catch {}
      if (!ended) await new Promise((resolve) => setTimeout(resolve, reconnectMs))
    }
  })()
  return {
    send(text: string) {
      pending.push(text)
      if (!sending && timer === undefined) timer = setTimeout(flush, options.batchMs ?? 20)
    },
    close,
  }
}

/** Options of a keeper. */
export type KeeperOptions = Omit<Options, 'url' | 'workspace' | 'cwd' | 'token'> & {
  url(session: string): string
  credential?(session: string): string | undefined | Promise<string | undefined>
  listed?(session: string): Promise<boolean>
  module(): Promise<WebAssembly.Module>
  workspace(session: string): Promise<{ workspace: Contracts.WorkspaceHost; cwd: string }>
  cwd?: string
  name?: string
  attachMs?: number
}

type Spare = { prepared: Prepared; slot: { workspace?: Contracts.WorkspaceHost } }

function deferred(slot: Spare['slot']): Contracts.WorkspaceHost {
  const target = () => {
    if (!slot.workspace) throw new Error('the hand has no workspace yet')
    return slot.workspace
  }
  return {
    read: (path) => target().read(path),
    write: (path, contents) => target().write(path, contents),
    readBytes: (path) => AgentRuntime.readBytes(target(), path),
    writeBytes: (path, data, append) => AgentRuntime.writeBytes(target(), path, data, append),
    remove: (path) => target().remove(path),
    run: (request, signal) => target().run(request, signal),
    wasm: (request, signal) => {
      const workspace = target()
      if (!workspace.wasm) throw new Error('this workspace does not run WebAssembly')
      return workspace.wasm(request, signal)
    },
  }
}

/** Keeps one prepared spare hand and attaches a hand to each session that asks for one. */
export function keeper(options: KeeperOptions) {
  const name = options.name ?? 'browser'
  const cwd = options.cwd ?? '/workspace'
  let current: { session: string; hand: Promise<Hand | undefined>; open: boolean } | undefined
  let spare: Promise<Spare | undefined> | undefined
  const listeners = new Set<(status: Status & { session?: string }) => void>()
  let status: Status & { session?: string } = { state: 'closed' }
  const emit = (next: Status & { session?: string }) => {
    status = next
    options.onStatus?.(next)
    for (const listener of listeners) listener(next)
  }
  const prepareSpare = async (): Promise<Spare> => {
    const slot: Spare['slot'] = {}
    const prepared = await prepare(await options.module(), {
      ...options,
      name,
      workspace: deferred(slot),
      cwd,
    })
    return { prepared, slot }
  }
  const take = async (): Promise<Spare> => {
    const ready = spare
    spare = undefined
    return (await ready?.catch(() => undefined)) ?? prepareSpare()
  }
  const open = (session: string) => {
    const entry = { session, open: false, hand: undefined as unknown as Promise<Hand | undefined> }
    entry.hand = (async () => {
      let [ready, place, token] = await Promise.all([
        take(),
        options.workspace(session),
        options.credential?.(session),
      ])
      if (place.cwd !== ready.prepared.cwd) {
        ready.prepared.dispose()
        ready = await prepare(await options.module(), {
          ...options,
          name,
          workspace: place.workspace,
          cwd: place.cwd,
        }).then((prepared) => ({ prepared, slot: {} }))
      }
      ready.slot.workspace = place.workspace
      if (current !== entry) {
        ready.prepared.dispose()
        return undefined
      }
      const hand = await ready.prepared.connect(
        options.url(session),
        (next) => {
          entry.open = next.state === 'attached'
          if (current === entry) emit({ ...next, session })
        },
        token,
      )
      const deadline = Date.now() + (options.attachMs ?? 5000)
      while (
        options.listed &&
        Date.now() < deadline &&
        entry.open &&
        !(await options.listed(session).catch(() => false))
      )
        await new Promise((resolve) => setTimeout(resolve, 150))
      return hand
    })().catch((error) => {
      if (current === entry)
        emit({
          state: 'closed',
          reason: error instanceof Error ? error.message : String(error),
          session,
        })
      return undefined
    })
    current = entry
    emit({ state: 'connecting', session })
    return entry
  }
  const attach = async (session: string): Promise<string | undefined> => {
    if (current?.session !== session) {
      void current?.hand.then((hand) => hand?.close())
      open(session)
    } else if (!current.open) {
      const settled = await current.hand
      if (!current.open) {
        settled?.close()
        open(session)
      }
    }
    const entry = current!
    const hand = await entry.hand
    return hand && entry.open ? name : undefined
  }
  return {
    name,
    status: () => status,
    subscribe(listener: (status: Status & { session?: string }) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    prewarm(session?: string): Promise<unknown> {
      if (session) return attach(session).catch(() => undefined)
      if (!spare && !current) spare = prepareSpare().catch(() => undefined)
      return spare ?? Promise.resolve(undefined)
    },
    attach,
    close() {
      void current?.hand.then((hand) => hand?.close())
      current = undefined
    },
  }
}

import * as ServerEvents from './client/ServerEvents.ts'
import * as AgentRuntime from './AgentRuntime.ts'
import * as Remote from './Remote.ts'
import type * as Contracts from './Contracts.ts'

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
  environment?: Contracts.HandEnvironment
  capabilities?: Contracts.HandCapability[]
  toolsOnly?: boolean
  runtimeId?: string
  protocols?: string | string[]
  maxFrameBytes?: number
  WebSocket?: typeof WebSocket
  token?: string
  transport?: 'websocket' | 'stream'
  reconnectMs?: number
  batchMs?: number
  onStatus?(status: Status): void
  pricing?: Pricing
}

export type Access = 'cell' | 'read' | 'run' | 'tool' | 'write'

export type Operation = {
  access: Access
  agent: string | undefined
  command: string | undefined
  id: number
  input: unknown
  kind: string
  max: number | undefined
  paths: readonly string[]
  session: string | undefined
  source: string | undefined
}

export type Pricing = {
  describe?: string
  payee: string
  price(operation: Operation): number | undefined | Promise<number | undefined>
}

export type Status = { state: 'connecting' | 'attached' | 'closed'; reason?: string }

export type Hand = { closed: Promise<Status>; close(): void }

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

const reading = new Set([
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'Read',
  'grep_files',
  'list_dir',
  'read_file',
  'view_image',
])

const running = new Set([
  'Bash',
  'BashOutput',
  'KillShell',
  'exec_command',
  'local_shell',
  'shell',
  'write_stdin',
])

const writing = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'apply_patch', 'write_file'])

const pathFields = ['dir_path', 'file_path', 'notebook_path', 'path'] as const

type Incoming = {
  agent?: unknown
  id: number
  max_usd?: unknown
  operation?: unknown
  resumable?: unknown
}

function meter(pricing: Pricing, cwd: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(pricing.payee))
    throw new Error('pricing.payee must be a 0x-prefixed 20-byte address')

  const quotes = new Map<number, { charge: string; resumable: boolean }>()
  const advertised = {
    ...(pricing.describe ? { describe: pricing.describe } : {}),
    payee: pricing.payee,
  }
  return {
    capability: {
      description:
        (pricing.describe ? pricing.describe + ' ' : '') +
        'This hand charges in USD for the operations it prices: the brain bills each charge to whoever pays for the agent before the result arrives, and refuses an operation that costs more than the request allows before it runs.',
      name: 'pricing',
      permission: () => 'granted' as const,
    },

    catalog: (text: string) => append(text, 'pricing', advertised),

    async inbound(text: string, answer: (text: string) => void): Promise<string | undefined> {
      if (text.includes('"type":"ack"')) {
        const ids = (JSON.parse(text) as { ids?: unknown }).ids
        if (Array.isArray(ids)) for (const id of ids) quotes.delete(id as number)
        return text
      }
      if (!text.includes('"type":"request"')) return text

      const frame = JSON.parse(text) as Incoming
      const operation = operationOf(frame, cwd)
      if (!operation) return text

      const refuse = (reason: string) => {
        answer(JSON.stringify({ type: 'reply', id: frame.id, result: { Err: reason } }))
        return undefined
      }
      const quoted = await Promise.resolve()
        .then(() => pricing.price(operation))
        .then(
          (usd) => ({ usd }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        )
      if ('error' in quoted)
        return refuse(`the hand refused this operation: ${quoted.error}; nothing ran`)
      if (quoted.usd === undefined || quoted.usd === 0) return text
      if (!Number.isFinite(quoted.usd) || quoted.usd < 0)
        return refuse('the hand priced this operation at an invalid amount; nothing ran')

      const usd = Math.max(1, Math.round(quoted.usd * 1e6)) / 1e6
      if (operation.max === undefined)
        return refuse(
          `this hand charges ${dollars(usd)} for this operation, and the brain that sent it does not bill hand charges; nothing ran`,
        )
      if (usd > operation.max)
        return refuse(
          `this operation costs ${dollars(usd)}, more than the ${dollars(operation.max)} this request allows; nothing ran`,
        )

      const item = [operation.kind, ...operation.paths].join(' ').slice(0, 200)
      quotes.set(frame.id, {
        charge: JSON.stringify({ item, usd }),
        resumable: frame.resumable === true,
      })
      return text
    },

    outbound(text: string) {
      if (!quotes.size) return text

      const head = text.slice(0, 256)
      const type = /"type":"(reply|update)"/.exec(head)?.[1]
      const id = Number(/"id":(\d+)/.exec(head)?.[1])
      const quote = type ? quotes.get(id) : undefined
      if (!quote) return text

      if (type === 'reply') {
        const result = text.indexOf('"result":')
        const failed = text.startsWith('{"Err"', result + 9)
        if (failed || !quote.resumable) quotes.delete(id)
        if (failed) return text
      }
      return text.slice(0, text.lastIndexOf('}')) + ',"charge":' + quote.charge + '}'
    },
  }
}

function append(text: string, key: string, value: unknown) {
  return text.slice(0, text.lastIndexOf('}')) + `,"${key}":` + JSON.stringify(value) + '}'
}

function dollars(usd: number) {
  return '$' + String(Number(usd.toFixed(6)))
}

function operationOf(frame: Incoming, cwd: string): Operation | undefined {
  if (!frame.operation || typeof frame.operation !== 'object') return undefined

  const [variant, body] = Object.entries(frame.operation)[0] ?? []
  if (variant !== 'Call' && variant !== 'Execute' && variant !== 'Wait') return undefined

  const fields = (body ?? {}) as {
    context?: { session_id?: unknown }
    input?: unknown
    name?: unknown
    source?: unknown
  }
  const common = {
    agent: typeof frame.agent === 'string' ? frame.agent : undefined,
    id: frame.id,
    max: typeof frame.max_usd === 'number' ? frame.max_usd : undefined,
    session: typeof fields.context?.session_id === 'string' ? fields.context.session_id : undefined,
  }
  if (variant !== 'Call')
    return {
      ...common,
      access: 'cell',
      command: undefined,
      input: variant === 'Wait' ? fields.input : undefined,
      kind: variant === 'Wait' ? 'wait' : 'execute',
      paths: [],
      source: typeof fields.source === 'string' ? fields.source : undefined,
    }

  const name = String(fields.name)
  const input = fields.input
  const values = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const command = [values['cmd'], values['command']].find((value) => typeof value === 'string') as
    | string
    | undefined
  return {
    ...common,
    access: accessOf(name),
    command,
    input,
    kind: name,
    paths: pathsOf(input, values, command, cwd),
    source: undefined,
  }
}

function accessOf(name: string): Access {
  if (reading.has(name)) return 'read'
  if (writing.has(name)) return 'write'
  if (running.has(name)) return 'run'
  return 'tool'
}

function pathsOf(
  input: unknown,
  values: Record<string, unknown>,
  command: string | undefined,
  cwd: string,
) {
  const found: string[] = []
  for (const key of pathFields) if (typeof values[key] === 'string') found.push(values[key])
  if (Array.isArray(values['paths']))
    for (const path of values['paths']) if (typeof path === 'string') found.push(path)

  const patch = [input, values['input'], values['patch']].find(
    (value): value is string => typeof value === 'string',
  )
  if (patch)
    for (const match of patch.matchAll(
      /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/gm,
    ))
      found.push(match[1]!.trim())
  if (command) found.push(...words(command))

  const base = [values['workdir'], values['cwd']].find(
    (value): value is string => typeof value === 'string',
  )
  return [...new Set(found.map((path) => normalize(path, base, cwd)))]
}

function words(command: string) {
  const found: string[] = []
  for (const segment of command.split(/&&|\|\||[;|&\n()]/)) {
    let first = true
    for (const match of segment.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
      const word = (match[1] ?? match[2] ?? match[3] ?? '').replace(/^\d*[<>]+/, '')
      if (first && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
      if (first) {
        first = false
        continue
      }
      if (word && !word.startsWith('-')) found.push(word)
    }
  }
  return found
}

function normalize(path: string, base: string | undefined, cwd: string) {
  const root = cwd.replace(/\/+$/, '')
  const from = base === undefined ? root : base.startsWith('/') ? base : root + '/' + base
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : from + '/' + path).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  const absolute = '/' + parts.join('/')
  if (absolute === root) return '.'
  return absolute.startsWith(root + '/') ? absolute.slice(root.length + 1) : absolute
}

export async function prepare(
  module: WebAssembly.Module,
  options: Omit<Options, 'url' | 'onStatus'>,
): Promise<Prepared> {
  const cwd = options.cwd ?? '/workspace'
  const metered = options.pricing ? meter(options.pricing, cwd) : undefined
  const capabilities = [...(options.capabilities ?? []), ...(metered ? [metered.capability] : [])]
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
      environment: options.environment ?? { shell: 'bash' },
      ...(capabilities.length ? { capabilities } : {}),
      ...(options.toolsOnly ? { tools_only: true } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.maxFrameBytes ? { max_frame_bytes: options.maxFrameBytes } : {}),
      runtime_id: options.runtimeId ?? crypto.randomUUID(),
      send: (text, connection) => {
        if (link?.connection === connection) link.send(metered ? metered.outbound(text) : text)
      },
      failed: (reason, connection) => {
        if (link?.connection === connection) link.close(1011, reason.slice(0, 120))
      },
    })
  } catch (error) {
    void runtime.dispose().catch(() => {})
    throw error
  }
  const admit = async (text: string, answer: (text: string) => void) => {
    const admitted = metered ? await metered.inbound(text, answer) : text
    if (admitted !== undefined) await hand.receive(admitted)
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
          queue = queue.then(() => admit(text, (answer) => link?.send(answer))).catch(() => {})
        }
        const gone = (reason: string) => {
          void hand.closed().catch(() => {})
          finish(reason)
        }
        const stream = await streamLink(
          { ...options, url },
          metered ? metered.catalog(catalog) : catalog,
          receive,
          gone,
          closed,
        )
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
                      current.send(metered ? metered.catalog(opened.catalog) : opened.catalog)
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
            queue = queue.then(() => admit(text, (answer) => link?.send(answer))).catch(() => {})
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
          for await (const message of ServerEvents.parse(response.body)) {
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

import * as Contracts from './Contracts.ts'
import * as Mcp from './Mcp.ts'
import * as Timing from './Timing.ts'

type Pending = { resolve(value: unknown): void; reject(reason: unknown): void }

const NULL_CELL = 0xffffffff

type Socket = {
  socket: Contracts.MessageSocket
  idle: number
  frames: (string | null)[]
  closed?: string
  waiter?: { id: number; resolve(value: unknown): void }
  watchers: (() => void)[]
  timing: Contracts.ModelTiming
}

export type Metrics = {
  wasm_memory_bytes: number
  timing: {
    runtime_id: string
    started_at: number
    elapsed_ms: number
    spans: Timing.Snapshot
    checkpoints: Timing.Snapshot
    models: Contracts.ModelTiming[]
  }
  initializations: number
  runs: number
  completed: number
  failed: number
  cancelled: number
  retries: number
  waits: number
  resumes: number
  rejected_runs: number
  cancellations: number
  host_calls: number
  store_calls: number
  log_calls: number
  model_requests: number
  model_sockets: number
  socket_sends: number
  socket_frames: number
  tool_calls: number
  body_reads: number
  event_batches: number
  events: number
  host_cancellations: number
  dropped_replies: number
  disposals: number
  bridge_request_bytes: number
  bridge_reply_bytes: number
}

export async function localEngine(
  module: WebAssembly.Module,
  host: Contracts.EngineHost,
): Promise<Contracts.Engine> {
  type Exports = {
    memory: WebAssembly.Memory
    allocate(length: number): number
    poll(): void
  } & Record<Contracts.EngineCall, (id: number, pointer: number, length: number) => void>
  const step = 16_384
  const args = new Array<number>(step / 8).fill(0)
  let levels = 0
  const descend = (): number => {
    if (--levels <= 0) return 1
    try {
      return 1 + Reflect.apply(descend, undefined, args)
    } catch {
      return 1
    }
  }
  const room = (want: number): number => {
    levels = Math.floor(want / step)
    try {
      return Reflect.apply(descend, undefined, args) * step
    } catch {
      return 0
    }
  }
  let exports: Exports | undefined
  let entry = 0
  const bytes = (pointer: number, length: number) =>
    new Uint8Array(exports!.memory.buffer, pointer, length)
  const view = () => new DataView(exports!.memory.buffer)
  const imports = {
    dispatch: (id: number, pointer: number, length: number) =>
      host.dispatch(id, bytes(pointer, length)),
    dispatch_body: (
      id: number,
      pointer: number,
      length: number,
      body: number,
      bodyLength: number,
    ) => host.dispatch(id, bytes(pointer, length), bytes(body, bodyLength).slice()),
    cancel: (id: number) => host.cancel(id),
    clock: (monotonic: number) => (monotonic ? performance.now() : Date.now()),
    stack_room: (want: number, at: number) => {
      entry = at
      return room(want)
    },
    calendar_date: (pointer: number, length: number) => {
      try {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat('en-US', {
            timeZone: new TextDecoder().decode(bytes(pointer, length)),
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
          })
            .formatToParts(Date.now())
            .map((part) => [part.type, Number(part.value)]),
        )
        return parts.year * 10_000 + parts.month * 100 + parts.day
      } catch {
        return 0
      }
    },
    random: (pointer: number, length: number) => {
      crypto.getRandomValues(bytes(pointer, length))
    },
    reply: (id: number, pointer: number, length: number) => host.reply(id, bytes(pointer, length)),
    panicked: (pointer: number, length: number) => host.panicked(bytes(pointer, length)),
  }
  const libc = {
    clock_time_get: (clock: number, _precision: bigint, out: number) => {
      view().setBigUint64(
        out,
        BigInt(Math.round((clock === 0 ? Date.now() : performance.now()) * 1e6)),
        true,
      )
      return 0
    },
    fd_write: (_fd: number, iovs: number, count: number, written: number) => {
      let total = 0
      for (let index = 0; index < count; index++)
        total += view().getUint32(iovs + index * 8 + 4, true)
      view().setUint32(written, total, true)
      return 0
    },
    fd_close: () => 0,
    fd_fdstat_get: () => 8,
    fd_seek: () => 8,
  }
  const instance = await WebAssembly.instantiate(module, {
    host: imports,
    wasi_snapshot_preview1: libc,
  })
  const wasm = instance.exports as unknown as Exports
  exports = wasm
  return {
    get memoryBytes() {
      return wasm.memory.buffer.byteLength
    },
    enter(call, id, length, fill) {
      if (entry) new Uint32Array(wasm.memory.buffer, entry, 1)[0]++
      if (call && fill) {
        const pointer = wasm.allocate(length)
        fill(new Uint8Array(wasm.memory.buffer, pointer, length))
        wasm[call](id, pointer, length)
      }
      wasm.poll()
    },
  }
}

async function create(
  module: WebAssembly.Module,
  sql: Contracts.SqlHost,
  options: Contracts.HostOptions,
) {
  const state: {
    runtimeId: string
    startedAt: number
    started: number
    timings: { record(name: string, milliseconds: number): void; snapshot(): Timing.Snapshot }
    checkpointTimings: {
      record(name: string, milliseconds: number): void
      snapshot(): Timing.Snapshot
    }
    models: Contracts.RuntimeTiming[]
    engine: Contracts.Engine
    encoder: TextEncoder
    decoder: TextDecoder
    inflight: Map<number, () => void>
    bodies: Map<
      number,
      { reader: ReadableStreamDefaultReader<Uint8Array>; timing: Contracts.ModelTiming }
    >
    sockets: Map<number, Socket>
    commands: Map<number, Pending>
    watchers: Set<() => void>
    counters: Omit<Metrics, 'timing' | 'wasm_memory_bytes'>
    nextBody: number
    nextSocket: number
    nextCommand: number
    depth: number
    stopped: boolean
    failure: Error | undefined
    disposal: Promise<void> | undefined
    attached: Set<string>
    options: Partial<Contracts.RuntimeOptions> &
      Contracts.HostOptions & {
        handSend?(text: string, connection: number): void
        handFailed?(reason: string, connection: number): void
        handCapabilities?: Contracts.HandCapability[]
      }
    sql: Contracts.SqlHost
    hands: boolean
    remote: boolean
    subscription: boolean
    opened: boolean
    queries: Map<number, string>
  } = {
    runtimeId: Contracts.sessionUuid(),
    startedAt: Date.now(),
    started: performance.now(),
    timings: Timing.create(),
    checkpointTimings: Timing.create(),
    models: [],
    engine: undefined as unknown as Contracts.Engine,
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    inflight: new Map<number, () => void>(),
    bodies: new Map<
      number,
      { reader: ReadableStreamDefaultReader<Uint8Array>; timing: Contracts.ModelTiming }
    >(),
    sockets: new Map<number, Socket>(),
    commands: new Map<number, Pending>(),
    watchers: new Set<() => void>(),
    counters: {
      initializations: 0,
      runs: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      retries: 0,
      waits: 0,
      resumes: 0,
      rejected_runs: 0,
      cancellations: 0,
      host_calls: 0,
      store_calls: 0,
      log_calls: 0,
      model_requests: 0,
      model_sockets: 0,
      socket_sends: 0,
      socket_frames: 0,
      tool_calls: 0,
      body_reads: 0,
      event_batches: 0,
      events: 0,
      host_cancellations: 0,
      dropped_replies: 0,
      disposals: 0,
      bridge_request_bytes: 0,
      bridge_reply_bytes: 0,
    },
    nextBody: 0,
    nextSocket: 0,
    nextCommand: 0,
    depth: 0,
    stopped: false,
    failure: undefined as unknown as Error | undefined,
    disposal: undefined as unknown as Promise<void> | undefined,
    attached: new Set<string>(),
    options: undefined as unknown as Partial<Contracts.RuntimeOptions> &
      Contracts.HostOptions & {
        handSend?(text: string, connection: number): void
        handFailed?(reason: string, connection: number): void
        handCapabilities?: Contracts.HandCapability[]
      },
    sql: undefined as unknown as Contracts.SqlHost,
    hands: false,
    remote: false,
    subscription: false,
    opened: false,
    queries: new Map<number, string>(),
  }
  state.sql = sql
  state.options = options
  const internal = {
    async shutdown(): Promise<void> {
      state.counters.disposals++
      let failure: unknown
      if (!state.stopped && state.opened) {
        try {
          await internal.command('dispose', {})
        } catch (error) {
          failure = error
        }
      }
      internal.terminate(new Error('agent runtime disposed'))
      await state.options.remote?.dispose()
      if (failure !== undefined) throw failure
    },

    accept(id: number, bytes: Uint8Array, body?: Uint8Array) {
      const received = performance.now()
      const request = JSON.parse(state.decoder.decode(bytes))
      if (body) request.body = body
      state.counters.bridge_request_bytes += bytes.byteLength + (body?.byteLength ?? 0)
      state.timings.record('bridge.decode', performance.now() - received)
      state.counters.host_calls++
      state.inflight.set(id, () => {})
      void Promise.resolve()
        .then(async () => {
          const started = performance.now()
          state.timings.record(`queue.${request.op}`, started - received)
          try {
            return await internal.execute(id, request)
          } finally {
            state.timings.record(`host.${request.op}`, performance.now() - started)
          }
        })
        .then(
          (ok) => ({ ok }),
          (error) => ({ error: encodeError(error) }),
        )
        .then((reply) => internal.complete(id, reply))
    },

    engineHost(): Contracts.EngineHost {
      return {
        dispatch: (id, request, body) => internal.accept(id, request, body),
        cancel: (id) => {
          const cancel = state.inflight.get(id)
          if (!cancel) return
          state.inflight.delete(id)
          state.counters.host_cancellations++
          cancel()
        },
        reply: (id, bytes) => {
          const reply = JSON.parse(state.decoder.decode(bytes))
          const pending = state.commands.get(id)
          if (!pending) return
          state.commands.delete(id)
          if ('error' in reply) pending.reject(new Error(String(reply.error)))
          else pending.resolve(reply.ok)
          internal.notify()
        },
        panicked: (bytes) => {
          internal.fail(new Error(state.decoder.decode(bytes)))
        },
      }
    },

    onCancel(id: number, cancel: () => void) {
      if (state.inflight.has(id)) state.inflight.set(id, cancel)
      else cancel()
    },

    live(id: number) {
      return !state.stopped && state.inflight.has(id)
    },

    async execute(id: number, request: any): Promise<unknown> {
      if (!internal.live(id)) return null
      if (request.op.startsWith('remote_')) {
        if (!state.options.remote) throw new Error('remote executor is not configured')
        internal.onCancel(id, () => state.options.remote!.cancel(id))
        return state.options.remote.execute(request, id)
      }
      switch (request.op) {
        case 'hand_send': {
          state.options.handSend?.(request.text, request.connection)
          return null
        }
        case 'hand_failed': {
          state.options.handFailed?.(request.reason, request.connection)
          return null
        }
        case 'hand_capabilities':
          return Promise.all(
            (state.options.handCapabilities ?? []).map(async (capability) => ({
              name: capability.name,
              description: capability.description,
              tools: capability.tools ?? [],
              permission: await capability.permission(),
            })),
          )
        case 'hand_request_capability': {
          const capability = state.options.handCapabilities?.find(
            (candidate) => candidate.name === request.name,
          )
          if (!capability)
            throw new Error(`this hand offers no capability named \`${request.name}\``)
          return capability.request
            ? await capability.request(request.reason)
            : await capability.permission()
        }
        case 'wake':
          internal.notify()
          state.options.wake?.()
          return null
        case 'sleep':
          return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), request.milliseconds)
            internal.onCancel(id, () => {
              clearTimeout(timer)
              resolve(null)
            })
          })
        case 'http_start': {
          if (!state.options.dispatch) throw new Error('agent runtime is not open')
          state.counters.model_requests++
          const controller = new AbortController()
          internal.onCancel(id, () => controller.abort())
          const timing: Contracts.RuntimeTiming = {
            runtime_id: state.runtimeId,
            dispatch_id: id,
            started_ms: internal.elapsed(),
            body_read_wait_ms: 0,
            body_reads: 0,
            bytes: 0,
            max_chunk_gap_ms: 0,
          }
          state.models.push(timing)
          if (state.models.length > Contracts.recentModelLimit) state.models.shift()
          let response: Response
          try {
            response = await state.options.dispatch(
              {
                provider: request.provider,
                endpoint: request.endpoint,
                method: request.method ?? 'POST',
                headers: request.headers,
                body: request.body,
                origin: request.origin ?? null,
              },
              controller.signal,
              timing,
            )
          } catch (error) {
            internal.finishModel(timing, controller.signal.aborted ? 'cancelled' : 'failed')
            throw error
          }
          timing.headers_ms = internal.elapsed() - timing.started_ms
          timing.status = response.status
          if (!internal.live(id)) {
            void response.body?.cancel().catch(() => undefined)
            internal.finishModel(timing, 'cancelled')
            return null
          }
          if (response.status >= 300 && response.status < 400) {
            void response.body?.cancel().catch(() => undefined)
            internal.finishModel(timing, 'failed')
            throw new Error('provider redirect rejected')
          }
          const body = ++state.nextBody
          const reader = (
            response.body ??
            new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
          ).getReader()
          state.bodies.set(body, { reader, timing })
          internal.onCancel(id, () => {
            if (!state.bodies.delete(body)) return
            internal.finishModel(timing, 'cancelled')
            void reader.cancel().catch(() => undefined)
          })
          return { id: body, status: response.status, headers: [...response.headers] }
        }
        case 'http_read': {
          const body = state.bodies.get(request.id)
          if (!body) throw new Error('provider response body is closed')
          const { reader, timing } = body
          state.counters.body_reads++
          internal.onCancel(id, () => {
            state.bodies.delete(request.id)
            internal.finishModel(timing, 'cancelled')
            void reader.cancel().catch(() => undefined)
          })
          const readStarted = performance.now()
          let chunk: ReadableStreamReadResult<Uint8Array>
          try {
            chunk = await reader.read()
          } catch (error) {
            internal.finishModel(timing, 'failed')
            throw error
          } finally {
            timing.body_read_wait_ms += performance.now() - readStarted
            timing.body_reads++
          }
          if (chunk.done) {
            state.bodies.delete(request.id)
            reader.releaseLock()
            internal.finishModel(timing, 'eof')
            return null
          }
          const at = internal.elapsed() - timing.started_ms
          if (chunk.value.byteLength) timing.first_byte_ms ??= at
          if (timing.last_byte_ms !== undefined)
            timing.max_chunk_gap_ms = Math.max(timing.max_chunk_gap_ms, at - timing.last_byte_ms)
          timing.last_byte_ms = at
          timing.bytes += chunk.value.byteLength
          return chunk.value
        }
        case 'http_close': {
          const body = state.bodies.get(request.id)
          if (body) {
            state.bodies.delete(request.id)
            internal.finishModel(body.timing, 'closed')
            await body.reader.cancel().catch(() => undefined)
          }
          return null
        }
        case 'tool_call': {
          if (!state.options.tools) throw new Error('host tools are not configured')
          state.counters.tool_calls++
          const controller = new AbortController()
          internal.onCancel(id, () => controller.abort())
          return (
            (await state.options.tools.call(
              request.name,
              request.input,
              controller.signal,
              request.context,
            )) ?? null
          )
        }
        case 'file_read':
          return await internal.workspace().read(request.path)
        case 'file_exists':
          return await internal
            .workspace()
            .read(request.path)
            .then(
              (found) => found !== null,
              () => true,
            )
        case 'file_write':
          return (await internal.workspace().write(request.path, request.contents)) ?? null
        case 'file_remove':
          return (await internal.workspace().remove(request.path)) ?? null
        case 'shell_run': {
          const controller = new AbortController()
          internal.onCancel(id, () => controller.abort())
          return await internal.workspace().run(
            {
              command: request.command,
              cwd: request.cwd,
              timeout_ms: request.timeout_ms ?? null,
              ...(typeof request.stdin === 'string' ? { stdin: request.stdin } : {}),
            },
            controller.signal,
          )
        }
        case 'cell_wasm': {
          const workspace = internal.workspace()
          if (!workspace.wasm) throw new Error('self workspace does not run WebAssembly')
          const controller = new AbortController()
          internal.onCancel(id, () => controller.abort())
          return await workspace.wasm(
            request.body instanceof Uint8Array
              ? { ...request.request, module_bytes: request.body }
              : request.request,
            controller.signal,
          )
        }
        case 'cell_fetch': {
          const input = request.request as {
            url: string
            method?: string
            headers?: Record<string, string>
            body?: string
          }
          const controller = new AbortController()
          internal.onCancel(id, () => controller.abort())
          const body: Uint8Array | string | undefined =
            request.body instanceof Uint8Array ? request.body : input.body
          const response = await (state.options.fetch ?? globalThis.fetch)(input.url, {
            method: input.method ?? 'GET',
            ...(input.headers ? { headers: input.headers } : {}),
            ...(body !== undefined ? { body: body as BodyInit } : {}),
            signal: controller.signal,
          })
          return framed(
            {
              status: response.status,
              status_text: response.statusText,
              url: response.url,
              headers: [...response.headers],
            },
            new Uint8Array(await response.arrayBuffer()),
          )
        }
        case 'cell_read':
          return await readBytes(internal.workspace(), cellPath(request.cwd, request.path))
        case 'cell_write': {
          await writeBytes(
            internal.workspace(),
            cellPath(request.cwd, request.path),
            request.body,
            request.append === true,
          )
          return null
        }
        case 'socket_open': {
          if (!state.options.socket) throw new Error('model sockets are not configured')
          state.counters.model_sockets++
          const controller = new AbortController()
          internal.onCancel(id, () => controller.abort())
          const timing: Contracts.RuntimeTiming = {
            runtime_id: state.runtimeId,
            dispatch_id: id,
            transport: 'websocket',
            started_ms: internal.elapsed(),
            body_read_wait_ms: 0,
            body_reads: 0,
            bytes: 0,
            max_chunk_gap_ms: 0,
            sends: 0,
          }
          state.models.push(timing)
          if (state.models.length > Contracts.recentModelLimit) state.models.shift()
          let handshake
          try {
            handshake = await state.options.socket.open(
              {
                provider: request.provider,
                headers: request.headers,
                origin: request.origin ?? null,
              },
              controller.signal,
              timing,
            )
          } catch (error) {
            internal.finishModel(timing, controller.signal.aborted ? 'cancelled' : 'failed')
            throw error
          }
          timing.headers_ms = internal.elapsed() - timing.started_ms
          timing.status = handshake.status
          const socket = handshake.socket
          if (handshake.status !== 101 || !socket) {
            internal.finishModel(timing, 'failed')
            return {
              status: handshake.status,
              headers: [...handshake.headers],
              body: await handshake.text(),
            }
          }
          if (!internal.live(id)) {
            socket.close(1000, 'handshake cancelled')
            internal.finishModel(timing, 'cancelled')
            return null
          }
          const handle = ++state.nextSocket
          const idle = handshake.idle_ms ?? 0
          const entry: Socket = {
            socket,
            idle: Number.isSafeInteger(idle) && idle > 0 ? idle : 0,
            frames: [],
            watchers: [],
            timing,
          }
          state.sockets.set(handle, entry)
          socket.addEventListener('message', (event) => internal.receive(entry, event.data))
          socket.addEventListener('close', (event) =>
            internal.closeSocket(handle, `with code ${event.code}: ${event.reason}`, 'eof'),
          )
          socket.addEventListener('error', () =>
            internal.closeSocket(handle, 'after a transport error', 'failed'),
          )
          internal.onCancel(id, () => {
            internal.closeSocket(handle, 'handshake cancelled', 'cancelled')
            state.sockets.delete(handle)
          })
          return { id: handle, status: handshake.status, headers: [...handshake.headers] }
        }
        case 'socket_send': {
          const entry = state.sockets.get(request.id)
          if (entry?.closed !== undefined) return { closed: entry.closed }
          if (!entry) return { closed: 'after the client released it' }
          await state.options.socket!.admit(request.origin ?? null)
          if (entry.closed !== undefined) return { closed: entry.closed }
          try {
            entry.socket.send(state.decoder.decode(request.body))
          } catch {
            internal.closeSocket(request.id, 'before request dispatch', 'failed')
            return { closed: entry.closed }
          }
          entry.timing.sends = (entry.timing.sends ?? 0) + 1
          state.counters.socket_sends++
          return null
        }
        case 'socket_next': {
          const entry = state.sockets.get(request.id)
          if (!entry) return { closed: 'after the client released it' }
          if (entry.frames.length) return internal.frame(entry)
          if (entry.closed !== undefined) return { closed: entry.closed }
          if (entry.waiter) throw new Error('socket_next is already pending')
          const readStarted = performance.now()
          try {
            return await new Promise((resolve) => {
              const timer = entry.idle
                ? setTimeout(
                    () =>
                      internal.closeSocket(
                        request.id,
                        'after the stream idle deadline elapsed',
                        'failed',
                      ),
                    entry.idle,
                  )
                : undefined
              const clear = () => {
                if (timer !== undefined) clearTimeout(timer)
              }
              entry.waiter = {
                id,
                resolve: (value) => {
                  clear()
                  resolve(value)
                },
              }
              internal.onCancel(id, () => {
                clear()
                if (entry.waiter?.id === id) entry.waiter = undefined
                resolve(null)
              })
            })
          } finally {
            entry.timing.body_read_wait_ms += performance.now() - readStarted
          }
        }
        case 'socket_wait': {
          const entry = state.sockets.get(request.id)
          if (!entry || entry.closed !== undefined) return null
          return new Promise((resolve) => {
            entry.watchers.push(() => resolve(null))
            internal.onCancel(id, () => resolve(null))
          })
        }
        case 'socket_close': {
          internal.closeSocket(request.id, 'by the client', 'closed')
          state.sockets.delete(request.id)
          return null
        }
        case 'events': {
          state.counters.event_batches++
          state.counters.events += request.events.length
          state.options.published(request.events, request.bytes)
          internal.notify()
          return null
        }
        case 'live_events': {
          state.options.live?.(request.events)
          return null
        }
        case 'turn_finished':
          return (await state.options.finishing?.(request.request_id)) ?? {}
        case 'store': {
          state.counters.store_calls++
          const started = performance.now()
          try {
            return internal.rows(
              await state.sql.transaction(
                'store',
                request.operation,
                internal.statements(request.statements),
              ),
            )
          } finally {
            state.checkpointTimings.record(request.operation, performance.now() - started)
          }
        }
        case 'blob_put': {
          await internal.blobs().put(request.key, request.body)
          return null
        }
        case 'blob_get':
          return await internal.blobs().get(request.key)
        case 'log': {
          state.counters.log_calls++
          return internal.rows(
            await state.sql.transaction(
              'log',
              request.operation,
              internal.statements(request.statements),
            ),
          )
        }
        default:
          throw new Error('unsupported host operation')
      }
    },

    blobs() {
      if (!state.options.blobs) throw new Error('the host blob store is not configured')
      return state.options.blobs
    },

    workspace(): Contracts.WorkspaceHost {
      if (!state.options.workspace) throw new Error('the host workspace is not configured')
      return state.options.workspace
    },

    notify() {
      for (const watcher of [...state.watchers]) watcher()
    },

    statements(statements: any[]): Contracts.Statement[] {
      for (const statement of statements) {
        const head = statement[0]
        if (typeof head === 'number') {
          const query = state.queries.get(head)
          if (query === undefined) throw new Error('unknown interned SQL statement ' + head)
          statement[0] = query
        } else if (Array.isArray(head)) {
          state.queries.set(head[0], head[1])
          statement[0] = head[1]
        }
      }
      return statements as Contracts.Statement[]
    },

    rows(statements: Contracts.SqlValue[][][]): Uint8Array {
      let capacity = 4
      for (const rows of statements) {
        capacity += 4
        for (const row of rows) {
          capacity += 4 + 4 * row.length
          for (const cell of row) if (typeof cell === 'string') capacity += 3 * cell.length
        }
      }
      const bytes = new Uint8Array(capacity)
      const view = new DataView(bytes.buffer)
      let offset = 0
      const count = (value: number) => {
        view.setUint32(offset, value, true)
        offset += 4
      }
      count(statements.length)
      for (const rows of statements) {
        count(rows.length)
        for (const row of rows) {
          count(row.length)
          for (const cell of row) {
            if (cell === null) {
              count(NULL_CELL)
              continue
            }
            if (typeof cell !== 'string')
              throw new Error('SQL host returned a value that is neither text nor null')
            const { written } = state.encoder.encodeInto(cell, bytes.subarray(offset + 4))
            count(written)
            offset += written
          }
        }
      }
      return bytes.subarray(0, offset)
    },

    receive(entry: Socket, data: unknown) {
      if (entry.closed !== undefined) return
      const at = internal.elapsed() - entry.timing.started_ms
      entry.timing.first_byte_ms ??= at
      entry.timing.last_byte_ms = at
      entry.timing.body_reads++
      state.counters.socket_frames++
      entry.frames.push(typeof data === 'string' ? data : null)
      const waiter = entry.waiter
      if (!waiter) return
      entry.waiter = undefined
      waiter.resolve(internal.frame(entry))
    },

    frame(entry: Socket): unknown {
      const frame = entry.frames.shift()
      if (frame === null || frame === undefined) return { binary: true }
      const bytes = state.encoder.encode(frame)
      entry.timing.bytes += bytes.byteLength
      return bytes
    },

    closeSocket(handle: number, detail: string, outcome: Contracts.ModelTiming['outcome']) {
      const entry = state.sockets.get(handle)
      if (!entry || entry.closed !== undefined) return
      entry.closed = detail
      internal.finishModel(entry.timing, outcome)
      try {
        entry.socket.close(1000, 'closed')
      } catch {}
      const waiter = entry.waiter
      entry.waiter = undefined
      waiter?.resolve({ closed: detail })
      for (const watcher of entry.watchers.splice(0)) watcher()
    },

    closeSockets(detail: string, outcome: Contracts.ModelTiming['outcome']) {
      for (const handle of [...state.sockets.keys()]) internal.closeSocket(handle, detail, outcome)
    },

    complete(id: number, reply: { ok: unknown } | { error: unknown }) {
      if (!internal.live(id)) {
        state.counters.dropped_replies++
        return
      }
      state.inflight.delete(id)
      if ('ok' in reply && isFramed(reply.ok))
        internal.enter('complete_bytes', id, ...internal.writeFramed(reply.ok))
      else if ('ok' in reply && reply.ok instanceof Uint8Array)
        internal.enter('complete_bytes', id, ...internal.writeBytes(reply.ok))
      else internal.enter('complete', id, ...internal.write(reply))
    },

    command(op: string, fields: object): Promise<unknown> {
      if (state.stopped)
        return Promise.reject(state.failure ?? new Error('agent runtime is closed'))
      const id = ++state.nextCommand
      return new Promise((resolve, reject) => {
        state.commands.set(id, { resolve, reject })
        internal.enter('command', id, ...internal.write({ [op]: fields }))
      })
    },

    enter(
      call: Contracts.EngineCall,
      id: number,
      length: number,
      fill: (target: Uint8Array) => void,
    ) {
      if (state.depth > 0) {
        queueMicrotask(() => internal.enter(call, id, length, fill))
        return
      }
      if (state.stopped) return
      state.depth++
      const started = performance.now()
      try {
        state.engine.enter(call, id, length, fill)
      } catch (error) {
        internal.fail(error)
      } finally {
        state.timings.record('wasm.enter', performance.now() - started)
        state.depth--
      }
    },

    fail(error: unknown) {
      state.failure ??= error instanceof Error ? error : new Error(String(error))
      internal.terminate(state.failure)
    },

    terminate(reason: unknown) {
      if (state.stopped) return
      state.stopped = true
      state.engine?.close?.()
      const cancellations = [...state.inflight.values()]
      state.counters.host_cancellations += cancellations.length
      state.inflight.clear()
      for (const cancel of cancellations) cancel()
      for (const { reader, timing } of state.bodies.values()) {
        internal.finishModel(timing, 'cancelled')
        void reader.cancel().catch(() => undefined)
      }
      state.bodies.clear()
      internal.closeSockets('agent runtime disposed', 'cancelled')
      state.sockets.clear()
      const commands = [...state.commands.values()]
      state.commands.clear()
      for (const pending of commands) pending.reject(reason)
      internal.notify()
    },

    write(value: unknown) {
      const started = performance.now()
      try {
        return internal.writeBytes(state.encoder.encode(JSON.stringify(value)))
      } finally {
        state.timings.record('bridge.encode', performance.now() - started)
      }
    },

    writeBytes(bytes: Uint8Array) {
      state.counters.bridge_reply_bytes += bytes.byteLength
      return [
        bytes.length,
        (target: Uint8Array) => {
          const started = performance.now()
          target.set(bytes)
          state.timings.record('bridge.copy', performance.now() - started)
        },
      ] as const
    },

    writeFramed(reply: Framed) {
      const head = state.encoder.encode(JSON.stringify(reply.head))
      const length = reply.body.byteLength + head.byteLength + 4
      state.counters.bridge_reply_bytes += length
      return [
        length,
        (target: Uint8Array) => {
          const started = performance.now()
          target.set(reply.body)
          target.set(head, reply.body.byteLength)
          new DataView(target.buffer, target.byteOffset + length - 4, 4).setUint32(
            0,
            head.byteLength,
            true,
          )
          state.timings.record('bridge.copy', performance.now() - started)
        },
      ] as const
    },

    elapsed(): number {
      return performance.now() - state.started
    },

    finishModel(timing: Contracts.ModelTiming, outcome: Contracts.ModelTiming['outcome']): void {
      if (timing.outcome) return
      timing.outcome = outcome
      timing.duration_ms = internal.elapsed() - timing.started_ms
    },
  }
  const self = {
    get hands() {
      return state.hands
    },
    set hands(value: boolean) {
      state.hands = value
    },

    get remote() {
      return state.remote
    },
    set remote(value: boolean) {
      state.remote = value
    },

    get subscription() {
      return state.subscription
    },
    set subscription(value: boolean) {
      state.subscription = value
    },

    get opened() {
      return state.opened
    },
    set opened(value: boolean) {
      state.opened = value
    },

    async serveHand(options: {
      workspace: Contracts.WorkspaceHost
      cwd: string
      fetch?: Contracts.RuntimeOptions['fetch']
      dispatch?: Contracts.RuntimeOptions['dispatch']
      tools?: {
        definitions: Contracts.HostTool[]
        call: NonNullable<Contracts.RuntimeOptions['tools']>['call']
      }
      mcp_servers?: Contracts.McpServer[]
      mcp?: Mcp.Policy
      environment?: Contracts.HandEnvironment
      capabilities?: Contracts.HandCapability[]
      tools_only?: boolean
      name?: string
      max_frame_bytes?: number
      runtime_id?: string
      send(text: string, connection: number): void
      failed?(reason: string, connection: number): void
    }): Promise<{
      catalog: string
      connect(): Promise<{ catalog: string; connection: number }>
      receive(text: string): Promise<void>
      closed(): Promise<void>
    }> {
      if (state.opened || self.closed) throw new Error('agent runtime cannot be opened again')
      state.opened = true
      state.options = {
        ...state.options,
        workspace: options.workspace,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.dispatch
          ? { dispatch: Mcp.defer(options.dispatch, options.mcp_servers, options.mcp) }
          : {}),
        ...(options.tools ? { tools: options.tools } : {}),
        handSend: options.send,
        ...(options.failed ? { handFailed: options.failed } : {}),
        ...(options.capabilities?.length ? { handCapabilities: options.capabilities } : {}),
      }
      const catalog = (await internal.command('hand_open', {
        name: options.name ?? null,
        workspace: options.cwd,
        max_frame_bytes: options.max_frame_bytes ?? null,
        runtime_id: options.runtime_id ?? null,
        tools: options.tools?.definitions ?? [],
        mcp_servers: options.mcp_servers ?? [],
        environment: options.environment ?? null,
        capabilities: (options.capabilities ?? []).map((capability) => ({
          name: capability.name,
          description: capability.description,
          tools: capability.tools ?? [],
        })),
        tools_only: options.tools_only ?? false,
      })) as string
      return {
        catalog,
        connect: async () =>
          (await internal.command('hand_connect', {})) as { catalog: string; connection: number },
        receive: async (text) => {
          await internal.command('hand_frame', { text })
        },
        closed: async () => {
          await internal.command('hand_closed', {})
        },
      }
    },

    async open(
      config: Contracts.AgentConfiguration,
      options: Contracts.RuntimeOptions,
    ): Promise<void> {
      if (state.opened || self.closed) throw new Error('agent runtime cannot be opened again')
      state.opened = true
      state.options = {
        ...options,
        dispatch: Mcp.defer(options.dispatch, config.mcp_servers, options.mcp),
        published: state.options.published,
        live: state.options.live,
        wake: state.options.wake,
        blobs: state.options.blobs,
      }
      const project =
        config.workspace && options.workspace && !config.environment?.project_instructions
          ? await projectInstructions(options.workspace, config.workspace)
          : undefined
      if (project)
        config = {
          ...config,
          environment: {
            ...(config.environment ?? { cwd: config.workspace }),
            project_instructions: project,
          },
        }
      state.hands = config.hands ?? false
      state.remote = config.remote ?? false
      state.subscription = config.subscription
      try {
        const initStarted = performance.now()
        const opened = (await internal.command('init', {
          config: {
            ...config,
            runtime_id: state.runtimeId,
            started_ms: state.started,
            provider: config.provider ?? 'claude',
            remote: state.remote,
            hands: state.hands,
            code_mode: !state.remote,
            event_coalesce_ms: config.event_coalesce_ms ?? 0,
            tools: config.tools ?? [],
          },
        })) as { rejected?: { error: string; kind: string } }
        if (opened.rejected)
          throw new Contracts.HostFailureError(opened.rejected.error, opened.rejected.kind, true)
        state.timings.record('sdk.open', performance.now() - initStarted)
      } catch (error) {
        internal.terminate(error)
        throw error
      }
      state.counters.initializations++
    },

    get metrics(): Readonly<Metrics> {
      return {
        ...state.counters,
        wasm_memory_bytes: state.engine.memoryBytes,
        timing: {
          runtime_id: state.runtimeId,
          started_at: state.startedAt,
          elapsed_ms: internal.elapsed(),
          spans: state.timings.snapshot(),
          checkpoints: state.checkpointTimings.snapshot(),
          models: state.models.map((value) => ({ ...value })),
        },
      }
    },

    get closed(): boolean {
      return state.stopped || state.disposal !== undefined
    },

    get reusable(): boolean {
      return !self.closed && !state.options.remote?.failed?.()
    },

    get memoryBytes(): number {
      return state.engine.memoryBytes
    },

    get connected(): boolean {
      for (const entry of state.sockets.values()) if (entry.closed === undefined) return true
      return false
    },

    async submit(
      scope: string,
      input: {
        request_id: string
        prompt: string
        images?: string[]
        hand?: string
        metadata: unknown
      },
    ): Promise<Contracts.Submitted> {
      return (await internal.command('submit', { scope, ...input })) as Contracts.Submitted
    },

    async append(
      scope: string,
      events: { request_id?: string; event: Contracts.HostEvent }[],
    ): Promise<Contracts.LoggedEvent[]> {
      return (
        (await internal.command('append', { scope, events })) as {
          appended: Contracts.LoggedEvent[]
        }
      ).appended
    },

    async admit(
      request_id: string,
      recorded: string | null,
      requested: string,
    ): Promise<'reserved_request_id' | 'provider_changed' | undefined> {
      return (
        (await internal.command('admit', { request_id, recorded, requested })) as {
          rejected?: 'reserved_request_id' | 'provider_changed'
        } | null
      )?.rejected
    },

    async catalog(frame: string, max_frame_bytes: number): Promise<string | null> {
      return (await self.identity(frame, max_frame_bytes)).name
    },

    async identity(
      frame: string,
      max_frame_bytes: number,
    ): Promise<{ name: string | null; runtime_id: string | null }> {
      return (await internal.command('catalog', { frame, max_frame_bytes })) as {
        name: string | null
        runtime_id: string | null
      }
    },

    async turn(scope: string, request_id: string): Promise<Contracts.TurnView | null> {
      return (
        (await internal.command('turn', { scope, request_id })) as {
          turn: Contracts.TurnView | null
        }
      ).turn
    },

    async pending(scope: string): Promise<Contracts.TurnView[]> {
      return ((await internal.command('pending', { scope })) as { turns: Contracts.TurnView[] })
        .turns
    },

    async page(
      scope: string,
      after: number,
      limit: number,
      options?: string | Contracts.LogPageOptions,
    ): Promise<Contracts.LogPage> {
      const page = typeof options === 'string' ? { request_id: options } : options
      return (await internal.command('page', { scope, after, limit, ...page })) as Contracts.LogPage
    },

    async interrupted(scope: string, request_id: string, note: string): Promise<void> {
      await internal.command('interrupted', { scope, request_id, note })
    },

    async retry(
      scope: string,
      request_id: string,
      error: string,
      kind: string,
      retry_at: number,
    ): Promise<Contracts.TurnView | null> {
      return (
        (await internal.command('retry', { scope, request_id, error, kind, retry_at })) as {
          turn: Contracts.TurnView | null
        }
      ).turn
    },

    async finish(
      scope: string,
      request_id: string,
      status: 'failed' | 'cancelled',
      fields: Record<string, unknown>,
    ): Promise<void> {
      await internal.command('finish', { scope, request_id, status, fields })
    },

    async import(scope: string, turns: unknown[]): Promise<number> {
      return (await internal.command('import', { scope, turns })) as number
    },

    async exportBranch(
      session_id: string,
      at: Contracts.BranchPoint,
    ): Promise<Contracts.BranchExport> {
      return (await internal.command('export_branch', { session_id, at })) as Contracts.BranchExport
    },

    async exportPage(
      session_id: string,
      exported: Contracts.BranchExport,
      cursor: Contracts.BranchCursor,
      max_bytes: number,
    ): Promise<Contracts.BranchPage> {
      return (await internal.command('export_page', {
        session_id,
        export: exported,
        cursor,
        max_bytes,
      })) as Contracts.BranchPage
    },

    async importBranch(
      session_id: string,
      exported: Contracts.BranchExport,
    ): Promise<Contracts.BranchCursor | null> {
      return (
        (await internal.command('import_branch', { session_id, export: exported })) as {
          next: Contracts.BranchCursor | null
        }
      ).next
    },

    async importPage(
      session_id: string,
      exported: Contracts.BranchExport,
      page: Contracts.BranchPage,
    ): Promise<Contracts.BranchCursor | null> {
      return (
        (await internal.command('import_page', { session_id, export: exported, page })) as {
          next: Contracts.BranchCursor | null
        }
      ).next
    },

    async publishBranch(
      session_id: string,
      exported: Contracts.BranchExport,
    ): Promise<Contracts.BranchSummary> {
      return (await internal.command('publish_branch', {
        session_id,
        export: exported,
      })) as Contracts.BranchSummary
    },

    async importEvents(
      scope: string,
      after: number,
      events: Contracts.LoggedEvent[],
    ): Promise<number> {
      return (await internal.command('import_events', { scope, after, events })) as number
    },

    async cancel(
      scope: string,
      request_id: string,
      fields: Record<string, unknown>,
    ): Promise<{ turn: Contracts.TurnView | null; dequeued?: boolean }> {
      state.counters.cancellations++
      return (await internal.command('cancel', { scope, request_id, fields })) as {
        turn: Contracts.TurnView | null
        dequeued?: boolean
      }
    },

    async drive(next?: string): Promise<Contracts.Driven> {
      if (self.closed) throw state.failure ?? new Error('agent runtime is closed')
      state.counters.runs++
      let result: Contracts.Driven
      try {
        result = (await internal.command('drive', { next })) as Contracts.Driven
      } catch {
        result = { retry: true }
      }
      const status = result.finished?.report.status
      if (status === 'completed') state.counters.completed++
      else if (status === 'cancelled') state.counters.cancelled++
      else if (status === 'failed') state.counters.failed++
      else if (result.retry) state.counters.retries++
      else if (result.busy) state.counters.rejected_runs++
      else if (result.waiting) state.counters.waits++
      else if (result.resumed !== undefined) state.counters.resumes++
      if (result.retry) await self.dispose().catch(() => undefined)
      return result
    },

    async attach(hand: string, connection: string): Promise<void> {
      if (self.closed || state.attached.has(connection)) return
      state.attached.add(connection)
      try {
        await internal.command('attach', { hand, connection })
      } catch (error) {
        state.attached.delete(connection)
        throw error
      }
    },

    async detach(connection: string): Promise<void> {
      if (self.closed || !state.attached.delete(connection)) return
      await internal.command('detach', { connection })
    },

    async modelCatalog(): Promise<Contracts.ModelCatalog> {
      return (await internal.command('models', {})) as Contracts.ModelCatalog
    },

    async settle(): Promise<boolean> {
      return (await internal.command('settle', {})) === true
    },

    async compact(): Promise<Contracts.Compacted> {
      return (await internal.command('compact', {})) as Contracts.Compacted
    },

    async steer(requestId: string, prompt: string, into?: string): Promise<boolean> {
      return (await internal.command('steer', { request_id: requestId, prompt, into })) === true
    },

    async replaceQueued(
      scope: string,
      request_id: string,
      edit_id: string,
      text: string,
    ): Promise<Contracts.Replaced> {
      return (await internal.command('replace', {
        scope,
        request_id,
        edit_id,
        text,
      })) as Contracts.Replaced
    },

    async moveQueued(requestId: string, into?: string): Promise<Contracts.MovedQueued> {
      return (
        (await internal.command('move_queued', { request_id: requestId, into })) as {
          moved: Contracts.MovedQueued
        }
      ).moved
    },

    async interruptSubagent(agent_id: number): Promise<Contracts.SubagentSummary[]> {
      return (await internal.command('interrupt_subagent', {
        agent_id,
      })) as Contracts.SubagentSummary[]
    },

    async closeSubagent(agent_id: number): Promise<Contracts.SubagentSummary[]> {
      return (await internal.command('close_subagent', { agent_id })) as Contracts.SubagentSummary[]
    },

    async completionOrigin(requestId: string): Promise<string | null> {
      return (await internal.command('completion_origin', { request_id: requestId })) as
        | string
        | null
    },

    async checkThinking(thinking: Contracts.Thinking): Promise<void> {
      await internal.command('settings', { thinking, apply: false })
    },

    async setThinking(thinking: Contracts.Thinking): Promise<void> {
      await self.settings({ thinking })
    },

    async settings(settings: Contracts.RuntimeSettings): Promise<void> {
      await internal.command('settings', { ...settings, apply: true })
    },

    async preconnect(): Promise<void> {
      await internal.command('preconnect', {})
    },

    changed(signal?: AbortSignal): Promise<void> {
      if (state.stopped || signal?.aborted) return Promise.resolve()
      return new Promise((resolve) => {
        const done = () => {
          state.watchers.delete(done)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        state.watchers.add(done)
        signal?.addEventListener('abort', done, { once: true })
      })
    },

    dispose(): Promise<void> {
      state.disposal ??= internal.shutdown()
      return state.disposal
    },

    releaseConnections(): void {
      internal.closeSockets('released while the session is idle', 'closed')
    },
  }

  const instantiateStarted = performance.now()
  state.engine = await (options.engine ?? localEngine)(module, internal.engineHost())
  state.timings.record('wasm.instantiate', performance.now() - instantiateStarted)
  if (sql.value_limit !== undefined || options.log_logical_limit !== undefined || options.blobs) {
    await internal.command('configure', {
      value_limit: sql.value_limit,
      logical_limit: options.log_logical_limit,
      blob_threshold: options.blobs
        ? (options.blobs.threshold ?? sql.value_limit ?? Number.MAX_SAFE_INTEGER)
        : undefined,
    })
  }

  return self
}
export async function instantiate(
  module: WebAssembly.Module,
  sql: Contracts.SqlHost,
  options: Contracts.HostOptions,
): Promise<AgentRuntime> {
  return create(module, sql, options)
}

export function encodeError(error: unknown) {
  return {
    detail: error instanceof Error ? error.message : String(error),
    ...(error instanceof Contracts.RemoteRefusalError ? { unsent: true } : {}),
  }
}

export type AgentRuntime = Awaited<ReturnType<typeof create>>

const FRAMED = Symbol('framed')

type Framed = { [FRAMED]: true; head: unknown; body: Uint8Array }

function framed(head: unknown, body: Uint8Array): Framed {
  return { [FRAMED]: true, head, body }
}

function isFramed(value: unknown): value is Framed {
  return typeof value === 'object' && value !== null && FRAMED in value
}

function cellPath(cwd: string, path: string): string {
  return path.startsWith('/') ? path : cwd.replace(/\/+$/, '') + '/' + path
}

function shellQuote(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'"
}

const FILE_CHUNK = 600_000

async function shellBytes(
  workspace: Contracts.WorkspaceHost,
  command: string,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const result = await workspace.run(
    { command, cwd: '/', timeout_ms: null },
    new AbortController().signal,
  )
  if (result.exit_code !== 0)
    throw new Error(
      result.stderr.trim() || command.split(' ')[0] + ' exited with ' + result.exit_code,
    )
  return {
    bytes: Uint8Array.from(atob(result.stdout.trim()), (character) => character.charCodeAt(0)),
    truncated: result.truncated,
  }
}

export async function readBytes(
  workspace: Contracts.WorkspaceHost,
  path: string,
): Promise<Uint8Array> {
  if (workspace.readBytes) return workspace.readBytes(path)
  const whole = await workspace.run(
    { command: 'base64 -w0 -- ' + shellQuote(path), cwd: '/', timeout_ms: null },
    new AbortController().signal,
  )
  if (whole.exit_code !== 0)
    throw new Error(whole.stderr.trim() || 'base64 exited with ' + whole.exit_code)
  if (!whole.truncated)
    return Uint8Array.from(atob(whole.stdout.trim()), (character) => character.charCodeAt(0))
  const size = await workspace.run(
    { command: 'wc -c < ' + shellQuote(path), cwd: '/', timeout_ms: null },
    new AbortController().signal,
  )
  const total = parseInt(size.stdout, 10)
  const out = new Uint8Array(total)
  for (let offset = 0; offset < total; offset += FILE_CHUNK) {
    const chunk = await shellBytes(
      workspace,
      'tail -c +' +
        (offset + 1) +
        ' -- ' +
        shellQuote(path) +
        ' | head -c ' +
        FILE_CHUNK +
        ' | base64 -w0',
    )
    if (chunk.truncated) throw new Error('reading ' + path + ' was truncated')
    out.set(chunk.bytes, offset)
  }
  return out
}

export async function writeBytes(
  workspace: Contracts.WorkspaceHost,
  path: string,
  data: Uint8Array,
  append: boolean,
): Promise<void> {
  if (workspace.writeBytes) return workspace.writeBytes(path, data, append)
  let encoded = ''
  for (let index = 0; index < data.length; index += 0x8000)
    encoded += String.fromCharCode(...data.subarray(index, index + 0x8000))
  const result = await workspace.run(
    {
      command:
        'mkdir -p -- "$(dirname -- ' +
        shellQuote(path) +
        ')" && base64 -d ' +
        (append ? '>>' : '>') +
        ' ' +
        shellQuote(path),
      cwd: '/',
      timeout_ms: null,
      stdin: btoa(encoded),
    },
    new AbortController().signal,
  )
  if (result.exit_code !== 0)
    throw new Error(result.stderr.trim() || 'write exited with ' + result.exit_code)
}

async function projectInstructions(
  workspace: Contracts.WorkspaceHost,
  root: string,
): Promise<string | undefined> {
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const text = await workspace.read(root.replace(/\/+$/, '') + '/' + name).catch(() => null)
    if (text?.trim()) return text
  }
  return undefined
}

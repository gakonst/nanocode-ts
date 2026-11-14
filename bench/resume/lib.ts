import { spawn } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Http from 'node:http'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export const here = Path.dirname(fileURLToPath(import.meta.url))
export const output = Path.resolve(here, '../../output/resume')
const handBinary = process.env.RESUME_HAND ?? 'nanocode'
const wrangler = (process.env.RESUME_WRANGLER ?? 'npx wrangler').split(' ')

function accept(request, socket, head, receive) {
  const key = Crypto.createHash('sha1')
    .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      key +
      '\r\n\r\n',
  )
  const frame = (opcode, body) => {
    const length = body.length
    const header =
      length < 126
        ? Buffer.from([0x80 | opcode, length])
        : length < 65536
          ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
          : Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.alloc(8)])
    if (length >= 65536) header.writeBigUInt64BE(BigInt(length), 2)
    socket.write(Buffer.concat([header, body]))
  }
  let buffered = head
  let parts = []
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      if (buffered.length < 2) return
      const opcode = buffered[0] & 15
      const masked = buffered[1] & 128
      let length = buffered[1] & 127
      let offset = 2
      if (length === 126) {
        if (buffered.length < 4) return
        length = buffered.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffered.length < 10) return
        length = Number(buffered.readBigUInt64BE(2))
        offset = 10
      }
      const mask = offset
      if (masked) offset += 4
      if (buffered.length < offset + length) return
      const body = Buffer.from(buffered.subarray(offset, offset + length))
      if (masked)
        for (let index = 0; index < length; index++) body[index] ^= buffered[mask + (index & 3)]
      const last = buffered[0] & 128
      buffered = buffered.subarray(offset + length)
      if (opcode === 8) return socket.end()
      if (opcode === 9) frame(10, body)
      if (opcode > 2) continue
      parts.push(body)
      if (!last) continue
      receive(Buffer.concat(parts).toString())
      parts = []
    }
  })
  return { send: (text) => frame(1, Buffer.from(text)), terminate: () => socket.destroy() }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sse(events) {
  return events
    .map(([name, data]) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n')
    .join('')
}

function text(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value))
    return value.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
  return value == null ? '' : JSON.stringify(value)
}

export function claudeView(body) {
  const calls = []
  const byId = new Map()
  let prompt = ''
  for (const message of body.messages ?? []) {
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : (message.content ?? [])
    for (const block of blocks) {
      if (block.type === 'text' && message.role === 'user') prompt += block.text
      if (block.type === 'tool_use') {
        const call = { id: block.id, input: block.input, name: block.name }
        calls.push(call)
        byId.set(block.id, call)
      }
      if (block.type === 'tool_result') {
        const call = byId.get(block.tool_use_id)
        if (call) call.output = text(block.content)
      }
    }
  }
  return { calls, prompt }
}

export function codexView(items) {
  const calls = []
  const byId = new Map()
  let prompt = ''
  for (const item of items) {
    if (item.type === 'message' && item.role === 'user') prompt += text(item.content)
    if (item.type === 'custom_tool_call' || item.type === 'function_call') {
      let input = item.type === 'custom_tool_call' ? { code: item.input } : item.arguments
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input)
        } catch {}
      }
      const call = { id: item.call_id, input, name: item.name }
      calls.push(call)
      byId.set(item.call_id, call)
    }
    if (item.type === 'custom_tool_call_output' || item.type === 'function_call_output') {
      const call = byId.get(item.call_id)
      if (call) call.output = text(item.output)
    }
  }
  return { calls, prompt }
}

const claudeUsage = { input: 8, output: 4 }
const codexUsage = { input: 100, output: 7 }

function claudeReply(id, model, step) {
  const blocks = step.calls
    ? step.calls.map((call, index) => [
        { id: 'toolu_' + id + '_' + index, input: {}, name: call.name, type: 'tool_use' },
        { partial_json: JSON.stringify(call.input), type: 'input_json_delta' },
      ])
    : [
        [
          { text: '', type: 'text' },
          { text: step.final, type: 'text_delta' },
        ],
      ]
  return sse([
    [
      'message_start',
      {
        message: {
          content: [],
          id: 'msg_' + id,
          model,
          role: 'assistant',
          stop_reason: null,
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: claudeUsage.input, output_tokens: 0 },
        },
        type: 'message_start',
      },
    ],
    ...blocks.flatMap(([start, delta], index) => [
      ['content_block_start', { content_block: start, index, type: 'content_block_start' }],
      ['content_block_delta', { delta, index, type: 'content_block_delta' }],
      ['content_block_stop', { index, type: 'content_block_stop' }],
    ]),
    [
      'message_delta',
      {
        delta: { stop_reason: step.calls ? 'tool_use' : 'end_turn', stop_sequence: null },
        type: 'message_delta',
        usage: { output_tokens: claudeUsage.output },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
}

function codexItems(id, step, tools) {
  if (!step.calls)
    return [
      {
        content: [{ annotations: [], text: step.final, type: 'output_text' }],
        id: 'msg_' + id,
        role: 'assistant',
        status: 'completed',
        type: 'message',
      },
    ]
  return step.calls.map((call, index) => {
    const custom = tools.get(call.name) === 'custom'
    return custom
      ? {
          call_id: 'call_' + id + '_' + index,
          id: 'ctc_' + id + '_' + index,
          input: call.input.code,
          name: call.name,
          status: 'completed',
          type: 'custom_tool_call',
        }
      : {
          arguments: JSON.stringify(call.input),
          call_id: 'call_' + id + '_' + index,
          id: 'fc_' + id + '_' + index,
          name: call.name,
          status: 'completed',
          type: 'function_call',
        }
  })
}

function codexEvents(id, model, items) {
  const response = {
    created_at: 0,
    id: 'resp_' + id,
    model,
    object: 'response',
    output: items,
    status: 'completed',
    usage: {
      input_tokens: codexUsage.input,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: codexUsage.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: codexUsage.input + codexUsage.output,
    },
  }
  return [
    [
      'response.created',
      {
        response: { ...response, output: [], status: 'in_progress', usage: null },
        type: 'response.created',
      },
    ],
    ...items.map((item, index) => [
      'response.output_item.done',
      { item, output_index: index, type: 'response.output_item.done' },
    ]),
    ['response.completed', { response, type: 'response.completed' }],
  ]
}

export async function startModel(options) {
  const { decide, out } = options
  const requests = []
  const chains = new Map()
  const state = { answerDelayMs: options.answerDelayMs ?? 300, hook: undefined, sockets: 0 }
  let serial = 0
  const toolTypes = new Map()
  Fs.mkdirSync(Path.join(out, 'bodies'), { recursive: true })

  const record = (shape, transport, body) => {
    const n = ++serial
    Fs.writeFileSync(
      Path.join(out, 'bodies', n + '-' + shape + '-' + transport + '.json'),
      JSON.stringify(body, null, 1),
    )
    let view
    let full
    if (shape === 'claude') view = claudeView(body)
    else {
      const input = Array.isArray(body.input)
        ? body.input
        : [{ type: 'message', role: 'user', content: body.input }]
      const before = body.previous_response_id ? chains.get(body.previous_response_id) : []
      full = [...(before ?? []), ...input]
      view = codexView(full)
      view.unknownPrevious =
        body.previous_response_id !== undefined &&
        body.previous_response_id !== null &&
        before === undefined
    }
    const step = decide(view, { body, shape })
    const entry = {
      n,
      shape,
      transport,
      model: body.model,
      decision: step.label,
      digest: Crypto.createHash('sha256')
        .update(
          JSON.stringify(view.calls.map((call) => [call.name, call.input, call.output ?? null])),
        )
        .digest('hex')
        .slice(0, 16),
      raw: Crypto.createHash('sha256')
        .update(JSON.stringify(shape === 'claude' ? body.messages : body.input))
        .digest('hex')
        .slice(0, 16),
      previous: body.previous_response_id ?? null,
      inputItems:
        shape === 'claude'
          ? (body.messages ?? []).length
          : Array.isArray(body.input)
            ? body.input.length
            : 1,
      outputs: view.calls.map((call) => call.output ?? null),
      startedAt: Date.now(),
      answeredAt: null,
      generate: body.generate,
    }
    requests.push(entry)
    return { entry, full, step, view }
  }

  const answer = async (seen, body, shape) => {
    const { entry, full, step } = seen
    const hold = (await state.hook?.('request', entry)) === 'hold'
    if (hold) return undefined
    await sleep(state.answerDelayMs)
    const id = entry.n
    if (shape === 'claude') return { text: claudeReply(id, body.model, step) }
    for (const tool of [
      ...(body.tools ?? []),
      ...(Array.isArray(body.input) ? body.input : []).flatMap((item) =>
        item.type === 'additional_tools' ? item.tools : [],
      ),
    ])
      toolTypes.set(tool.name, tool.type)
    const items = codexItems(id, step, toolTypes)
    chains.set('resp_' + id, [...full, ...items])
    return { events: codexEvents(id, body.model, items) }
  }

  const server = Http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const path = new URL(request.url, 'http://model').pathname
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || 'null')
    } catch {
      body = null
    }
    if (
      request.method !== 'POST' ||
      !body ||
      (path !== '/v1/messages' && !path.endsWith('/responses'))
    ) {
      Fs.appendFileSync(
        Path.join(out, 'model-other.log'),
        request.method + ' ' + request.url + '\n',
      )
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { message: 'not scripted', type: 'invalid_request_error' } }),
      )
      return
    }
    const shape = path === '/v1/messages' ? 'claude' : 'codex'
    try {
      const seen = record(shape, 'http', body)
      const reply = await answer(seen, body, shape)
      if (!reply) return
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(reply.text ?? sse(reply.events), () => {
        seen.entry.answeredAt = Date.now()
        void state.hook?.('answered', seen.entry)
      })
    } catch (error) {
      Fs.appendFileSync(
        Path.join(out, 'model-other.log'),
        'error ' + String(error?.stack ?? error) + '\n',
      )
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: String(error), type: 'api_error' } }))
    }
  })

  const sockets = new Set()
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url, 'http://model').pathname
    if (!options.websocket || !path.endsWith('/responses')) {
      Fs.appendFileSync(Path.join(out, 'model-other.log'), 'upgrade refused ' + request.url + '\n')
      socket.end('HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\n\r\n')
      return
    }
    state.sockets++
    const ws = accept(request, socket, head, async (data) => {
      let body
      try {
        body = JSON.parse(data)
      } catch {
        return
      }
      if (body.type !== 'response.create') {
        Fs.appendFileSync(
          Path.join(out, 'model-other.log'),
          'socket message ' + data.slice(0, 300) + '\n',
        )
        return
      }
      try {
        const seen = record('codex', 'ws', body)
        const reply = await answer(seen, body, 'codex')
        if (!reply) return
        for (const [, event] of reply.events) ws.send(JSON.stringify(event))
        seen.entry.answeredAt = Date.now()
        void state.hook?.('answered', seen.entry)
      } catch (error) {
        Fs.appendFileSync(
          Path.join(out, 'model-other.log'),
          'error ' + String(error?.stack ?? error) + '\n',
        )
        ws.send(
          JSON.stringify({ type: 'error', error: { message: String(error), type: 'api_error' } }),
        )
      }
    })
    sockets.add(ws)
    socket.on('close', () => sockets.delete(ws))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    close: () => {
      for (const client of sockets) client.terminate()
      server.closeAllConnections()
      server.close()
    },
    requests,
    state,
    url: 'http://127.0.0.1:' + server.address().port,
    usage: (shape) => (shape === 'claude' ? claudeUsage : codexUsage),
  }
}

export async function startWorker(options) {
  const { out, port, vars } = options
  const log = Fs.openSync(Path.join(out, 'wrangler.log'), 'a')
  const child = spawn(
    wrangler[0],
    [
      ...wrangler.slice(1),
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(port + 1),
      '--persist-to',
      Path.join(out, 'state'),
      '--show-interactive-dev-session=false',
      ...Object.entries(vars).flatMap(([name, value]) => ['--var', name + ':' + value]),
    ],
    {
      cwd: here,
      detached: true,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        WRANGLER_SEND_METRICS: 'false',
        CI: '1',
      },
      stdio: ['ignore', log, log],
    },
  )
  Fs.closeSync(log)
  const url = 'http://127.0.0.1:' + port
  const started = Date.now()
  for (;;) {
    const healthy = await fetch(url + '/health').then(
      (response) => response.ok,
      () => false,
    )
    if (healthy) return { child, startMs: Date.now() - started, url }
    if (Date.now() - started > 90_000 || child.exitCode !== null)
      throw new Error('wrangler dev did not start; see ' + Path.join(out, 'wrangler.log'))
    await sleep(100)
  }
}

export async function stopWorker(worker, signal = 'SIGKILL') {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return
  const exited = new Promise((resolve) => worker.child.once('exit', resolve))
  try {
    process.kill(-worker.child.pid, signal)
  } catch {}
  await exited
}

export function startHand(options) {
  const { dir, name, out, token, url } = options
  Fs.mkdirSync(dir, { recursive: true })
  const log = Fs.openSync(Path.join(out, 'hand-' + name + '.log'), 'a')
  const child = spawn(
    handBinary,
    ['hand', url.replace(/^http/, 'ws'), '--name', name, '-C', dir, '--own-processes'],
    {
      detached: true,
      env: {
        HOME: Path.join(out, 'hand-home-' + name),
        NANOCODE_HOME: Path.join(out, 'hand-home-' + name, 'nanocode'),
        NANOCODE_RUNNER_TOKEN: token,
        PATH: process.env.PATH,
      },
      stdio: ['ignore', log, log],
    },
  )
  Fs.closeSync(log)
  return child
}

export function stopHand(child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
}

export function client(url, token) {
  const call = (path, init = {}) =>
    fetch(url + path, {
      ...init,
      headers: { ...init.headers, authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    })
  return {
    call,
    events: async (session) => {
      const all = []
      let after = 0
      for (;;) {
        const response = await call(
          '/sessions/' + session + '/events?after=' + after + '&limit=128',
        )
        if (!response.ok)
          throw new Error('events answered ' + response.status + ': ' + (await response.text()))
        const page = await response.json()
        all.push(...page.events)
        if (!page.has_more || page.next_cursor <= after) return all
        after = page.next_cursor
      }
    },
    published: async (session) => {
      const response = await call('/sessions/' + session + '/events', {
        headers: { 'x-harness-published': '1' },
      })
      if (!response.ok)
        throw new Error('published answered ' + response.status + ': ' + (await response.text()))
      return response.json()
    },
    hands: async (session) => {
      const response = await call('/sessions/' + session + '/hands')
      return response.ok ? (await response.json()).hands : []
    },
    metrics: async (session) => {
      const response = await call('/sessions/' + session + '/metrics')
      return response.ok ? response.json() : { error: response.status }
    },
    submit: async (session, turn) => {
      const response = await call('/sessions/' + session + '/turns', {
        body: JSON.stringify(turn),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      return { body: await response.json().catch(() => null), status: response.status }
    },
    token: async (session) => {
      const response = await call('/sessions/' + session + '/hands', { method: 'POST' })
      if (!response.ok)
        throw new Error(
          'minting a hand token answered ' + response.status + ': ' + (await response.text()),
        )
      return (await response.json()).token
    },
    turn: async (session, id) => {
      const response = await call('/sessions/' + session + '/turns/' + id).catch((error) => ({
        ok: false,
        status: String(error),
      }))
      return response.ok ? response.json() : { status: 'http ' + response.status }
    },
  }
}

export function storage(out) {
  const found = []
  for (const name of Fs.readdirSync(Path.join(out, 'state'), { recursive: true })) {
    if (!name.endsWith('.sqlite') || Path.basename(name).includes('metadata')) continue
    const scratch = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'resume-'))
    try {
      for (const suffix of ['', '-wal', '-shm'])
        if (Fs.existsSync(Path.join(out, 'state', name + suffix)))
          Fs.copyFileSync(
            Path.join(out, 'state', name + suffix),
            Path.join(scratch, 'db.sqlite' + suffix),
          )
      const database = new DatabaseSync(Path.join(scratch, 'db.sqlite'))
      const tables = Object.fromEntries(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name)
          .filter((table) => !table.startsWith('_cf_') && !table.startsWith('sqlite_'))
          .map((table) => [
            table,
            database.prepare('SELECT count(*) AS rows FROM "' + table + '"').get().rows,
          ]),
      )
      found.push({
        file: Path.basename(name),
        hand_requests:
          tables.hand_requests === undefined
            ? undefined
            : database
                .prepare(
                  'SELECT id, call_id, replied IS NOT NULL AS replied FROM hand_requests ORDER BY id',
                )
                .all()
                .map((row) => [row.id, row.call_id, row.replied]),
        tables,
      })
      database.close()
    } catch (error) {
      found.push({ error: String(error), file: Path.basename(name) })
    } finally {
      Fs.rmSync(scratch, { force: true, recursive: true })
    }
  }
  return found
}

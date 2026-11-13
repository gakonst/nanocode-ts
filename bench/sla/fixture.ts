import * as Fs from 'node:fs'
import * as Http from 'node:http'

import { marks } from './fixture-marks.ts'

type Scenario = {
  readonly turn: number
  readonly rate: number
  readonly run: string
  readonly tokens: number
  readonly tool: boolean
  readonly ttft: number
}

type Entry = {
  arrive_ns: bigint
  body_end_ns?: bigint
  conn: number
  conn_age_ms: number
  conn_new: boolean
  done_ns?: bigint
  first_token_ns?: bigint
  headers_ns?: bigint
  kind: 'side' | 'text' | 'tool'
  last_token_ns?: bigint
  path: string
  protocol: string
  request_bytes: number
  step: number
  tools: readonly string[]
}

const now = () => process.hrtime.bigint()
const runs = new Map<string, Entry[]>()
let connections = 0

export const token = (turn: number, i: number, n: number) => (i === n - 1 ? marks(turn).last + '\n' : marks(turn).first + i + ((i + 1) % 16 === 0 ? '\n' : ' '))

function scenario(body: string): Scenario {
  const found = [...body.matchAll(/SLA\[([A-Za-z0-9_=,.\-]+)\]/g)].at(-1)
  const pairs = new Map((found?.[1] ?? '').split(',').map((pair) => pair.split('=') as [string, string]))
  return {
    rate: Number(pairs.get('rate') ?? 0),
    run: pairs.get('run') ?? 'default',
    tokens: Number(pairs.get('tokens') ?? 1),
    tool: pairs.get('tool') === '1',
    ttft: Number(pairs.get('ttft') ?? 0),
    turn: Number(pairs.get('turn') ?? 1),
  }
}

function toolNames(parsed: any): readonly string[] {
  const listed = Array.isArray(parsed?.tools) ? parsed.tools : []
  const added = Array.isArray(parsed?.input) ? parsed.input.filter((item: any) => item?.type === 'additional_tools').flatMap((item: any) => item.tools ?? []) : []
  return [...listed, ...added].map((tool: any) => tool.name ?? tool.function?.name ?? tool.type).filter(Boolean)
}

function frame(protocol: string, type: string, data: unknown) {
  if (protocol === 'chat') return 'data: ' + JSON.stringify(data) + '\n\n'
  return 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'
}

function encoder(protocol: string, id: string) {
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11 }
  const msg = 'msg_' + id
  const rid = 'resp_' + id
  const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ delta, finish_reason: finish, index: 0 }], created: 1, id: rid, model: 'bench', object: 'chat.completion.chunk' })
  let seq = 0
  return {
    begin(kind: 'text' | 'tool') {
      if (protocol === 'responses') {
        let out = frame(protocol, 'response.created', { response: { id: rid, output: [], status: 'in_progress' }, type: 'response.created' })
        if (kind === 'text') {
          out += frame(protocol, 'response.output_item.added', { item: { content: [], id: msg, role: 'assistant', status: 'in_progress', type: 'message' }, output_index: 0, type: 'response.output_item.added' })
          out += frame(protocol, 'response.content_part.added', { content_index: 0, item_id: msg, output_index: 0, part: { annotations: [], text: '', type: 'output_text' }, type: 'response.content_part.added' })
        }
        return out
      }
      if (protocol === 'messages') {
        let out = frame(protocol, 'message_start', { message: { content: [], id: msg, model: 'bench', role: 'assistant', stop_reason: null, stop_sequence: null, type: 'message', usage: { input_tokens: 10, output_tokens: 0 } }, type: 'message_start' })
        if (kind === 'text') out += frame(protocol, 'content_block_start', { content_block: { text: '', type: 'text' }, index: 0, type: 'content_block_start' })
        return out
      }
      return frame(protocol, 'chunk', chunk({ content: '', role: 'assistant' }))
    },
    delta(text: string) {
      if (protocol === 'responses') return frame(protocol, 'response.output_text.delta', { content_index: 0, delta: text, item_id: msg, output_index: 0, sequence_number: ++seq, type: 'response.output_text.delta' })
      if (protocol === 'messages') return frame(protocol, 'content_block_delta', { delta: { text, type: 'text_delta' }, index: 0, type: 'content_block_delta' })
      return frame(protocol, 'chunk', chunk({ content: text }))
    },
    end(full: string) {
      if (protocol === 'responses') {
        const item = { content: [{ annotations: [], text: full, type: 'output_text' }], id: msg, role: 'assistant', status: 'completed', type: 'message' }
        return (
          frame(protocol, 'response.output_text.done', { content_index: 0, item_id: msg, output_index: 0, text: full, type: 'response.output_text.done' }) +
          frame(protocol, 'response.content_part.done', { content_index: 0, item_id: msg, output_index: 0, part: item.content[0], type: 'response.content_part.done' }) +
          frame(protocol, 'response.output_item.done', { item, output_index: 0, type: 'response.output_item.done' }) +
          frame(protocol, 'response.completed', { response: { id: rid, output: [item], status: 'completed', usage }, type: 'response.completed' })
        )
      }
      if (protocol === 'messages') {
        return (
          frame(protocol, 'content_block_stop', { index: 0, type: 'content_block_stop' }) +
          frame(protocol, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, type: 'message_delta', usage: { output_tokens: 1 } }) +
          frame(protocol, 'message_stop', { type: 'message_stop' })
        )
      }
      return frame(protocol, 'chunk', chunk({}, 'stop')) + 'data: [DONE]\n\n'
    },
    tool(names: readonly string[]) {
      const call: { custom?: boolean; input: any; name: string } = (() => {
        if (names.includes('exec')) return protocol === 'responses' ? { custom: true, input: 'text(1)', name: 'exec' } : { input: { code: 'text(1)' }, name: 'exec' }
        if (names.includes('Bash')) return { input: { command: 'true', description: 'Run true' }, name: 'Bash' }
        if (names.includes('exec_command')) return { input: { cmd: 'true' }, name: 'exec_command' }
        if (names.includes('shell_command')) return { input: { command: 'true' }, name: 'shell_command' }
        if (names.includes('shell')) return { input: { command: ['true'] }, name: 'shell' }
        throw new Error('no shell or exec tool among ' + names.join(','))
      })()
      const callId = 'call_' + id
      if (protocol === 'responses') {
        const item: any = call.custom
          ? { call_id: callId, id: 'ctc_' + id, input: call.input, name: call.name, status: 'completed', type: 'custom_tool_call' }
          : { arguments: JSON.stringify(call.input), call_id: callId, id: 'fc_' + id, name: call.name, status: 'completed', type: 'function_call' }
        const delta = call.custom
          ? frame(protocol, 'response.custom_tool_call_input.delta', { delta: call.input, item_id: item.id, output_index: 0, type: 'response.custom_tool_call_input.delta' })
          : frame(protocol, 'response.function_call_arguments.delta', { delta: JSON.stringify(call.input), item_id: item.id, output_index: 0, type: 'response.function_call_arguments.delta' })
        const added = call.custom ? { ...item, input: '', status: 'in_progress' } : { ...item, arguments: '', status: 'in_progress' }
        return (
          frame(protocol, 'response.output_item.added', { item: added, output_index: 0, type: 'response.output_item.added' }) +
          delta +
          frame(protocol, 'response.output_item.done', { item, output_index: 0, type: 'response.output_item.done' }) +
          frame(protocol, 'response.completed', { response: { id: rid, output: [item], status: 'completed', usage }, type: 'response.completed' })
        )
      }
      if (protocol === 'messages') {
        return (
          frame(protocol, 'content_block_start', { content_block: { id: callId, input: {}, name: call.name, type: 'tool_use' }, index: 0, type: 'content_block_start' }) +
          frame(protocol, 'content_block_delta', { delta: { partial_json: JSON.stringify(call.input), type: 'input_json_delta' }, index: 0, type: 'content_block_delta' }) +
          frame(protocol, 'content_block_stop', { index: 0, type: 'content_block_stop' }) +
          frame(protocol, 'message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, type: 'message_delta', usage: { output_tokens: 1 } }) +
          frame(protocol, 'message_stop', { type: 'message_stop' })
        )
      }
      return (
        frame(protocol, 'chunk', chunk({ tool_calls: [{ function: { arguments: JSON.stringify(call.input), name: call.name }, id: callId, index: 0, type: 'function' }] })) +
        frame(protocol, 'chunk', chunk({}, 'tool_calls')) +
        'data: [DONE]\n\n'
      )
    },
  }
}

const sleepUntil = (target: bigint) =>
  new Promise<void>((resolve) => {
    const tick = () => {
      const left = Number(target - now()) / 1e6
      if (left <= 0) return resolve()
      if (left >= 1.5) setTimeout(tick, Math.floor(left - 1))
      else setImmediate(tick)
    }
    tick()
  })

const write = (res: Http.ServerResponse, text: string) => (res.write(text) ? null : new Promise<void>((resolve) => res.once('drain', () => resolve())))

async function stream(res: Http.ServerResponse, enc: ReturnType<typeof encoder>, sc: Scenario, entry: Entry) {
  res.write(enc.begin('text'))
  await sleepUntil(entry.headers_ns! + BigInt(Math.round(sc.ttft * 1e6)))
  const texts = Array.from({ length: sc.tokens }, (_, i) => token(sc.turn, i, sc.tokens))
  const t0 = now()
  let sent = 0
  while (sent < texts.length) {
    if (res.destroyed) break
    const due = sc.rate > 0 ? Math.min(texts.length, Math.floor((Number(now() - t0) / 1e9) * sc.rate) + 1) : sent + 1
    const batch = texts.slice(sent, due)
    entry.first_token_ns ??= now()
    const wait = write(res, batch.map((text) => enc.delta(text)).join(''))
    sent += batch.length
    if (wait) await wait
    if (sc.rate > 0 && sent < texts.length) await sleepUntil(t0 + BigInt(Math.ceil((sent / sc.rate) * 1e9)))
  }
  entry.last_token_ns = now()
  res.end(enc.end(texts.join('')))
}

const server = Http.createServer((req, res) => {
  const arrive = now()
  const url = new URL(req.url ?? '/', 'http://fixture')
  const socket = req.socket as any
  const connNew = socket.slaConn === undefined
  socket.slaConn ??= ++connections
  if (url.pathname === '/_log') {
    const id = url.searchParams.get('run') ?? ''
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(runs.get(id) ?? [], (_, value) => (typeof value === 'bigint' ? value.toString() : value)))
  }
  if (req.method === 'GET') {
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: ['bench/model', 'luna', 'gpt-5.5'].map((id) => ({ context_window: 1000000, id, max_tokens: 32000, object: 'model', type: 'language' })), object: 'list' }))
  }
  const protocol = url.pathname.endsWith('/responses') ? 'responses' : url.pathname.endsWith('/messages') ? 'messages' : url.pathname.endsWith('/chat/completions') ? 'chat' : null
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8')
    if (url.pathname.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ input_tokens: 10 }))
    }
    if (!protocol) {
      res.writeHead(404)
      return res.end('unknown endpoint ' + url.pathname)
    }
    const parsed = (() => {
      try {
        return JSON.parse(body)
      } catch {
        return null
      }
    })()
    const names = toolNames(parsed)
    if (process.env.DUMP) Fs.writeFileSync(process.env.DUMP + '/' + Date.now() + '-' + connections + '.json', req.headers['content-encoding'] + ' ' + url.pathname + '\n' + body)
    const sc = scenario(body)
    const list = runs.get(sc.run) ?? []
    runs.set(sc.run, list)
    const main = list.filter((entry) => entry.kind !== 'side')
    const kind = names.length === 0 ? 'side' : sc.tool && main.length === 0 ? 'tool' : 'text'
    const entry: Entry = { arrive_ns: arrive, body_end_ns: now(), conn: socket.slaConn, conn_age_ms: Number(arrive - socket.slaOpened) / 1e6, conn_new: connNew, kind, path: url.pathname, protocol, request_bytes: Buffer.byteLength(body), step: main.length, tools: names }
    list.push(entry)
    const enc = encoder(protocol, String(connections) + '_' + list.length)
    if (kind === 'side' && parsed?.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      entry.done_ns = now()
      if (protocol === 'messages') return res.end(JSON.stringify({ content: [{ text: 'ok', type: 'text' }], id: 'msg_side', model: 'bench', role: 'assistant', stop_reason: 'end_turn', stop_sequence: null, type: 'message', usage: { input_tokens: 10, output_tokens: 1 } }))
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', index: 0, message: { content: 'ok', role: 'assistant' } }], id: 'side', object: 'chat.completion' }))
    }
    res.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' })
    res.flushHeaders()
    entry.headers_ns = now()
    if (kind === 'side') {
      res.end(enc.begin('text') + enc.delta('ok') + enc.end('ok'))
      entry.done_ns = now()
      return
    }
    if (kind === 'tool') {
      entry.first_token_ns = now()
      res.end(enc.begin('tool') + enc.tool(names))
      entry.done_ns = now()
      return
    }
    await stream(res, enc, sc, entry)
    entry.done_ns = now()
  })
})

server.on('connection', (socket: any) => {
  socket.slaOpened = now()
})
server.keepAliveTimeout = 120000
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  const address = server.address() as { port: number }
  process.stdout.write(JSON.stringify({ pid: process.pid, port: address.port }) + '\n')
})

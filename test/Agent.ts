/**
 * Agent sessions over the real WebAssembly module, with stand-in model APIs that answer in the providers' wire formats.
 *
 * @module
 */
import * as fs from 'node:fs'
import * as Sqlite from './Sqlite.ts'
import type * as Contracts from '../src/Contracts.ts'
import * as AgentRuntime from '../src/AgentRuntime.ts'

const endpoints = {
  claude: 'https://api.anthropic.com/v1/messages',
  codex: 'https://api.openai.com/v1',
} as const

/** Host tool that every session offers. It returns `bravo` for the key `alpha`. */
export const lookup = {
  description: 'Look up the value stored under a key.',
  name: 'lookup',
  parameters: {
    additionalProperties: false,
    properties: { key: { type: 'string' } },
    required: ['key'],
    type: 'object',
  },
} satisfies Contracts.HostTool

/** Session scope of every session. */
export const scope = 'owner'

/** Compiles the WebAssembly module from `dist/`. */
export function compile() {
  return WebAssembly.compile(fs.readFileSync('dist/nanocode_wasm.wasm'))
}

/** Model request that a session sent. */
export type Request = { credentialFree: boolean; messages: number; tools: readonly string[] }

/** Opens a session on a SQLite file. */
export async function open(options: open.Options) {
  const store = Sqlite.open({ path: options.database })
  const events: unknown[] = []
  const runtime = await AgentRuntime.instantiate(options.module, store.sql, {
    published: (batch) => events.push(...batch),
  })

  await runtime.open(
    {
      endpoint: endpoints[options.provider],
      event_coalesce_ms: 0,
      provider: options.provider,
      scope,
      session_id: options.sessionId,
      stream_tool_input: true,
      subscription: false,
      tools: [lookup],
    },
    {
      dispatch: async (request) => {
        const body = JSON.parse(new TextDecoder().decode(request.body))
        options.requests.push({
          credentialFree: !request.headers.some((header) =>
            ['authorization', 'x-api-key'].includes(header[0].toLowerCase()),
          ),
          messages: (body.messages ?? body.input).length,
          tools: (
            body.tools ??
            body.input.flatMap((item: { tools?: unknown[]; type: string }) =>
              item.type === 'additional_tools' ? item.tools : [],
            )
          ).map((tool: { name: string }) => tool.name),
        })
        return options.provider === 'claude' ? claude(body) : codex(body)
      },
      tools: {
        call: async (name, input) => {
          if (name !== lookup.name || (input as { key?: string })?.key !== 'alpha')
            throw new Error(`Unexpected tool call: ${name}.`)
          return { key: 'alpha', value: 'bravo' }
        },
      },
    },
  )

  return { events, runtime, store }
}

export declare namespace open {
  type Options = {
    database: string
    module: WebAssembly.Module
    provider: Contracts.ModelProvider
    requests: Request[]
    sessionId: string
  }
}

/** Runs one turn to completion and returns its status. */
export async function turn(runtime: AgentRuntime.AgentRuntime, requestId: string) {
  const submitted = await runtime.submit(scope, {
    metadata: {},
    prompt: `Look up alpha for ${requestId}`,
    request_id: requestId,
  })
  if (submitted.submitted !== 'accepted') return submitted.submitted

  for (;;) {
    const next = (await runtime.pending(scope))[0]
    if (!next) break
    const driven = await runtime.drive(next.report.request_id)
    if (driven.retry) return 'retry'
    if (driven.waiting) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  while (!(await runtime.settle())) await new Promise((resolve) => setTimeout(resolve, 10))

  const report = (await runtime.turn(scope, requestId))?.report
  if (!JSON.stringify(report).includes('the value is bravo')) return 'missing answer'
  return report?.status
}

let calls = 0

/** Stand-in for the Anthropic Messages API, in its Server-Sent Events wire format. */
function claude(input: any) {
  const call = calls++
  const last = input.messages.at(-1).content
  const answered =
    Array.isArray(last) && last.some((block: { type: string }) => block.type === 'tool_result')
  const blocks = answered
    ? [
        [
          { text: '', type: 'text' },
          { text: 'the value is bravo', type: 'text_delta' },
        ],
      ]
    : [
        [
          { id: `toolu_${call}`, input: {}, name: lookup.name, type: 'tool_use' },
          { partial_json: JSON.stringify({ key: 'alpha' }), type: 'input_json_delta' },
        ],
      ]

  return sse([
    [
      'message_start',
      {
        message: {
          content: [],
          id: `message-${call}`,
          model: input.model,
          role: 'assistant',
          stop_reason: null,
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 8, output_tokens: 0 },
        },
        type: 'message_start',
      },
    ],
    ...blocks.flatMap((pair, index) => [
      ['content_block_start', { content_block: pair[0], index, type: 'content_block_start' }],
      ['content_block_delta', { delta: pair[1], index, type: 'content_block_delta' }],
      ['content_block_stop', { index, type: 'content_block_stop' }],
    ]),
    [
      'message_delta',
      {
        delta: { stop_reason: answered ? 'end_turn' : 'tool_use', stop_sequence: null },
        type: 'message_delta',
        usage: { output_tokens: 4 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ] as [string | null, unknown][])
}

/** Stand-in for the OpenAI Responses API, in its Server-Sent Events wire format. */
function codex(input: any) {
  const items = input.input
  const user = items.findLastIndex(
    (item: { role?: string; type: string }) => item.type === 'message' && item.role === 'user',
  )
  const answered = items.some(
    (item: { type: string }, index: number) => index > user && item.type === 'function_call_output',
  )
  const call = calls++
  const id = `resp_${call}`
  const item = answered
    ? {
        content: [{ text: 'the value is bravo', type: 'output_text' }],
        id: `msg_${call}`,
        role: 'assistant',
        status: 'completed',
        type: 'message',
      }
    : {
        arguments: JSON.stringify({ key: 'alpha' }),
        call_id: `call_${call}`,
        id: `fc_${call}`,
        name: lookup.name,
        status: 'completed',
        type: 'function_call',
      }

  return sse([
    [null, { response: { id, status: 'in_progress' }, type: 'response.created' }],
    [
      null,
      {
        item: item.type === 'message' ? { ...item, content: [], status: 'in_progress' } : item,
        output_index: 0,
        type: 'response.output_item.added',
      },
    ],
    ...(item.type === 'message'
      ? [
          [
            null,
            {
              content_index: 0,
              delta: 'the value is bravo',
              item_id: item.id,
              output_index: 0,
              type: 'response.output_text.delta',
            },
          ] as [null, unknown],
        ]
      : []),
    [null, { item, output_index: 0, type: 'response.output_item.done' }],
    [
      null,
      {
        response: {
          id,
          model: input.model,
          output: [item],
          status: 'completed',
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        },
        type: 'response.completed',
      },
    ],
  ])
}

function sse(events: readonly [string | null, unknown][]) {
  const body = events
    .map(
      (entry) => (entry[0] ? `event: ${entry[0]}\n` : '') + `data: ${JSON.stringify(entry[1])}\n\n`,
    )
    .join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

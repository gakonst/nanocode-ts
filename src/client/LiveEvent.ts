import type * as Contracts from '../Contracts.ts'

export type LiveEvent = { type: string; [field: string]: unknown }

type AgentEvent = { type: string; payload: Record<string, unknown> }

type LoggedBody = {
  source?: string
  event?: AgentEvent
  type?: string
  status?: string
  ok?: { message?: string }
  error?: unknown
}

export function at(event: LiveEvent): number {
  return typeof event.at === 'number' ? event.at : Date.now()
}

export function fromLogged(logged: Contracts.LoggedEvent): LiveEvent | undefined {
  const body = logged.event as LoggedBody
  const base = {
    ...(logged.seq > 0 ? { seq: logged.seq } : {}),
    request_id: logged.request_id,
    ...(typeof logged.created_at === 'number' ? { at: logged.created_at } : {}),
  }
  if (body.source === 'agent' && body.event) {
    const { type, payload } = body.event
    switch (type) {
      case 'assistant.delta':
        return {
          type: 'text',
          delta: payload.text,
          item: payload.item_id,
          ...(typeof payload.offset === 'number' ? { offset: payload.offset } : {}),
          ...base,
        }
      case 'assistant.message':
        return typeof payload.text === 'string' && payload.text
          ? { type: 'text', delta: payload.text, item: payload.item_id, offset: 0, ...base }
          : undefined
      case 'reasoning.summary.delta':
        return {
          type: 'reasoning',
          delta: payload.text,
          item: `reasoning:${payload.model_call_index}`,
          ...base,
        }
      case 'tool.input.delta':
        return {
          type: 'tool_input',
          name: payload.tool,
          delta: payload.text,
          call_id: payload.call_id,
          ...(typeof payload.offset === 'number' ? { offset: payload.offset } : {}),
          ...base,
        }
      case 'tool.call':
        return {
          type: 'tool_start',
          name: payload.tool,
          args: payload.arguments,
          call_id: payload.call_id,
          parent: parentOf(payload),
          ...base,
        }
      case 'tool.notification':
        return { type: 'tool_output', call_id: payload.call_id, text: payload.text, ...base }
      case 'tool.result':
        return {
          type: 'tool_end',
          name: payload.tool,
          call_id: payload.call_id,
          parent: parentOf(payload),
          status: payload.status,
          result: payload.result,
          structured: payload.structured_result,
          duration_ns: payload.duration_ns,
          ...base,
        }
      default:
        return undefined
    }
  }
  if (body.source !== undefined) return undefined
  if (body.type === 'result')
    return {
      type: 'turn',
      status: body.status,
      ...(body.ok?.message !== undefined ? { message: body.ok.message } : {}),
      ...(body.error !== undefined ? { error: body.error } : {}),
      ...base,
    }
  if (body.type === 'retrying') return { type: 'retrying', ...body, ...base }
  return undefined
}

function parentOf(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.parent_call_id === 'string' && payload.parent_call_id)
    return payload.parent_call_id
  const id = typeof payload.call_id === 'string' ? payload.call_id : ''
  const slash = id.lastIndexOf('/')
  return slash > 0 ? id.slice(0, slash) : undefined
}

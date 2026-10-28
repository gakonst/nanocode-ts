import type { ModelProvider, Thinking, ToolCallContext } from '../index.ts'

export type { Thinking }

export const THINKING: readonly Thinking[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

export const EXECUTOR_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
export const DEFAULT_EXECUTOR = 'default'

export type SessionAuthority = {
  account_id: string
  session_id: string
  executor_id?: string
}

export type SessionDescriptor = SessionAuthority & {
  provider?: ModelProvider
  model?: string
  thinking?: Thinking
  web_search?: boolean
  session_name: string
  subscription: boolean
  codex_subscription?: boolean
  hand?: string
  read_only?: boolean
  grant?: unknown
  expires_at?: number
  hand_token?: string
}

export const HAND_TOKEN = /^nch_([0-9a-f]{2,512})_([0-9a-f]{64})$/

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export function handToken(account: string, secret: string): string {
  return `nch_${hex(new TextEncoder().encode(account))}_${secret}`
}

export function handTokenAccount(encoded: string): string | null {
  if (encoded.length % 2) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(encoded.match(/../g)!, (pair) => parseInt(pair, 16)),
    )
  } catch {
    return null
  }
}

export function handSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)))
}

export type ModelDispatch = {
  provider?: ModelProvider
  authority: SessionAuthority
  endpoint: string
  headers: [string, string][]
  subscription: boolean
}

export type SocketDispatch = Pick<ModelDispatch, 'provider' | 'authority' | 'headers'>

export interface PrivateBinding {
  fetch(request: Request): Promise<Response>
}

export type HostToolCall = {
  authority: SessionAuthority
  name: string
  input: unknown
  context: ToolCallContext
  grant?: unknown
}

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers)
  result.set('content-type', 'application/json')
  result.set('cache-control', 'no-store')
  return new Response(JSON.stringify(value), { status, headers: result })
}

export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

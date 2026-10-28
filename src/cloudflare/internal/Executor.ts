import * as Remote from '../../Remote.ts'
import type * as App from '../App.ts'
import { headerJson } from './Http.ts'

export class RejectedError extends Error {
  override readonly name = 'Executor.RejectedError'
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const defaultId = 'default'

export const idPattern = /^[a-z0-9][a-z0-9_-]{0,47}$/

export function connect(
  binding: App.PrivateBinding,
  options: connect.Options,
): Promise<Remote.Executor<WebSocket>> {
  return Remote.connect(async (signal) => {
    const response = await binding.fetch(
      new Request('https://egress.internal/remote', {
        headers: { upgrade: 'websocket', 'x-nanocode-authority': headerJson(options.authority) },
        signal,
      }),
    )
    const socket = response.webSocket
    if (response.status !== 101 || !socket) {
      const detail = await response.json<{ error?: string }>().then(
        (body) => body.error,
        () => undefined,
      )
      throw new RejectedError(
        response.status,
        `remote executor connection rejected with status ${response.status}${detail ? `: ${detail}` : ''}`,
      )
    }
    socket.accept()
    return socket
  }, options.policy)
}

export declare namespace connect {
  type Options = {
    authority: App.SessionAuthority
    policy: Remote.Policy
  }
}

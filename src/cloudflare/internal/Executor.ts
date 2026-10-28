/**
 * Remote executors of a session: names of the executors, and the connection to an executor through
 * the host's egress binding.
 *
 * @module
 */
import * as Remote from '../../Remote.ts'
import type * as App from '../App.ts'
import { headerJson } from './Http.ts'

/** Refusal of a remote executor connection, with the HTTP status of the egress. */
export class RejectedError extends Error {
  override readonly name = 'Executor.RejectedError'
  /** HTTP status of the refused upgrade. */
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Executor that a session uses when its descriptor names none. */
export const defaultId = 'default'

/** Pattern of an executor name, which is also the pattern of a hand name. */
export const idPattern = /^[a-z0-9][a-z0-9_-]{0,47}$/

/**
 * Opens a remote executor over the WebSocket that `binding` returns for `/remote`. Throws
 * `RejectedError` when the egress refuses the upgrade.
 */
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
    /** Session that the executor serves. */
    authority: App.SessionAuthority
    /** Frame and time limits of the executor. */
    policy: Remote.Policy
  }
}

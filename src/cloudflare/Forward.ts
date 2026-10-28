/**
 * Egress that sends the sessions' model requests and Codex sockets as ordinary requests to their upstream URL through
 * a host `fetch`, such as a credential-injecting proxy's: iron-proxy's reverse listener behind an
 * `mtls_certificates` binding, or a container's. The host decides where each request goes and adds what it needs.
 *
 * @module
 */
import type * as App from './App.ts'

/** Returns the `egress` of `App.create` that hands each model request and Codex socket to `options.fetch`. */
export function create(options: create.Options): App.PrivateBinding {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/model' && request.method === 'POST') {
        const dispatch = header<App.ModelDispatch>(request, 'x-nanocode-model')
        if (!dispatch) return refuse(400, 'invalid model dispatch')
        return options.fetch(
          new Request(dispatch.endpoint, {
            method: 'POST',
            headers: dispatch.headers,
            body: request.body,
            signal: request.signal,
          }),
          dispatch,
        )
      }
      if (pathname === '/socket') {
        const dispatch = header<App.SocketDispatch>(request, 'x-nanocode-socket')
        if (!dispatch) return refuse(400, 'invalid socket dispatch')
        const headers = new Headers(dispatch.headers)
        headers.set('upgrade', 'websocket')
        return options.fetch(
          new Request(dispatch.endpoint, { headers, signal: request.signal }),
          dispatch,
        )
      }
      if (pathname === '/warm') return new Response(null, { status: 204 })
      if (pathname === '/metrics') return Response.json({ ok: true, egress: 'forward' })
      if (pathname === '/remote')
        return Response.json(
          { error: 'this deployment has no remote executors; attach a hand instead' },
          { status: 501 },
        )
      return refuse(404, 'not_found')
    },
  }
}

export declare namespace create {
  type Options = {
    /**
     * Sends one model request or Codex socket upgrade to its upstream, `request.url`, and returns the upstream's
     * response, such as a 101 with its `webSocket`. `dispatch` names the session's account, provider and whether
     * the request uses the account's plan.
     */
    fetch(request: Request, dispatch: App.ModelDispatch | App.SocketDispatch): Promise<Response>
  }
}

function header<T>(request: Request, name: string): T | undefined {
  try {
    return JSON.parse(request.headers.get(name) ?? '') as T
  } catch {
    return undefined
  }
}

function refuse(status: number, message: string): Response {
  return Response.json({ error: { type: 'invalid_request_error', message } }, { status })
}

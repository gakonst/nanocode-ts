import { Handler } from '../../src/feedback/server/index.ts'

type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> }
  TEMPO_ADMIN?: string | undefined
  TEMPO_AGENT?: string | undefined
  TEMPO_APP: string
  TEMPO_GATEWAY?: string | undefined
  TEMPO_KEY?: string | undefined
  TEMPO_REPO?: string | undefined
}

let feedback: Handler.Handler | undefined

export default {
  fetch(request: Request, env: Env) {
    if (!new URL(request.url).pathname.startsWith('/feedback')) return env.ASSETS.fetch(request)

    feedback ??= Handler.feedback({
      accept: (context) =>
        context.request.headers.get('origin') === new URL(context.request.url).origin,
      admin: (request) =>
        !!env.TEMPO_ADMIN && request.headers.get('authorization') === 'Bearer ' + env.TEMPO_ADMIN,
      agent: env.TEMPO_AGENT,
      app: env.TEMPO_APP,
      gateway: env.TEMPO_GATEWAY,
      key: env.TEMPO_KEY,
      repo: env.TEMPO_REPO,
    })
    return feedback.fetch(request)
  },
}

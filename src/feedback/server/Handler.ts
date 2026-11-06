import type * as Report from '../Report.ts'
import * as Issue from './Issue.ts'

export type Handler = { fetch(request: Request): Promise<Response> }

export type Readiness =
  | { agent: string | null; app: string; ready: true; wallet: string }
  | { help: { href: string; text: string }; ready: false; reason: string }

export function feedback(options: feedback.Options): Handler {
  const base = (options.path ?? '/feedback').replace(/\/+$/, '')
  const gateway = new URL(options.gateway ?? 'https://gateway.tempo-dev.workers.dev').origin
  const help = { href: gateway + '/key', text: 'Get a Tempo Key' }
  const prefix = Issue.board(options.repo)
  let checked: Promise<Readiness> | undefined

  const send = options.fetch ?? ((request: Request) => fetch(request))
  const call = (path: string, body?: unknown) =>
    send(
      new Request(gateway + path, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + options.key,
          'content-type': 'application/json',
          'gateway-app': options.app,
        },
        method: body === undefined ? 'GET' : 'POST',
      }),
    )

  const probe = async (): Promise<Readiness> => {
    if (!options.key)
      return {
        help,
        ready: false,
        reason:
          'The feedback handler has no Tempo Key. Give Handler.feedback the key of the wallet whose app collects the issues.',
      }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.app))
      return { help, ready: false, reason: 'The app must match [a-z0-9][a-z0-9-]{0,62}.' }
    if (options.repo !== undefined && !Issue.repository.test(options.repo))
      return {
        help,
        ready: false,
        reason:
          'The repo is 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit.',
      }

    const response = await call('/api/keys/me').catch((error: unknown) => error as Error)
    if (response instanceof Error)
      return { help, ready: false, reason: `The gateway did not answer: ${response.message}` }
    if (!response.ok)
      return {
        help,
        ready: false,
        reason: `The gateway refused the Tempo Key: ${await detail(response)}`,
      }

    const me = (await response.json()) as { wallet: string }
    return { agent: options.agent ?? null, app: options.app, ready: true, wallet: me.wallet }
  }

  const check = async () => {
    const readiness = await (checked ??= probe())
    if (!readiness.ready) checked = undefined
    return readiness
  }

  const file = async (request: Request) => {
    const readiness = await check()
    if (!readiness.ready) return Response.json(readiness, { status: 503 })

    const body = await request.json().catch(() => undefined)
    const parsed = Issue.parse(body)
    if (!parsed.ok) return problem(400, parsed.error)
    if (options.accept && !(await options.accept({ report: parsed.report, request })))
      return problem(403, 'This report was not accepted.')

    const reporter = (await options.identify?.(request)) ?? undefined
    const at = Date.now()
    const issue = await (async (): Promise<Issue.Issue | Response> => {
      for (;;) {
        const id = options.repo === undefined ? Issue.id(at) : await take(options.repo)
        if (id instanceof Response) return id

        const made = Issue.create({ at, id, report: parsed.report, reporter })
        const stored = await call('/v1/kv/set', {
          ifVersion: null,
          key: prefix + id,
          public: options.public ?? false,
          value: made,
        })
        if (stored.ok) return made
        if (stored.status !== 409 || options.repo === undefined)
          return problem(stored.status, await detail(stored))
      }
    })()
    if (issue instanceof Response) return issue

    const agent = options.agent
      ? await call(`/v1/agents/${encodeURIComponent(options.agent)}/turns`, {
          prompt: Issue.prompt(issue, { key: prefix + issue.id }),
        }).then(
          async (response) => (response.ok ? 'started' : await detail(response)),
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
      : null

    return Response.json({ agent, id: issue.id, link: `${base}/${issue.id}` }, { status: 201 })
  }

  const take = async (repo: string): Promise<string | Response> => {
    for (;;) {
      const read = await call('/v1/kv/get', { key: Issue.counter(repo) })
      if (!read.ok) return problem(read.status, await detail(read))

      const entry = (await read.json()) as { value: { next?: unknown }; version: number } | null
      const next = typeof entry?.value.next === 'number' ? entry.value.next : 1
      const claimed = await call('/v1/kv/set', {
        ifVersion: entry ? entry.version : null,
        key: Issue.counter(repo),
        value: { next: next + 1 },
      })
      if (claimed.ok) return String(next)
      if (claimed.status !== 409) return problem(claimed.status, await detail(claimed))
    }
  }

  const read = async (id: string) => {
    const readiness = await check()
    if (!readiness.ready) return Response.json(readiness, { status: 503 })

    const response = await call('/v1/kv/get', { key: prefix + id })
    if (!response.ok) return problem(response.status, await detail(response))
    const entry = (await response.json()) as { value: Issue.Issue } | null
    if (!entry) return problem(404, `No issue ${id}.`)
    return Response.json(Issue.summary(entry.value))
  }

  const list = async (request: Request) => {
    if (!options.admin || !(await options.admin(request))) return problem(404, 'Not found.')
    const readiness = await check()
    if (!readiness.ready) return Response.json(readiness, { status: 503 })

    const cursor = new URL(request.url).searchParams.get('cursor')
    const response = await call('/v1/kv/list', {
      ...(cursor ? { cursor } : {}),
      prefix,
    })
    if (!response.ok) return problem(response.status, await detail(response))
    const page = (await response.json()) as {
      cursor: string | null
      entries: readonly { value: Issue.Issue }[]
    }
    return Response.json({ cursor: page.cursor, issues: page.entries.map((entry) => entry.value) })
  }

  return {
    fetch: async (request) => {
      const path = new URL(request.url).pathname.replace(/\/+$/, '')
      const rest = (() => {
        if (path === base) return ''
        if (path.startsWith(base + '/')) return path.slice(base.length + 1)
        return undefined
      })()
      if (rest === undefined) return problem(404, 'Not found.')

      if (rest === '' && request.method === 'GET') {
        const readiness = await check()
        return Response.json(readiness, { status: readiness.ready ? 200 : 503 })
      }
      if (rest === '' && request.method === 'POST') return file(request)
      if (rest === 'issues' && request.method === 'GET') return list(request)
      if (Issue.handle.test(rest) && request.method === 'GET') return read(rest)
      return problem(404, 'Not found.')
    },
  }
}

export declare namespace feedback {
  type Options = {
    accept?: ((context: Context) => boolean | Promise<boolean>) | undefined
    admin?: ((request: Request) => boolean | Promise<boolean>) | undefined
    agent?: string | undefined
    app: string
    fetch?: ((request: Request) => Promise<Response>) | undefined
    gateway?: string | undefined
    identify?: ((request: Request) => string | undefined | Promise<string | undefined>) | undefined
    key: string | undefined
    path?: string | undefined
    public?: boolean | undefined
    repo?: string | undefined
  }
  type Context = { report: Report.Report; request: Request }
}

async function detail(response: Response) {
  const body = (await response.json().catch(() => undefined)) as { detail?: unknown } | undefined
  return typeof body?.detail === 'string' ? body.detail : `The gateway answered ${response.status}.`
}

function problem(status: number, detail: string) {
  return Response.json(
    { detail, status },
    { headers: { 'content-type': 'application/problem+json' }, status },
  )
}

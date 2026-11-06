import type * as Feedback from './Feedback.ts'

export function create(options: create.Options = {}): Feedback.Target {
  const url = options.url ?? '/feedback'

  return {
    send: async (report, events) => {
      const response = await fetch(url, {
        body: JSON.stringify(report),
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        method: 'POST',
        signal: events.signal,
      })
      const body = (await response.json().catch(() => undefined)) as
        | { detail?: unknown; id?: unknown; link?: unknown; reason?: unknown }
        | undefined
      if (!response.ok || typeof body?.id !== 'string')
        throw new Error(text(body) ?? `${url} answered ${response.status}.`)

      return {
        label: `Filed as ${/^[0-9]+$/.test(body.id) ? '#' + body.id : body.id}.`,
        link:
          typeof body.link === 'string'
            ? { href: new URL(body.link, location.href).href, text: 'Track it' }
            : undefined,
      }
    },
    status: async () => {
      const response = await fetch(url, { headers: { accept: 'application/json' } }).catch(
        (error: unknown) => error as Error,
      )
      if (response instanceof Error)
        return {
          help: options.help,
          ready: false,
          reason: `${url} did not answer: ${response.message}`,
        }
      if (response.status === 404)
        return {
          help: options.help,
          ready: false,
          reason: `Nothing answers at ${url}. Serve Handler.feedback from nanocode-ts/feedback/server there.`,
        }

      const body = (await response.json().catch(() => undefined)) as
        | { detail?: unknown; help?: Feedback.Link; ready?: unknown; reason?: unknown }
        | undefined
      if (response.ok && body?.ready === true) return { ready: true }
      return {
        help: body?.help ?? options.help,
        ready: false,
        reason: text(body) ?? `${url} answered ${response.status}.`,
      }
    },
  }
}

export declare namespace create {
  type Options = { help?: Feedback.Link | undefined; url?: string | undefined }
}

function text(body: { detail?: unknown; reason?: unknown } | undefined) {
  if (typeof body?.reason === 'string') return body.reason
  if (typeof body?.detail === 'string') return body.detail
  return undefined
}

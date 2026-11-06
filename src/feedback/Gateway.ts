import type * as Feedback from './Feedback.ts'
import * as Report from './Report.ts'

export function create(options: create.Options): Feedback.Target {
  const origin = new URL(options.url).origin

  return {
    send: async (report, events) => {
      const response = await fetch(origin + '/v1/feedback', {
        body: JSON.stringify({
          client: 'nanocode-ts feedback',
          context: {
            comments: report.comments,
            title: report.title,
            url: report.url,
            viewport: report.viewport,
          },
          kind: 'other',
          message: Report.prompt(report),
          tool: new URL(report.url).pathname,
        }),
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        method: 'POST',
        signal: events.signal,
      })
      const body = (await response.json().catch(() => undefined)) as
        | { detail?: unknown; id?: unknown }
        | undefined
      if (!response.ok || typeof body?.id !== 'string')
        throw new Error(
          typeof body?.detail === 'string'
            ? body.detail
            : `The gateway answered ${response.status}.`,
        )

      return {
        label: `Sent as ${body.id}.`,
        link: { href: `${origin}/v1/feedback/${body.id}`, text: 'Track it' },
      }
    },
  }
}

export declare namespace create {
  type Options = { url: string }
}

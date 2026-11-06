import * as Report from '../Report.ts'

export type Issue = {
  at: number
  id: string
  report: Report.Report
  reporter: string | null
  resolution: string | null
  status: Status
  version: 1
}

export type Parsed = { ok: true; report: Report.Report } | { error: string; ok: false }

export type Status = 'accepted' | 'closed' | 'open'

export type Summary = Pick<Issue, 'at' | 'id' | 'resolution' | 'status'>

export const handle = /^(?:iss_[0-9a-z]+|[1-9][0-9]{0,15})$/

export const repository = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function board(repo?: string): string {
  return repo === undefined ? 'issues/' : `git/${repo}/issues/`
}

export function counter(repo: string): string {
  return `git/${repo}/issues`
}

export function create(options: create.Options): Issue {
  return {
    at: options.at,
    id: options.id,
    report: options.report,
    reporter: options.reporter ?? null,
    resolution: null,
    status: 'open',
    version: 1,
  }
}

export declare namespace create {
  type Options = {
    at: number
    id: string
    report: Report.Report
    reporter?: string | undefined
  }
}

export function id(at: number): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  return 'iss_' + at.toString(36).padStart(9, '0') + random
}

export function label(id: string): string {
  return /^[0-9]+$/.test(id) ? '#' + id : id
}

export function parse(value: unknown): Parsed {
  if (!record(value)) return { error: 'Send the report as a JSON object.', ok: false }
  if (typeof value.title !== 'string') return { error: 'title must be a string.', ok: false }
  if (!page(value.url)) return { error: 'url must be an http or https URL.', ok: false }

  const viewport = value.viewport
  if (!record(viewport) || !numbers(viewport, ['height', 'width']))
    return { error: 'viewport must hold a numeric height and width.', ok: false }

  const comments = value.comments
  if (!Array.isArray(comments) || comments.length === 0)
    return { error: 'comments must list at least one comment.', ok: false }

  const parsed: Report.Comment[] = []
  for (const [index, comment] of comments.entries()) {
    const rect = record(comment) ? comment.rect : undefined
    if (
      !record(comment) ||
      typeof comment.note !== 'string' ||
      !comment.note.trim() ||
      typeof comment.selector !== 'string' ||
      typeof comment.tag !== 'string' ||
      typeof comment.text !== 'string' ||
      !record(rect) ||
      !numbers(rect, ['height', 'width', 'x', 'y'])
    )
      return {
        error: `comments[${index}] needs a note, selector, tag, text and a numeric rect.`,
        ok: false,
      }

    parsed.push({
      note: comment.note.trim(),
      rect: { height: rect.height, width: rect.width, x: rect.x, y: rect.y },
      selector: comment.selector,
      tag: comment.tag,
      text: comment.text,
    })
  }

  return {
    ok: true,
    report: {
      comments: parsed,
      title: value.title,
      url: value.url,
      viewport: { height: viewport.height, width: viewport.width },
    },
  }
}

export function prompt(issue: Issue, options: prompt.Options): string {
  return [
    `Issue ${label(issue.id)}${issue.reporter ? ` from ${issue.reporter}` : ''}. ${Report.prompt(issue.report)}`,
    '',
    `The issue is the kv value ${options.key} in this app. When it is resolved, set its status to "accepted" or "closed" and its resolution to what changed.`,
  ].join('\n')
}

export declare namespace prompt {
  type Options = { key: string }
}

export function summary(issue: Issue): Summary {
  return { at: issue.at, id: issue.id, resolution: issue.resolution, status: issue.status }
}

function numbers<const Keys extends string>(
  value: Record<string, unknown>,
  keys: readonly Keys[],
): value is Record<Keys, number> {
  return keys.every((name) => typeof value[name] === 'number' && Number.isFinite(value[name]))
}

function page(value: unknown): value is string {
  if (typeof value !== 'string') return false

  const url = URL.parse(value)
  return url?.protocol === 'http:' || url?.protocol === 'https:'
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

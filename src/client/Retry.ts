export type Reason = '502' | '503' | '504' | 'early_timeout' | 'network' | 'timeout'

export function allowed(request: allowed.Request): boolean {
  return (
    request.method === 'GET' &&
    request.retry !== false &&
    request.body === undefined &&
    !request.signal &&
    !request.keepalive
  )
}

export declare namespace allowed {
  type Request = {
    body?: unknown
    keepalive?: boolean | undefined
    method: string
    retry?: boolean | undefined
    signal?: AbortSignal | undefined
  }
}

export function reason(outcome: reason.Outcome, options: reason.Options): Reason | null {
  if ('status' in outcome) {
    if (outcome.status !== 502 && outcome.status !== 503 && outcome.status !== 504) return null
    if (outcome.retryAfter !== undefined && outcome.retryAfter > options.longestRetryAfter)
      return null
    return String(outcome.status) as Reason
  }

  const name = (() => {
    try {
      return (outcome.error as { name?: unknown } | null)?.name
    } catch {
      return undefined
    }
  })()
  if (name === 'TimeoutError') return options.early ? 'early_timeout' : 'timeout'
  if ((name === 'TypeError' || name === 'NetworkError') && options.online !== false)
    return 'network'
  return null
}

export declare namespace reason {
  type Options = {
    early?: boolean | undefined
    longestRetryAfter: number
    online: boolean | undefined
  }
  type Outcome = { error: unknown } | { retryAfter?: number | undefined; status: number }
}

export function backoff(attempt: number, options: backoff.Options): number {
  const base = Math.min(options.maxMs, options.firstMs * 2 ** Math.max(0, attempt - 1))
  const jittered = Math.round(base / 2 + (options.random ?? Math.random)() * (base / 2))
  return Math.min(
    options.longestRetryAfter * 1000,
    Math.max(jittered, options.retryAfter !== undefined ? options.retryAfter * 1000 : 0),
  )
}

export declare namespace backoff {
  type Options = {
    firstMs: number
    longestRetryAfter: number
    maxMs: number
    random?: (() => number) | undefined
    retryAfter?: number | undefined
  }
}

export function after(header: string | null): number | undefined {
  if (header === null || header.trim() === '') return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

export function deadline(ms: number, options: deadline.Options): () => void {
  const timer = setTimeout(
    () => options.expire(new DOMException('The request timed out', 'TimeoutError')),
    ms,
  )
  return () => clearTimeout(timer)
}

export declare namespace deadline {
  type Options = { expire: (reason: DOMException) => void }
}

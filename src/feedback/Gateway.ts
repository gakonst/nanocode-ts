import type * as Feedback from './Feedback.ts'
import * as Report from './Report.ts'

export type Credential = { expiresAt: number; key: string; wallet: string }

export class RequestError extends Error {
  override name = 'Gateway.RequestError'
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export function create(options: create.Options): create.ReturnType {
  const app = options.app ?? 'default'
  const origin = new URL(options.url).origin
  const owner = options.owner?.toLowerCase()
  const slot = 'nanocode.feedback.key:' + origin
  const storage = options.storage ?? globalThis.localStorage

  const forget = () => storage?.removeItem(slot)

  const remembered = (): Credential | undefined => {
    const saved = (() => {
      try {
        return JSON.parse(storage?.getItem(slot) ?? 'null') as Credential | null
      } catch {
        return null
      }
    })()
    if (!saved || saved.expiresAt <= Date.now()) return undefined
    return saved
  }

  const post = (path: string, request: post.Request) =>
    fetch(origin + path, {
      body: JSON.stringify(request.body),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(request.credential ? { authorization: 'Bearer ' + request.credential.key } : {}),
        ...request.headers,
      },
      method: 'POST',
      signal: request.signal,
    })

  const signIn = async (events: Feedback.Target.Events): Promise<Credential> => {
    const started = (await answer(
      await post('/api/keys/request', {
        body: { ...options.key, device: true },
        signal: events.signal,
      }),
    )) as { device?: Device; id: string }
    const device = started.device
    if (!device) throw new RequestError('The gateway returned no Tempo Wallet request.', 502)

    events.prompt({
      code: device.userCode,
      expiresAt: device.expiresAt,
      url: device.verificationUriFull ?? device.verificationUri,
    })
    while (Date.now() < device.expiresAt) {
      await pause(device.interval * 1000, events.signal)
      const completed = (await answer(
        await post('/api/keys/complete', { body: { id: started.id }, signal: events.signal }),
      )) as Completed
      if (completed.status === 'pending') continue

      const credential = {
        expiresAt: completed.expiresAt,
        key: completed.key,
        wallet: (completed.wallet ?? completed.approvedBy).toLowerCase(),
      }
      storage?.setItem(slot, JSON.stringify(credential))
      return credential
    }
    throw new RequestError('The Tempo Wallet request expired. Send again to start another.', 410)
  }

  const authorized = async (
    events: Feedback.Target.Events,
    request: (credential: Credential) => Promise<Response>,
  ) => {
    const first = remembered() ?? (await signIn(events))
    const response = await request(first)
    if (response.status !== 401) return { credential: first, response }

    forget()
    const second = await signIn(events)
    return { credential: second, response: await request(second) }
  }

  const turn = async (
    agent: string,
    report: Report.Report,
    events: Feedback.Target.Events,
  ): Promise<Feedback.Sent> => {
    const sent = await authorized(events, (credential) =>
      post(`/v1/agents/${encodeURIComponent(agent)}/turns`, {
        body: { prompt: Report.prompt(report) },
        credential,
        headers: {
          'gateway-app': app,
          ...(owner && owner !== credential.wallet ? { 'gateway-owner': owner } : {}),
        },
        signal: events.signal,
      }),
    )
    await answer(sent.response)

    return {
      label: `Started a thread on ${agent}.`,
      link: {
        href: `${origin}/agents#${encodeURIComponent([owner ?? sent.credential.wallet, app, agent].join('/'))}`,
        text: 'Open thread',
      },
    }
  }

  const report = async (
    report: Report.Report,
    events: Feedback.Target.Events,
  ): Promise<Feedback.Sent> => {
    const body = {
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
    }
    const response = options.stake
      ? (
          await authorized(events, (credential) =>
            post('/v1/feedback/stake', { body, credential, signal: events.signal }),
          )
        ).response
      : await post('/v1/feedback', { body, credential: remembered(), signal: events.signal })
    const sent = (await answer(response)) as { id: string }

    return {
      label: `Sent as ${sent.id}.`,
      link: { href: `${origin}/v1/feedback/${sent.id}`, text: 'Track it' },
    }
  }

  return {
    forget,
    send: (value, events) =>
      options.agent === undefined ? report(value, events) : turn(options.agent, value, events),
  }
}

export declare namespace create {
  type Options = {
    agent?: string | undefined
    app?: string | undefined
    key?:
      | { days?: number | undefined; limit?: number | undefined; token?: string | undefined }
      | undefined
    owner?: string | undefined
    stake?: boolean | undefined
    storage?: Storage | undefined
    url: string
  }
  type ReturnType = Feedback.Target & { forget(): void }
}

declare namespace post {
  type Request = {
    body: unknown
    credential?: Credential | undefined
    headers?: Record<string, string> | undefined
    signal: AbortSignal
  }
}

type Completed =
  | { status: 'pending' }
  | {
      approvedBy: string
      expiresAt: number
      key: string
      status: 'completed'
      wallet?: string | undefined
    }

type Device = {
  expiresAt: number
  interval: number
  userCode: string
  verificationUri: string
  verificationUriFull?: string | undefined
}

async function answer(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => undefined)) as
    | { detail?: unknown; title?: unknown }
    | undefined
  if (response.ok) return body

  const detail = typeof body?.detail === 'string' ? body.detail : undefined
  const title = typeof body?.title === 'string' ? body.title : undefined
  throw new RequestError(
    detail ?? title ?? `The gateway answered ${response.status}.`,
    response.status,
  )
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

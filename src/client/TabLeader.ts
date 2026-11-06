export type Channel = {
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: unknown): void
  unref?: (() => void) | undefined
}

export type Leader<Message> = {
  beat(message: Message, options: { every: number }): void
  campaign(): void
  close(): void
  readonly heard: number
  readonly leading: boolean
  post(message: Message): void
  resign(): void
}

export type Locks = {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>
}

export function open<Message>(options: open.Options<Message>): Leader<Message> | null {
  const locks = options.locks ?? (globalThis.navigator as { locks?: Locks } | undefined)?.locks
  const make =
    options.channel ??
    (globalThis.BroadcastChannel
      ? (name: string) => new BroadcastChannel(name) as unknown as Channel
      : undefined)
  if (!locks || !make) return null

  const channel = (() => {
    try {
      return make(options.channelName)
    } catch {
      return null
    }
  })()
  if (!channel) return null

  let asking: AbortController | undefined
  let closed = false
  let heard = 0
  let leading = false
  let posted = 0
  let release: (() => void) | undefined

  channel.unref?.()
  channel.onmessage = (event) => {
    if (closed) return
    heard = Date.now()
    options.receive(event.data as Message)
  }

  const resign = () => {
    asking?.abort()
    asking = undefined
    leading = false
    release?.()
    release = undefined
  }

  const post = (message: Message) => {
    if (closed) return
    try {
      channel.postMessage(message)
      posted = Date.now()
    } catch {}
  }

  return {
    beat(message, beat) {
      if (Date.now() - posted >= beat.every) post(message)
    },
    campaign() {
      if (closed || leading || asking) return
      const current = new AbortController()
      asking = current
      locks
        .request(
          options.lockName,
          { signal: current.signal },
          () =>
            new Promise<void>((resolve) => {
              if (asking !== current) return resolve()
              asking = undefined
              release = resolve
              leading = true
              options.lead()
            }),
        )
        .catch(() => {})
    },
    close() {
      resign()
      closed = true
      channel.onmessage = null
      channel.close()
    },
    get heard() {
      return heard
    },
    get leading() {
      return leading
    },
    post,
    resign,
  }
}

export declare namespace open {
  type Options<Message> = {
    channel?: ((name: string) => Channel) | undefined
    channelName: string
    lead: () => void
    lockName: string
    locks?: Locks | undefined
    receive: (message: Message) => void
  }
}

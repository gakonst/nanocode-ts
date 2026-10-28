import * as Relay from './client/Relay.ts'
import * as Remote from './Remote.ts'

export type Hand = {
  executor: Remote.Executor<WebSocket>
  name: string | null
  connection: string
}

function field(catalog: string, key: 'name' | 'runtime_id'): string | null {
  try {
    const value = (JSON.parse(catalog) as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

export function relay(
  url: string,
  token: string,
  policy: Remote.Policy,
  onHand: (hand: Hand | undefined) => void,
  signal: AbortSignal,
): void {
  const address = `${Relay.socketUrl(url)}${url.includes('?') ? '&' : '?'}role=brain&wait`
  let current: Hand | undefined
  let runtime: string | null = null
  const lost = (executor: Remote.Executor<WebSocket>) => {
    if (current?.executor !== executor) return
    current = undefined
    if (!signal.aborted) onHand(undefined)
  }
  signal.addEventListener('abort', () => current?.executor.disconnected('the brain left'), {
    once: true,
  })
  const dial = (delay: number) => {
    if (signal.aborted) return
    const socket = new WebSocket(address, Remote.bearerProtocols(token))
    let cataloged = false
    const stop = () => {
      try {
        socket.close(1000, 'the brain left')
      } catch {}
    }
    signal.addEventListener('abort', stop, { once: true })
    socket.addEventListener('message', (event) => {
      if (cataloged)
        return void (current?.executor.socket === socket && current.executor.receive(event.data))
      if (typeof event.data !== 'string') return
      cataloged = true
      const id = field(event.data, 'runtime_id')
      if (current && id !== null && id === runtime && current.executor.rebind(socket, event.data))
        return
      current?.executor.disconnected('the hand restarted')
      const executor = Remote.restore(socket, { catalog: event.data, policy })
      runtime = id
      current = { executor, name: field(event.data, 'name'), connection: crypto.randomUUID() }
      void executor.closed.then(() => lost(executor))
      onHand(current)
    })
    let ended = false
    const end = (code: number, reason: string) => {
      if (ended) return
      ended = true
      signal.removeEventListener('abort', stop)
      if (current?.executor.socket === socket) current.executor.park('the hand disconnected')
      if (signal.aborted) return
      if (code === Remote.brainReplaced)
        return current?.executor.disconnected(reason || 'another brain took the hand')
      const next = cataloged ? 1000 : Math.min(delay * 2, 30_000)
      setTimeout(() => dial(next), cataloged ? 0 : delay)
    }
    socket.addEventListener('close', (event) => end(event.code, event.reason))
    socket.addEventListener('error', () => end(1006, 'the relay connection failed'))
  }
  dial(1000)
}

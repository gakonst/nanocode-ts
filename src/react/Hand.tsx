'use client'

import { useCallback, useEffect, useState } from 'react'
import * as Relay from '../client/Relay.ts'
import { usePart } from './Provider.tsx'

export function Hand(props: Hand.Props) {
  const part = usePart()
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(text),
      () => setCopied(null),
    )
  }
  const attached = props.hands.length > 0
  return (
    <div aria-label="Run on your machine" role="region" {...part('hand', { attached })}>
      <p {...part('handTitle')}>Run this session on your machine</p>
      <p {...part('handText')}>
        Paste this in a terminal, in the folder the agent should work in. It installs nanocode (
        <code>nc</code>) and connects your computer to this session: from the next message the
        agent's code runs there, with your files and your shell, so it can run any command you
        could.
      </p>
      <pre {...part('handCommand')}>{props.command}</pre>
      <p {...part('handActions')}>
        <button onClick={() => copy(props.command)} type="button" {...part('handButton')}>
          {copied === props.command ? 'copied' : 'copy'}
        </button>
        <span aria-live="polite" {...part('handStatus', { attached })}>
          {attached
            ? `connected: ${props.hands.map((name) => name ?? 'your machine').join(', ')}`
            : 'waiting for your machine…'}
        </span>
        {props.onClose && (
          <button onClick={props.onClose} type="button" {...part('handButton')}>
            close
          </button>
        )}
      </p>
      {props.short && (
        <p {...part('handText')}>
          Already have <code>nc</code>? <code>{props.short}</code>{' '}
          <button onClick={() => copy(props.short!)} type="button" {...part('handButton')}>
            {copied === props.short ? 'copied' : 'copy'}
          </button>
        </p>
      )}
      {props.tab && (
        <p {...part('handText')}>
          No terminal?{' '}
          <a href={props.tab} rel="noreferrer" target="_blank">
            Make a browser tab this session's machine →
          </a>
        </p>
      )}
    </div>
  )
}

export declare namespace Hand {
  type Props = {
    command: string
    short?: string
    tab?: string
    hands: readonly (string | null)[]
    onClose?(): void
  }
}

export type HandState = {
  open: boolean
  access?: Relay.Access
  hands: readonly (string | null)[]
  toolsOnly: readonly (string | null)[]
  where: string
  error?: string
  show(): void
  hide(): void
  reset(): void
}

export function useHand(source: Relay.Source | undefined): HandState {
  const [open, setOpen] = useState(false)
  const [access, setAccess] = useState<Relay.Access>()
  const [listing, setListing] = useState<Relay.Listing>({ hands: [], toolsOnly: [] })
  const [error, setError] = useState<string>()
  const hands = listing.hands
  const connected = hands.length > 0

  useEffect(() => {
    if (!source || !access || (!open && !connected)) return
    let stopped = false
    const poll = async () => {
      const found = await (
        source.listing
          ? source.listing()
          : source.hands().then((names) => ({ hands: names, toolsOnly: [] }))
      ).catch(() => ({ hands: [], toolsOnly: [] }))
      if (!stopped) setListing(found)
    }
    void poll()
    const timer = setInterval(() => void poll(), open ? 3000 : 20_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [source, access, open, connected])

  const show = useCallback(() => {
    setOpen(true)
    setError(undefined)
    if (!source) return
    void source.hand().then(
      (found) => {
        if (found) setAccess(found)
        else setError('this session cannot take a machine; start a new one')
      },
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    )
  }, [source])

  const reset = useCallback(() => {
    setOpen(false)
    setAccess(undefined)
    setListing({ hands: [], toolsOnly: [] })
    setError(undefined)
  }, [])

  return {
    open,
    access,
    hands,
    toolsOnly: listing.toolsOnly,
    where: Relay.where(listing),
    error,
    show,
    hide: () => setOpen(false),
    reset,
  }
}

export function HandConnect(props: HandConnect.Props) {
  const { hand } = props
  const part = usePart()
  if (hand.open && hand.access) {
    const { command, short, tab } = Relay.commands(hand.access, {
      install: props.install,
      tab: props.tab,
    })
    return (
      <Hand
        command={command}
        hands={hand.hands}
        onClose={hand.hide}
        short={short}
        {...(tab ? { tab } : {})}
      />
    )
  }
  return (
    <p {...part('row')}>
      <span aria-hidden="true" {...part('chevron')}>
        ❯
      </span>
      <button onClick={hand.show} type="button" {...part('suggestion')}>
        {hand.error ??
          (hand.hands.length
            ? `${hand.where} · show the command`
            : hand.open
              ? 'preparing the command…'
              : 'Run this session on your own machine with nc →')}
      </button>
    </p>
  )
}

export declare namespace HandConnect {
  type Props = {
    hand: HandState
    install?: string
    tab?: string | false
  }
}

export function ago(time: number): string {
  const seconds = Math.max(0, (Date.now() - time) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  return new Date(time).toLocaleDateString()
}

'use client'

/**
 * Markdown of assistant text, which loads its renderer on first use.
 *
 * @module
 */
import { lazy, type ReactNode, Suspense } from 'react'
import { usePart } from './Provider.tsx'

const Streamed = lazy(() => import('./Streamed.tsx'))

/** Markdown text, which renders as plain text until the renderer loads. */
export function Markdown(props: Markdown.Props) {
  const part = usePart()
  const fallback = (
    <div {...part('markdown', { live: props.live })}>
      <p {...part('paragraph')}>{props.text}</p>
    </div>
  )
  return (
    <Suspense fallback={fallback}>
      <Streamed {...props} />
    </Suspense>
  )
}

export declare namespace Markdown {
  type Props = {
    text: string
    live?: boolean
    code?(language: string, code: string): ReactNode
  }
}

/** Markdown text of an assistant reply. */
export function Reply(props: Markdown.Props) {
  return <Markdown {...props} />
}

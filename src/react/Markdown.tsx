'use client'

import { lazy, type ReactNode, Suspense } from 'react'
import { usePart } from './Provider.tsx'

const Streamed = lazy(() => import('./Streamed.tsx'))

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

export function Reply(props: Markdown.Props) {
  return <Markdown {...props} />
}

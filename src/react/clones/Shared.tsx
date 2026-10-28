'use client'

/**
 * Hooks, icons, and types that the clone pages share.
 *
 * @module
 */
import type * as Tool from '../../client/Tool.ts'
import type * as Transcript from '../../client/Transcript.ts'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Code, type Skin, useAttachments, useConfig, useConversations, useSend } from '../index.tsx'

/** Block of a clone turn, with adjacent tool cells grouped. */
export type Block = Transcript.TurnBlock | { kind: 'tools'; cells: Tool.Cell[]; live: boolean }

/** Model choice of a clone. */
export type CloneModel = { id: string; label: string; detail?: string }

/** Model picker of a clone. */
export type ClonePicker = {
  models: readonly CloneModel[]
  current: string
  choose(id: string): void
  bound?: boolean
}

/** Props that the clone pages share. */
export type CloneProps = {
  actions?: ReactNode
  before?(): Promise<unknown>
  busy?: boolean
  heading?: string
  input?(composer: ReactNode): ReactNode
  parts?: Skin['parts']
  send?(text: string): void
  suggestions?: ReactNode
  footer?: ReactNode
  picker?: ClonePicker
  prompts?: readonly string[]
  sidebar?: ReactNode
  title?: string
  warm?(): void
}

/** Groups adjacent tool blocks. */
export function grouped(blocks: readonly Transcript.TurnBlock[]): Block[] {
  const result: Block[] = []
  for (const block of blocks) {
    const last = result[result.length - 1]
    if (block.tool && last?.kind === 'tools') {
      last.cells.push(block.tool)
      last.live ||= block.live
    } else if (block.tool) result.push({ cells: [block.tool], kind: 'tools', live: block.live })
    else result.push(block)
  }
  return result
}

/** Returns the duration of a block in seconds. */
export function seconds(block: Transcript.TurnBlock): number | undefined {
  return block.live || block.started_at === undefined || block.ended_at === undefined
    ? undefined
    : Math.max(1, Math.round((block.ended_at - block.started_at) / 1000))
}

/** Returns a ref that keeps a scroll container at its end. */
export function useStick(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [dependency])
  const onScroll = () => {
    const node = ref.current
    if (node) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
  }
  return {
    onScroll,
    pin: () => {
      stick.current = true
    },
    ref,
  }
}

/** Returns the state and handlers of a clone composer. */
export function useComposer(options: {
  onSend?(): void
  warm?(): void
  before?(): Promise<unknown>
  send?(text: string): void
}) {
  const { cancel, canCancel, isPending: busy, send } = useSend()
  const attachments = useAttachments()
  const [prompt, setPrompt] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const node = input.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = Math.min(node.scrollHeight, 240) + 'px'
  }, [prompt])

  const submit = () => {
    const text = prompt.trim()
    const attached = attachments.ready
    if ((!text && !attached.length) || attachments.uploading) return
    setPrompt('')
    attachments.clear()
    options.onSend?.()
    if (options.send) return options.send(text)
    void (options.before?.() ?? Promise.resolve()).finally(() => send(text, attached))
  }

  const textarea = {
    'aria-label': 'Message',
    onChange: (event: { target: { value: string } }) => {
      setPrompt(event.target.value)
      if (!busy && event.target.value) options.warm?.()
    },
    onPaste: attachments.onPaste,
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      submit()
    },
    ref: input,
    rows: 1,
    value: prompt,
  }

  return {
    attachments,
    busy,
    cancel,
    canCancel,
    empty: !prompt.trim() && !attachments.ready.length,
    focus: () => input.current?.focus(),
    submit,
    textarea,
  }
}

/** Resumes the current conversation on mount. */
export function useResume() {
  const config = useConfig()
  const { current } = useConversations()
  useEffect(() => {
    void config.resume()
  }, [current])
}

/** Code block with a copy button. */
export function CopyCode(props: CopyCode.Props) {
  const [copied, setCopied] = useState(false)
  const code = props.code.replace(/\n$/, '')
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{props.language === 'text' ? '' : props.language}</span>
        <button onClick={copy} type="button">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <Code code={code} framed language={props.language} />
    </div>
  )
}

export declare namespace CopyCode {
  type Props = {
    code: string
    language: string
  }
}

/** Returns a greeting for the time of day. */
export function useGreeting(): string {
  const [hour, setHour] = useState<number>()
  useEffect(() => setHour(new Date().getHours()), [])
  if (hour === undefined) return 'Hello'
  return hour < 5
    ? 'Good evening'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening'
}

/** Closes a popup on outside click and on Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const pointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close()
    }
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    addEventListener('pointerdown', pointer)
    addEventListener('keydown', key)
    return () => {
      removeEventListener('pointerdown', pointer)
      removeEventListener('keydown', key)
    }
  }, [open])
  return ref
}

/** Returns the open state of the sidebar. */
export function useSidebar() {
  const wide = () => typeof matchMedia === 'undefined' || matchMedia('(min-width: 768px)').matches
  const [open, setOpen] = useState(true)
  useEffect(() => {
    const media = matchMedia('(min-width: 768px)')
    setOpen(media.matches)
    const change = () => setOpen(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  return {
    close: () => {
      if (!wide()) setOpen(false)
    },
    open,
    toggle: () => setOpen((value) => !value),
  }
}

/** Suggested prompts. */
export function Prompts(props: Prompts.Props) {
  const { send } = useSend()
  if (!props.prompts?.length) return null
  return (
    <div className="nc-prompts">
      {props.prompts.map((prompt) => (
        <button
          className="nc-prompt"
          key={prompt}
          onClick={() => {
            props.onSend()
            void send(prompt)
          }}
          onFocus={props.warm}
          onPointerEnter={props.warm}
          type="button"
        >
          {prompt}
        </button>
      ))}
    </div>
  )
}

export declare namespace Prompts {
  type Props = {
    prompts?: readonly string[]
    onSend(): void
    warm?(): void
  }
}

function Svg(props: Svg.Props) {
  const size = props.size ?? 20
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
    >
      {props.children}
    </svg>
  )
}

declare namespace Svg {
  type Props = {
    children: ReactNode
    size?: number
  }
}

/** Arrow up icon. */
export const ArrowUp = () => (
  <Svg>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Svg>
)
/** Chevron icon. */
export const Chevron = () => (
  <Svg size={16}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)
/** Check icon. */
export const Check = () => (
  <Svg size={18}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
)
/** Compose icon. */
export const Compose = () => (
  <Svg>
    <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
    <path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
  </Svg>
)
/** Plus icon. */
export const Plus = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
/** Sidebar icon. */
export const Sidebar = () => (
  <Svg>
    <rect height="16" rx="3" width="18" x="3" y="4" />
    <path d="M9 4v16" />
  </Svg>
)
/** Stop icon. */
export const Stop = () => (
  <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
    <rect fill="currentColor" height="12" rx="2" width="12" x="1" y="1" />
  </svg>
)
/** Trash icon. */
export const Trash = () => (
  <Svg size={16}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Svg>
)

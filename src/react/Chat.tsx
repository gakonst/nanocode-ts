'use client'

import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import * as Format from '../client/internal/Format.ts'
import type * as Pickers from '../client/Pickers.ts'
import type * as Transcript from '../client/Transcript.ts'
import { AttachmentList, useAttachments } from './Attachments.tsx'
import { ago } from './Hand.tsx'
import { Markdown } from './Markdown.tsx'
import {
  useActivity,
  useConversations,
  useExpanded,
  usePart,
  useSend,
  useSkin,
  useTranscript,
} from './Provider.tsx'
import { spinner, ToolCell, useNow } from './ToolCell.tsx'

export type Command = { label: string; detail?: string }

export type Suggestion = string | { label: string; onClick(): void; disabled?: boolean }

export type Picker = {
  title?: string
  items(query: string): Pickers.Item[]
  filter?: boolean
  hint?: string
  onChoose(item: Pickers.Item): void
}

export type Disclosure = 'expanded' | 'collapsed' | 'hidden'

export function Thinking(props: Thinking.Props) {
  const part = usePart()
  const { entry, live = false, collapsed = true } = props
  const expanded = useExpanded()
  const id = 'reasoning:' + (entry.started_at ?? entry.text.slice(0, 64))
  const open = expanded.open.has(id)
  const now = useNow(live)
  const icons = useSkin().icons
  const status = live ? 'running' : 'completed'
  const glyph = icons?.[status] ?? (live ? spinner : '✻')
  const icon = typeof glyph === 'string' ? glyph : glyph[Math.floor(now / 120) % glyph.length]
  const end = entry.ended_at ?? (live ? now : undefined)
  const label = live
    ? 'Thinking'
    : entry.started_at !== undefined && end !== undefined
      ? 'Thought for ' + Format.duration(Math.max(0, end - entry.started_at))
      : 'Thought'
  const shown = open || live || !collapsed
  return (
    <div {...part('tool', { kind: 'reasoning', collapsed, open, status })}>
      <button
        aria-expanded={shown}
        onClick={() => expanded.toggle(id)}
        type="button"
        {...part('header')}
      >
        <span aria-hidden="true" {...part('icon', { status })}>
          {icon}
        </span>
        <span {...part('name')}>{label}</span>
      </button>
      {shown && (
        <div {...part('entry', { kind: 'reasoning', live })}>
          <Markdown live={live} text={entry.text} />
        </div>
      )}
    </div>
  )
}

export declare namespace Thinking {
  type Props = {
    entry: Transcript.Entry
    live?: boolean
    collapsed?: boolean
  }
}

export function EntryView(props: EntryView.Props) {
  const part = usePart()
  const { entry, previous, live = false, tools = 'expanded', reasoning = 'collapsed' } = props
  if (
    (entry.kind === 'tool' && tools === 'hidden') ||
    (entry.kind === 'reasoning' && reasoning === 'hidden')
  )
    return null
  const label =
    entry.kind === 'user' ? 'you' : !previous || previous.kind === 'user' ? 'agent' : undefined
  return (
    <div {...part('turn')}>
      {label && (
        <p {...part('speaker', { steer: entry.steer, who: label })}>
          <span aria-hidden="true">●</span> {label}
        </p>
      )}
      {entry.kind === 'tool' && entry.tool ? (
        <div {...part('entry', { kind: 'cell' })}>
          <ToolCell cell={entry.tool} collapsed={tools === 'collapsed'} live={live} />
        </div>
      ) : entry.kind === 'assistant' ? (
        <div {...part('entry', { kind: 'assistant', live })}>
          <Markdown live={live} text={entry.text} />
        </div>
      ) : entry.kind === 'reasoning' ? (
        <Thinking collapsed={reasoning === 'collapsed'} entry={entry} live={live} />
      ) : (
        <p {...part('entry', { kind: entry.kind, live })}>{entry.text}</p>
      )}
      {entry.attachments?.length ? <AttachmentList items={entry.attachments} /> : null}
    </div>
  )
}

export declare namespace EntryView {
  type Props = {
    entry: Transcript.Entry
    previous?: Transcript.Entry
    live?: boolean
    tools?: Disclosure
    reasoning?: Disclosure
  }
}

export function Sidebar(props: Sidebar.Props) {
  const part = usePart()
  const threads = useConversations()
  if (!threads.enabled) return null
  return (
    <aside aria-label={props.label ?? 'Chats'} {...part('sidebar')}>
      <button
        disabled={!threads.canCreate}
        onClick={() => threads.create()}
        type="button"
        {...part('sidebarNew')}
      >
        New chat
      </button>
      <p {...part('sidebarSection')}>{props.title ?? 'Chats'}</p>
      <nav {...part('sidebarChats')}>
        {threads.conversations.map((item) => (
          <div key={item.id} {...part('sidebarChat', { current: item.id === threads.current })}>
            <button
              disabled={!threads.canSelect}
              onClick={() => threads.select(item.id)}
              title={item.title || 'New chat'}
              type="button"
            >
              {item.title || 'New chat'}
            </button>
            <button
              aria-label="Delete chat"
              onClick={() => threads.remove(item.id)}
              type="button"
              {...part('sidebarRemove')}
            >
              ×
            </button>
          </div>
        ))}
      </nav>
    </aside>
  )
}

export declare namespace Sidebar {
  type Props = {
    title?: string
    label?: string
  }
}

const typingDelayMs = 500

export function Chat(props: Chat.Props) {
  const part = usePart()
  const { entries, live } = useTranscript()
  const { cancel, canCancel, send, isPending: busy } = useSend()
  const attachments = useAttachments()
  const doing = useActivity()
  const threads = useConversations()
  const [own, setOwn] = useState<Picker | null>(null)
  const picker = props.picker ?? own
  const [prompt, setPrompt] = useState(props.defaultPrompt ?? '')
  const [highlight, setHighlight] = useState(0)
  const [typing, setTyping] = useState(false)
  const [recalled, setRecalled] = useState(-1)
  const [full, setFull] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    if (!busy) return setTyping(false)
    const timer = setTimeout(() => setTyping(true), typingDelayMs)
    return () => clearTimeout(timer)
  }, [busy])

  useLayoutEffect(() => {
    if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [entries, live, full])

  useEffect(() => {
    if (!full) return
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setFull(false)
    }
    const overflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    addEventListener('keydown', escape)
    input.current?.focus()
    return () => {
      document.documentElement.style.overflow = overflow
      removeEventListener('keydown', escape)
    }
  }, [full])

  useEffect(() => {
    if (props.defaultPrompt !== undefined) setPrompt(props.defaultPrompt)
  }, [props.defaultPrompt])

  useEffect(() => {
    if (!picker) return
    setPrompt('')
    const choices = picker ? picker.items('').filter((item) => item.kind === 'choice') : []
    setHighlight(
      Math.max(
        0,
        choices.findIndex((item) => item.current),
      ),
    )
    if (picker) input.current?.focus()
  }, [picker])

  const history = useMemo(
    () => entries.filter((entry) => entry.kind === 'user').map((entry) => entry.text),
    [entries],
  )
  const query = !picker && /^\/\S*$/.test(prompt) ? prompt : undefined
  const items: Pickers.Item[] = picker
    ? picker.items(picker.filter ? prompt : '')
    : query === undefined
      ? []
      : (props.commands ?? [])
          .filter((command) => command.label.startsWith(query))
          .map((command) => ({ kind: 'choice', ...command }))
  const choices = items.filter((item) => item.kind === 'choice')
  const highlighted = Math.min(highlight, Math.max(0, choices.length - 1))
  const width = Math.max(0, ...choices.map((item) => item.label.length))

  const submit = (raw: string) => {
    const text = raw.trim()
    const attached = attachments.ready
    if (!text && !attached.length) return
    if (attachments.uploading) return
    setPrompt('')
    setRecalled(-1)
    stick.current = true
    if (props.onSubmit && !attached.length) props.onSubmit(text)
    else void send(text, attached)
    attachments.clear()
  }

  const choose = (item: Pickers.Item) => {
    if (!picker) return submit(item.label)
    setPrompt('')
    if (picker === own) setOwn(null)
    picker.onChoose(item)
  }

  const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (picker || choices.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight(
          Math.min(
            Math.max(0, highlighted + (event.key === 'ArrowDown' ? 1 : -1)),
            Math.max(0, choices.length - 1),
          ),
        )
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setPrompt('')
        if (own) setOwn(null)
        else props.onPickerClose?.()
        return
      }
      if (event.key === 'Tab' && !picker && choices[highlighted]) {
        event.preventDefault()
        setPrompt(choices[highlighted].label)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        if (choices[highlighted]) choose(choices[highlighted])
        return
      }
    }
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      history.length &&
      (recalled >= 0 || !prompt) &&
      !prompt.includes('\n')
    ) {
      event.preventDefault()
      const next =
        event.key === 'ArrowUp'
          ? recalled < 0
            ? history.length - 1
            : Math.max(0, recalled - 1)
          : recalled < 0
            ? -1
            : recalled + 1
      const index = next >= history.length ? -1 : next
      setRecalled(index)
      setPrompt(index < 0 ? '' : history[index])
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    submit(prompt)
  }

  const showTyping = busy && (typing || live.length > 0)
  const phrase =
    doing.phase === 'thinking'
      ? 'is thinking'
      : doing.phase === 'running'
        ? doing.tool === 'code'
          ? 'is running code'
          : `is running ${doing.tool}`
        : 'is typing'
  const placeholder = picker?.filter
    ? 'type to filter'
    : busy
      ? (props.steering ?? 'Steer the running turn')
      : (props.placeholder ?? 'Ask the agent, or type / for commands')
  let position = -1

  const openHistory = () =>
    setOwn({
      title: 'Conversations',
      filter: true,
      hint: 'type to filter · enter open · esc cancel',
      items: (query) => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean)
        const listed = threads.conversations
          .map(
            (item): Pickers.Item => ({
              kind: 'choice',
              label: item.title || 'New conversation',
              detail: ago(item.updated),
              current: item.id === threads.current,
              value: item.id,
            }),
          )
          .filter((item) => words.every((word) => item.label.toLowerCase().includes(word)))
        return [
          { kind: 'choice', label: '+ New conversation', detail: 'start fresh', value: '' },
          ...listed,
        ]
      },
      onChoose: (item) => {
        if (item.value) threads.select(item.value)
        else threads.create()
      },
    })

  return (
    <section
      aria-label={props.label ?? 'Agent'}
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('a, button, input, textarea, select') || getSelection()?.toString())
          return
        input.current?.focus()
      }}
      {...attachments.drop}
      {...part('chat', {
        dragging: attachments.dragging,
        empty: Boolean(props.greeting) && entries.length === 0 && live.length === 0,
        expanded: full,
      })}
    >
      <div
        aria-live="polite"
        onScroll={() => {
          const node = log.current!
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
        }}
        ref={log}
        {...part('log', { expanded: full })}
      >
        {entries.length === 0 &&
          live.length === 0 &&
          (props.greeting ? (
            <p {...part('greeting')}>{props.greeting}</p>
          ) : (
            props.empty && <p {...part('entry', { kind: 'tool' })}>{props.empty}</p>
          ))}
        {entries.map((entry, index) => (
          <Fragment key={index}>
            <EntryView
              entry={entry}
              previous={entries[index - 1]}
              reasoning={props.reasoning}
              tools={props.tools}
            />
            {props.after?.(entry, index)}
          </Fragment>
        ))}
        {live.map((entry, index) => (
          <EntryView
            entry={entry}
            key={`live-${entry.tool?.call_id ?? index}`}
            live
            previous={index ? live[index - 1] : entries[entries.length - 1]}
            reasoning={props.reasoning}
            tools={props.tools}
          />
        ))}
        {showTyping && <span aria-hidden="true" {...part('pending')} />}
      </div>

      <p aria-live="polite" {...part('typing', { visible: showTyping || Boolean(props.activity) })}>
        {showTyping ? (
          <>
            <span {...part('speaker', { who: 'agent' })}>agent</span> {phrase}
          </>
        ) : props.activity ? (
          <>
            <span {...part('speaker', { who: 'agent' })}>{props.activity.who}</span>{' '}
            {props.activity.text}
          </>
        ) : null}
      </p>

      {props.extras}

      {(picker || items.length > 0) && (
        <div aria-label={picker?.title ?? 'Commands'} role="listbox" {...part('picker')}>
          {picker?.title && <p {...part('pickerTitle')}>{picker.title}</p>}
          {picker?.filter && (
            <p {...part('pickerMuted')}>
              filter: <span {...part('pickerQuery')}>{prompt}</span>
              <span {...part('marker')}>▏</span>
            </p>
          )}
          {picker?.filter && choices.length === 0 && <p {...part('pickerMuted')}> no matches</p>}
          {items.map((item) => {
            if (item.kind === 'header')
              return (
                <p key={`header-${item.label}`} {...part('pickerHeader')}>
                  {item.label}
                </p>
              )
            const index = ++position
            return (
              <button
                aria-selected={index === highlighted}
                key={item.value ?? item.label}
                onClick={() => choose(item)}
                onMouseMove={() => setHighlight(index)}
                role="option"
                style={{ gridTemplateColumns: `2ch ${width}ch 2ch auto` }}
                type="button"
                {...part('choice')}
              >
                <span {...part('marker')}>{index === highlighted ? '›' : ''}</span>
                <span {...part('choiceLabel')}>{item.label}</span>
                <span {...part('marker')}>{item.current ? '✓' : ''}</span>
                <span {...part('choiceDetail')}>{item.detail}</span>
              </button>
            )
          })}
          {picker && (
            <p {...part('pickerMuted')}>
              {picker.hint ??
                (picker.filter
                  ? 'type to filter · enter select · esc cancel'
                  : 'enter select · esc cancel')}
            </p>
          )}
        </div>
      )}

      <AttachmentList items={attachments.items} onRemove={attachments.remove} />

      <div {...part('row')}>
        <span aria-hidden="true" {...part('chevron')}>
          ❯
        </span>
        {attachments.enabled && (
          <>
            <input {...attachments.input} />
            <button
              aria-label="Attach files"
              onClick={attachments.open}
              title="Attach files (or paste, or drop)"
              type="button"
              {...part('attach')}
            >
              +
            </button>
          </>
        )}
        <textarea
          aria-label="Prompt"
          onChange={(event) => {
            setPrompt(event.target.value)
            setHighlight(0)
            setRecalled(-1)
            if (!picker) props.onInput?.(event.target.value)
          }}
          onKeyDown={key}
          onPaste={attachments.onPaste}
          placeholder={placeholder}
          ref={input}
          rows={Math.min(8, Math.max(1, prompt.split('\n').length))}
          value={prompt}
          {...part('input')}
        />
        <button onClick={() => submit(prompt)} type="button" {...part('send')}>
          <kbd {...part('key')}>ENTER</kbd>
        </button>
      </div>

      {(props.suggestions?.length ?? 0) > 0 && (
        <div {...part('suggestions')}>
          {props.suggestions!.map((item) =>
            typeof item === 'string' ? (
              <button key={item} onClick={() => submit(item)} type="button" {...part('suggestion')}>
                {item}
              </button>
            ) : (
              <button
                disabled={item.disabled}
                key={item.label}
                onClick={item.onClick}
                type="button"
                {...part('suggestion')}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}

      <p {...part('status')}>
        <span {...part('statusText')}>{props.status}</span>
        {(props.actions || threads.enabled || canCancel) && (
          <span {...part('actions')}>
            {canCancel && (
              <button
                aria-label="Stop the running turn"
                onClick={() => void cancel()}
                type="button"
                {...part('suggestion', { quiet: true })}
              >
                stop
              </button>
            )}
            {threads.enabled && (
              <button
                disabled={!threads.canSelect}
                onClick={openHistory}
                title="Conversations"
                type="button"
                {...part('suggestion', { quiet: true })}
              >
                history ({threads.conversations.length})
              </button>
            )}
            {props.actions}
          </span>
        )}
        {props.link && (
          <a href={props.link.href} rel="noreferrer" target="_blank" {...part('site')}>
            {props.link.label}
          </a>
        )}
        {props.expandable !== false && (
          <button
            aria-label={full ? 'Collapse chat' : 'Expand chat'}
            aria-pressed={full}
            onClick={() => setFull((value) => !value)}
            title={full ? 'Collapse (Esc)' : 'Expand'}
            type="button"
            {...part('expand')}
          >
            {full ? '↙ collapse' : '↗ expand'}
          </button>
        )}
      </p>
    </section>
  )
}

export declare namespace Chat {
  type Props = {
    tools?: Disclosure
    reasoning?: Disclosure
    onSubmit?(text: string): void
    onInput?(text: string): void
    commands?: readonly Command[]
    picker?: Picker | null
    onPickerClose?(): void
    suggestions?: readonly Suggestion[]
    status?: ReactNode
    actions?: ReactNode
    extras?: ReactNode
    after?(entry: Transcript.Entry, index: number): ReactNode
    link?: { href: string; label: string }
    placeholder?: string
    steering?: string
    activity?: { who: string; text: string }
    empty?: string
    greeting?: ReactNode
    label?: string
    expandable?: boolean
    defaultPrompt?: string
  }
}

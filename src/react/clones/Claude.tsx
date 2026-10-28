'use client'

/**
 * Chat page in the style of Claude.
 *
 * @module
 */
import type * as Config from '../../client/Config.ts'
import type * as Transcript from '../../client/Transcript.ts'
import {
  AttachmentList,
  type Highlighter,
  Markdown,
  NanocodeProvider,
  type Skin,
  ToolCell,
  useActivity,
  useConversations,
  useTurns,
} from '../index.tsx'
import { useState } from 'react'
import { css } from './Claude.css.ts'
import {
  ArrowUp,
  type Block,
  Check,
  Chevron,
  type CloneProps,
  CopyCode,
  grouped,
  Plus,
  Prompts,
  seconds,
  Sidebar,
  Stop,
  Trash,
  useComposer,
  useDismiss,
  useGreeting,
  useResume,
  useSidebar,
  useStick,
} from './Shared.tsx'

const skin: Skin = {
  icons: { cancelled: '–', completed: '✓', failed: '!', running: '', yielded: '↻' },
  parts: {
    body: () => ({ className: 'cl-cell-body' }),
    children: () => ({ className: 'cl-cell-children' }),
    code: () => ({ className: 'cl-pre' }),
    header: () => ({ className: 'cl-cell-head' }),
    heading: () => ({ className: 'md-heading' }),
    icon: () => ({ className: 'cl-cell-icon' }),
    inline: () => ({ className: 'cl-inline' }),
    meta: () => ({ className: 'cl-cell-meta' }),
    more: () => ({ className: 'cl-cell-more' }),
    name: () => ({ className: 'cl-cell-name' }),
    section: () => ({ className: 'cl-cell-section' }),
    title: () => ({ className: 'cl-cell-title' }),
    table: () => ({ className: 'md-table' }),
    tool: () => ({ className: 'cl-cell' }),
  },
}

function ModelMenu(props: ModelMenu.Props) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const { bound, choose, current, models } = props.picker
  const model = models.find((item) => item.id === current) ?? models[0]
  if (!model) return null

  return (
    <div className="cl-model" ref={ref}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="cl-model-button"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {model.label}
        <Chevron />
      </button>
      {open && (
        <div className="cl-menu" role="menu">
          {models.map((item) => (
            <button
              aria-checked={item.id === model.id}
              className="cl-menu-item"
              key={item.id}
              onClick={() => {
                choose(item.id)
                setOpen(false)
              }}
              role="menuitemradio"
              type="button"
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail ?? item.id}</small>
              </span>
              {item.id === model.id && <Check />}
            </button>
          ))}
          {bound && (
            <p className="cl-menu-note">
              This chat keeps its model. Another model starts a new chat.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

declare namespace ModelMenu {
  type Props = {
    picker: NonNullable<CloneProps['picker']>
  }
}

function Thinking(props: Thinking.Props) {
  const [open, setOpen] = useState(false)
  const done = !props.block.live
  const took = seconds(props.block)
  const label = !done ? 'Thinking…' : took ? 'Thought for ' + took + 's' : 'Thought process'

  return (
    <div className="cl-thinking" data-done={done} data-open={open}>
      <button aria-expanded={open} onClick={() => setOpen(!open)} type="button">
        <span>{label}</span>
        <Chevron />
      </button>
      {(open || !done) && (
        <div className="cl-thinking-text">{props.block.text.replace(/\*\*(.+?)\*\*/g, '$1')}</div>
      )}
    </div>
  )
}

declare namespace Thinking {
  type Props = {
    block: Transcript.TurnBlock
  }
}

function BlockView(props: BlockView.Props) {
  const block = props.block
  if (block.kind === 'tools')
    return (
      <div className="cl-tools">
        {block.cells.map((cell) => (
          <ToolCell cell={cell} collapsed key={cell.call_id} live={block.live} />
        ))}
      </div>
    )
  if (block.kind === 'assistant')
    return (
      <div className="cl-md">
        <Markdown
          code={(language, code) => <CopyCode code={code} language={language} />}
          text={block.text}
        />
      </div>
    )
  if (block.kind === 'reasoning') return <Thinking block={block} />
  return (
    <p className="cl-note" data-error={block.kind === 'error'}>
      {block.text}
    </p>
  )
}

declare namespace BlockView {
  type Props = {
    block: Block
  }
}

function Composer(props: Composer.Props) {
  const composer = useComposer({
    ...(props.before ? { before: props.before } : {}),
    onSend: props.onSend,
    ...(props.send ? { send: props.send } : {}),
    ...(props.warm ? { warm: props.warm } : {}),
  })

  return (
    <div
      className="cl-composer"
      data-dragging={composer.attachments.dragging}
      {...composer.attachments.drop}
    >
      <AttachmentList items={composer.attachments.items} onRemove={composer.attachments.remove} />
      <textarea
        placeholder={composer.busy ? 'Add to the response…' : 'How can I help you today?'}
        {...composer.textarea}
      />
      <div className="cl-composer-row">
        {composer.attachments.enabled && (
          <>
            <input {...composer.attachments.input} />
            <button
              aria-label="Attach files"
              className="cl-attach"
              onClick={composer.attachments.open}
              title="Attach files"
              type="button"
            >
              <Plus />
            </button>
          </>
        )}
        {props.picker ? <ModelMenu picker={props.picker} /> : <span className="cl-model" />}
        {composer.canCancel && composer.empty ? (
          <button
            aria-label="Stop"
            className="cl-send"
            onClick={() => void composer.cancel()}
            type="button"
          >
            <Stop />
          </button>
        ) : (
          <button
            aria-label="Send"
            className="cl-send"
            disabled={composer.empty}
            onClick={(event) => {
              event.stopPropagation()
              composer.submit()
            }}
            type="button"
          >
            <ArrowUp />
          </button>
        )}
      </div>
    </div>
  )
}

declare namespace Composer {
  type Props = CloneProps & { onSend(): void }
}

function App(props: CloneProps) {
  useResume()
  const thread = useTurns()
  const threads = useConversations()
  const sidebar = useSidebar()
  const log = useStick(thread)
  const activity = useActivity()
  const greeting = useGreeting()
  const busy = activity.busy || Boolean(props.busy)
  const title = threads.conversations.find((item) => item.id === threads.current)?.title

  const streaming = activity.phase === 'writing' || activity.phase === 'thinking'
  const newChat = () => {
    threads.create()
    sidebar.close()
  }
  const footer = props.footer && <p className="cl-foot">{props.footer}</p>
  const composer = <Composer {...props} onSend={log.pin} />
  const input = props.input ? props.input(composer) : composer

  return (
    <div className="cl" data-sidebar={sidebar.open}>
      <aside className="cl-sidebar">
        <div className="cl-sidebar-top">
          <button
            aria-label="Close sidebar"
            className="cl-icon"
            onClick={sidebar.toggle}
            type="button"
          >
            <Sidebar />
          </button>
          <span className="cl-brand">{props.title ?? 'Claude'}</span>
        </div>
        <button className="cl-new" disabled={!threads.canCreate} onClick={newChat} type="button">
          <span className="cl-new-icon">
            <Plus />
          </span>
          New chat
        </button>
        <p className="cl-section">Recents</p>
        <nav className="cl-chats">
          {threads.conversations.map((item) => (
            <div className="cl-chat" data-current={item.id === threads.current} key={item.id}>
              <button
                disabled={!threads.canSelect}
                onClick={() => {
                  threads.select(item.id)
                  sidebar.close()
                }}
                type="button"
              >
                {item.title || 'New chat'}
              </button>
              <button
                aria-label="Delete chat"
                className="cl-chat-remove"
                onClick={() => threads.remove(item.id)}
                type="button"
              >
                <Trash />
              </button>
            </div>
          ))}
        </nav>
        {props.sidebar}
      </aside>
      <div className="cl-scrim" onClick={sidebar.toggle} />
      <main className="cl-main">
        <header className="cl-top">
          <button
            aria-label="Open sidebar"
            className="cl-icon cl-open"
            onClick={sidebar.toggle}
            type="button"
          >
            <Sidebar />
          </button>
          <span className="cl-title">{thread.length ? title || 'New chat' : ''}</span>
          {props.actions}
          <button
            aria-label="New chat"
            className="cl-icon cl-top-new"
            disabled={!threads.canCreate}
            onClick={newChat}
            type="button"
          >
            <Plus />
          </button>
        </header>
        {thread.length === 0 ? (
          <div className="cl-hero">
            <h1>
              <span aria-hidden="true" className="cl-spark">
                ✻
              </span>
              {props.heading ?? greeting}
            </h1>
            {input}
            {props.suggestions ?? (
              <Prompts
                onSend={log.pin}
                prompts={props.prompts}
                {...(props.warm ? { warm: props.warm } : {})}
              />
            )}
            {footer}
          </div>
        ) : (
          <>
            <div aria-live="polite" className="cl-log" onScroll={log.onScroll} ref={log.ref}>
              <div className="cl-thread">
                {thread.map((turn, index) => (
                  <section className="cl-turn" key={turn.id}>
                    {turn.prompt && (
                      <div className="cl-user">
                        <span aria-hidden="true" className="cl-avatar">
                          Y
                        </span>
                        <div>
                          {turn.prompt.text}
                          {turn.prompt.attachments?.length ? (
                            <AttachmentList items={turn.prompt.attachments} />
                          ) : null}
                        </div>
                      </div>
                    )}
                    <div className="cl-assistant">
                      {grouped(turn.blocks).map((block, position) => (
                        <BlockView block={block} key={position} />
                      ))}
                      {index === thread.length - 1 && (
                        <span
                          aria-label={busy ? 'Responding' : undefined}
                          className="cl-spark cl-status"
                          data-busy={busy}
                          data-streaming={streaming}
                        >
                          ✻
                        </span>
                      )}
                    </div>
                  </section>
                ))}
              </div>
            </div>
            <div className="cl-bottom">
              {input}
              {footer}
            </div>
          </>
        )}
      </main>
    </div>
  )
}

/** Chat page in the style of Claude. */
export function Claude(props: Claude.Props) {
  return (
    <NanocodeProvider
      config={props.config}
      skin={props.parts ? { ...skin, parts: { ...skin.parts, ...props.parts } } : skin}
      {...(props.highlight ? { highlight: props.highlight } : {})}
    >
      <style href="nanocode-ts-claude" precedence="nanocode">
        {css}
      </style>
      <App {...props} />
    </NanocodeProvider>
  )
}

export declare namespace Claude {
  type Props = CloneProps & {
    config: Config.Config
    highlight?: () => Promise<Highlighter>
  }
}

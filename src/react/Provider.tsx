'use client'

/**
 * Chat context: the provider that holds the chat store, skin, and highlighter, and the hooks that read them.
 *
 * @module
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import type * as Config from '../client/Config.ts'
import type * as Tool from '../client/Tool.ts'
import * as Transcript from '../client/Transcript.ts'
import type * as Transport from '../client/Transport.ts'

/** Highlighted span of code. */
export type Token = { content: string; color?: string; italic?: boolean }

/** Returns the highlighted lines of `code`. */
export type Highlighter = (code: string, language: string) => Token[][]

/** Name of a part that a skin styles. */
export type Part =
  | 'attach'
  | 'attachment'
  | 'attachmentName'
  | 'attachmentRemove'
  | 'attachmentSize'
  | 'attachmentThumb'
  | 'attachments'
  | 'actions'
  | 'body'
  | 'cell'
  | 'chat'
  | 'chevron'
  | 'children'
  | 'choice'
  | 'choiceDetail'
  | 'choiceLabel'
  | 'code'
  | 'em'
  | 'entry'
  | 'expand'
  | 'figure'
  | 'greeting'
  | 'hand'
  | 'handActions'
  | 'handButton'
  | 'handCommand'
  | 'handStatus'
  | 'handText'
  | 'handTitle'
  | 'header'
  | 'heading'
  | 'icon'
  | 'image'
  | 'images'
  | 'inline'
  | 'input'
  | 'item'
  | 'key'
  | 'link'
  | 'list'
  | 'log'
  | 'markdown'
  | 'marker'
  | 'meta'
  | 'more'
  | 'name'
  | 'paragraph'
  | 'picker'
  | 'pickerHeader'
  | 'pickerMuted'
  | 'pickerQuery'
  | 'pickerTitle'
  | 'plan'
  | 'planActions'
  | 'planButton'
  | 'planCode'
  | 'planInput'
  | 'planStatus'
  | 'planText'
  | 'planTitle'
  | 'quote'
  | 'row'
  | 'rule'
  | 'section'
  | 'pending'
  | 'send'
  | 'sidebar'
  | 'sidebarChat'
  | 'sidebarChats'
  | 'sidebarNew'
  | 'sidebarRemove'
  | 'sidebarSection'
  | 'site'
  | 'speaker'
  | 'status'
  | 'statusText'
  | 'strike'
  | 'strong'
  | 'suggestion'
  | 'suggestions'
  | 'table'
  | 'title'
  | 'tool'
  | 'turn'
  | 'typing'
  | 'account'
  | 'accountActions'
  | 'accountAvatar'
  | 'accountLogin'
  | 'accountWho'
  | 'meter'
  | 'meterBolt'
  | 'meterDot'
  | 'meterEmpty'
  | 'meterHead'
  | 'meterName'
  | 'meterRow'
  | 'meterRows'
  | 'meterSpark'
  | 'prompt'
  | 'signIn'
  | 'signInButton'
  | 'spend'
  | 'spendAccent'
  | 'spendCalls'
  | 'spendDot'
  | 'spendEmpty'
  | 'spendSpark'
  | 'spendTitle'
  | 'unlock'
  | 'unlockButton'
  | 'walletCard'
  | 'walletCardActions'
  | 'walletCardButton'
  | 'walletCardText'
  | 'walletCardTitle'

/** State of a part, which renders as `data-*` attributes. */
export type PartState = Record<string, string | number | boolean | undefined>

/** Attributes of a part. */
export type PartProps = {
  className?: string
  style?: Record<string, string | number | undefined>
} & Record<string, unknown>

/** Class names and icons of each part. */
export type Skin = {
  parts?: Partial<Record<Part, (state: PartState) => PartProps>>
  icons?: Partial<Record<Tool.Cell['status'], string | readonly string[]>>
}

const emptySkin: Skin = {}

const SkinContext = createContext<Skin>(emptySkin)

/** Returns the skin of the provider. */
export function useSkin(): Skin {
  return useContext(SkinContext)
}

/** Returns the function that resolves the attributes of a part. */
export function usePart(): (name: Part, state?: PartState) => PartProps {
  const skin = useSkin()
  return useCallback(
    (name: Part, state: PartState = {}) => {
      const attributes: PartProps = { 'data-nc': name }
      for (const [key, value] of Object.entries(state))
        if (value !== undefined)
          attributes['data-' + key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())] =
            String(value)
      const skinned = skin.parts?.[name]?.(state)
      return skinned ? { ...attributes, ...skinned } : attributes
    },
    [skin],
  )
}

/** Context of the chat store. */
export const ConfigContext = createContext<Config.Config | undefined>(undefined)

const ExpandedContext = createContext<{
  open: ReadonlySet<string>
  toggle(id: string, open?: boolean): void
}>({ open: new Set(), toggle: () => {} })

/** Returns the expanded cells and their toggle. */
export function useExpanded(): {
  open: ReadonlySet<string>
  toggle(id: string, open?: boolean): void
} {
  return useContext(ExpandedContext)
}

const LinkContext = createContext<((href: string) => string | undefined) | undefined>(undefined)

/** Returns the link resolver of the provider. */
export function useLinks() {
  return useContext(LinkContext)
}

const HighlightContext = createContext<{ highlighter?: Highlighter; request?(): void }>({})

/** Provides the chat store, skin, highlighter, and link resolver to its children. */
export function NanocodeProvider(props: NanocodeProvider.Props) {
  const [highlighter, setHighlighter] = useState<Highlighter>()
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = useCallback(
    (id: string, value?: boolean) =>
      setOpen((current) => {
        const next = new Set(current)
        if (value ?? !next.has(id)) next.add(id)
        else next.delete(id)
        return next
      }),
    [],
  )
  const expanded = useMemo(() => ({ open, toggle }), [open, toggle])
  const { highlight } = props
  const [wanted, setWanted] = useState(false)
  const request = useCallback(() => setWanted(true), [])
  const highlighting = useMemo(
    () => ({ ...(highlighter ? { highlighter } : {}), ...(highlight ? { request } : {}) }),
    [highlighter, highlight, request],
  )
  useEffect(() => {
    if (!highlight || !wanted) return
    let active = true
    highlight().then(
      (loaded) => {
        if (active) setHighlighter(() => loaded)
      },
      () => {},
    )
    return () => {
      active = false
    }
  }, [highlight, wanted])
  useEffect(() => {
    const start = () => void preloadMarkdown().catch(() => {})
    if (typeof requestIdleCallback !== 'function') {
      const timer = setTimeout(start, 200)
      return () => clearTimeout(timer)
    }
    const id = requestIdleCallback(start, { timeout: 1500 })
    return () => cancelIdleCallback(id)
  }, [])
  return (
    <ConfigContext.Provider value={props.config}>
      <SkinContext.Provider value={props.skin ?? emptySkin}>
        <ExpandedContext.Provider value={expanded}>
          <HighlightContext.Provider value={highlighting}>
            <LinkContext.Provider value={props.links}>{props.children}</LinkContext.Provider>
          </HighlightContext.Provider>
        </ExpandedContext.Provider>
      </SkinContext.Provider>
    </ConfigContext.Provider>
  )
}

export declare namespace NanocodeProvider {
  type Props = {
    config: Config.Config
    highlight?: () => Promise<Highlighter>
    skin?: Skin
    links?(href: string): string | undefined
    children: ReactNode
  }
}

/** Loads the Markdown renderer. */
export function preloadMarkdown(): Promise<unknown> {
  return import('./Streamed.tsx')
}

/** Returns the chat store, and throws outside `NanocodeProvider`. */
export function useConfig(): Config.Config {
  const config = useContext(ConfigContext)
  if (!config) throw new Error('useConfig must be used within NanocodeProvider')
  return config
}

function useChatState<T>(select: (state: Config.State) => T): T {
  const config = useConfig()
  return useSyncExternalStore(
    config.subscribe,
    () => select(config.getState()),
    () => select(config.getServerState()),
  )
}

/** Returns the posted and live entries. */
export function useTranscript(): {
  entries: readonly Transcript.Entry[]
  live: readonly Transcript.Entry[]
} {
  const entries = useChatState((state) => state.entries)
  const live = useChatState((state) => state.live)
  return useMemo(() => ({ entries, live }), [entries, live])
}

/** Returns the send and cancel operations and the status of the turn. */
export function useSend(): {
  send(prompt: string, attachments?: readonly Transport.Attachment[]): Promise<void>
  cancel(): Promise<void>
  canCancel: boolean
  isPending: boolean
  isIdle: boolean
  error: Error | undefined
} {
  const config = useConfig()
  const status = useChatState((state) => state.status)
  const error = useChatState((state) => state.error)
  return {
    send: config.send,
    cancel: config.cancel,
    canCancel: status === 'pending' && config.cancellable,
    isPending: status === 'pending',
    isIdle: status === 'idle',
    error,
  }
}

/** Returns the turns of the transcript. */
export function useTurns(): Transcript.Turn[] {
  const { entries, live } = useTranscript()
  const pending = useChatState((state) => state.status === 'pending')
  return useMemo(() => Transcript.turns(entries, { live, pending }), [entries, live, pending])
}

/** Returns the activity of the current turn. */
export function useActivity(): Transcript.Activity {
  const live = useChatState((state) => state.live)
  const pending = useChatState((state) => state.status === 'pending')
  return useMemo(() => Transcript.activity(live, { pending }), [live, pending])
}

/** Returns the assistant text of the last turn and its status. */
export function useAnswer(): {
  text: string
  prompt: string | undefined
  live: boolean
  busy: boolean
  activity: Transcript.Activity
  error: Error | undefined
} {
  const all = useTurns()
  const doing = useActivity()
  const error = useChatState((state) => state.error)
  const last = all[all.length - 1]
  const text = useMemo(
    () =>
      (last?.blocks ?? [])
        .filter((block) => block.kind === 'assistant')
        .map((block) => block.text)
        .join('\n\n'),
    [last],
  )
  return {
    activity: doing,
    busy: doing.busy,
    error,
    live: last?.live ?? false,
    prompt: last?.prompt?.text,
    text,
  }
}

/** Returns the stored conversations and their operations. */
export function useConversations(): {
  conversations: readonly Config.Conversation[]
  current: string | undefined
  enabled: boolean
  canCreate: boolean
  canSelect: boolean
  select(id: string): void
  create(): string | undefined
  remove(id: string): void
} {
  const config = useConfig()
  const conversations = useChatState((state) => state.conversations)
  const current = useChatState((state) => state.conversation)
  const pending = useChatState((state) => state.status === 'pending')
  const empty = useChatState((state) => state.entries.length === 0)
  const enabled = current !== undefined
  return {
    conversations,
    current,
    enabled,
    canCreate: enabled && !empty && (!pending || config.detachable),
    canSelect: enabled && (!pending || config.detachable),
    select: config.select,
    create: config.create,
    remove: config.remove,
  }
}

/** Returns the operation that posts a note. */
export function useNote(): (kind: Transcript.EntryKind, text: string) => void {
  return useConfig().note
}

let fallback: Promise<Highlighter> | undefined

/** Returns the highlighter, and loads it when `wanted`. */
export function useHighlighter(wanted = true): Highlighter | undefined {
  const { highlighter: provided, request } = useContext(HighlightContext)
  const [loaded, setLoaded] = useState<Highlighter>()
  useEffect(() => {
    if (provided || !wanted) return
    if (request) return request()
    let active = true
    fallback ??= import('../Highlight.ts').then((module) => module.highlight)
    fallback.then(
      (highlighter) => {
        if (active) setLoaded(() => highlighter)
      },
      () => {},
    )
    return () => {
      active = false
    }
  }, [provided, request, wanted])
  return provided ?? loaded
}

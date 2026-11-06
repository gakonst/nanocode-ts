import * as Styles from './Feedback.styles.ts'
import * as Report from './Report.ts'

export type Link = { href: string; text: string }

export type Prompt = { code: string; expiresAt: number; url: string }

export type Sent = { label: string; link?: Link | undefined }

export type Status = { ready: true } | Unready

export type Target = {
  send(report: Report.Report, events: Target.Events): Promise<Sent>
  status?: (() => Promise<Status>) | undefined
}

export type Unready = { help?: Link | undefined; ready: false; reason: string }

export declare namespace Target {
  type Events = { prompt(prompt: Prompt): void; signal: AbortSignal }
}

export function mount(options: mount.Options): mount.ReturnType {
  const parameter = options.parameter ?? 'feedback'
  const remembered = 'nanocode.feedback.shown'
  const storage = options.storage ?? globalThis.localStorage
  const notes: Note[] = []
  let controller: AbortController | undefined
  let frame = 0
  let hovered: Element | undefined
  let parts: Parts | undefined
  let state: State = { at: 'closed' }
  let unready: Unready | undefined

  const beneath = (x: number, y: number) =>
    document
      .elementsFromPoint(x, y)
      .find((found) => found !== parts?.host && found !== document.documentElement)

  const compose = (): Report.Report => {
    const url = new URL(location.href)
    url.searchParams.delete(parameter)

    return {
      comments: notes.map((entry) =>
        Report.describe(entry.element, { excerpt: options.excerpt, note: entry.note }),
      ),
      title: document.title,
      url: url.href,
      viewport: { height: innerHeight, width: innerWidth },
    }
  }

  const go = (next: State) => {
    state = next
    render()
  }

  const settle = () => go(notes.length ? { at: 'reviewing' } : { at: 'closed' })

  const hover = (event: Event) => {
    const point = event as PointerEvent
    hovered = beneath(point.clientX, point.clientY)
    place()
  }

  const pick = (event: Event) => {
    const point = event as MouseEvent
    event.preventDefault()
    const target = beneath(point.clientX, point.clientY)
    if (target) go({ at: 'writing', element: target })
  }

  const launch = () => {
    if (unready)
      return go(state.at === 'setup' ? { at: 'closed' } : { at: 'setup', status: unready })
    if (state.at === 'closed') return go(notes.length ? { at: 'reviewing' } : { at: 'picking' })
    if (state.at === 'sending') return
    controller?.abort()
    go({ at: 'closed' })
  }

  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || state.at === 'closed' || state.at === 'sending') return
    if (state.at === 'setup') return go({ at: 'closed' })
    event.stopPropagation()
    if (state.at === 'picking' || state.at === 'writing') return settle()
    go({ at: 'closed' })
  }

  const save = (event: Event) => {
    event.preventDefault()
    const field = parts?.editor.querySelector('textarea')
    const note = field?.value.trim()
    if (state.at !== 'writing' || !note) return

    notes.push({ element: state.element, note })
    go({ at: 'reviewing' })
  }

  const send = async () => {
    controller = new AbortController()
    const signal = controller.signal
    go({ at: 'sending' })

    const outcome = await options.target
      .send(compose(), {
        prompt: (prompt) => {
          if (!signal.aborted && state.at === 'sending') go({ at: 'sending', prompt })
        },
        signal,
      })
      .then(
        (sent) => ({ sent }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      )
    if (signal.aborted) return

    if ('error' in outcome) return go({ at: 'failed', error: outcome.error })
    storage?.setItem(remembered, '1')
    notes.length = 0
    go({ at: 'sent', sent: outcome.sent })
  }

  const cancel = () => {
    controller?.abort()
    settle()
  }

  const hide = () => {
    storage?.removeItem(remembered)
    unmount()
  }

  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      place()
    })
  }

  const place = () => {
    if (!parts) return

    const box = (() => {
      if (state.at === 'writing') return state.element.getBoundingClientRect()
      if (state.at === 'picking' && hovered) return hovered.getBoundingClientRect()
      return undefined
    })()
    parts.highlight.hidden = !box
    if (box) outline(parts.highlight, box)

    parts.pins.replaceChildren(
      ...notes.flatMap((entry, index) => {
        if (!entry.element.isConnected) return []
        const rect = entry.element.getBoundingClientRect()
        const pin = element('span', {
          attributes: { 'aria-hidden': 'true' },
          className: 'pin',
          text: String(index + 1),
        })
        pin.style.transform = `translate(${clamp(rect.left - 10, innerWidth - 20)}px, ${clamp(rect.top - 10, innerHeight - 20)}px)`
        return [pin]
      }),
    )

    if (state.at !== 'writing') return
    const rect = state.element.getBoundingClientRect()
    const height = parts.editor.offsetHeight
    const width = parts.editor.offsetWidth
    const below = rect.bottom + 8 + height <= innerHeight
    const top = below ? rect.bottom + 8 : rect.top - 8 - height
    parts.editor.style.left = clamp(rect.left, innerWidth - width - 12) + 'px'
    parts.editor.style.top = clamp(top, innerHeight - height - 12) + 'px'
  }

  const render = () => {
    if (!parts) return

    const open = state.at !== 'closed'
    parts.launcher.setAttribute('aria-expanded', String(open))
    parts.launcher.replaceChildren(
      'Feedback',
      ...(notes.length
        ? [element('span', { className: 'count', text: String(notes.length) })]
        : []),
    )
    parts.overlay.hidden = state.at !== 'picking'
    parts.editor.hidden = state.at !== 'writing'
    parts.panel.hidden = !open || state.at === 'writing'

    if (state.at === 'writing') {
      const field = element('textarea', {
        attributes: { name: 'note', required: '', rows: '3' },
      })
      parts.editor.replaceChildren(
        element('label', { children: ['What should change?', field] }),
        element('div', {
          children: [
            button('Cancel', { on: settle }),
            button('Save', { primary: true, type: 'submit' }),
          ],
          className: 'row',
        }),
      )
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) parts?.editor.requestSubmit()
      })
      place()
      field.focus()
    }

    parts.panel.replaceChildren(...panel())
    place()
    if (state.at === 'closed') hovered = undefined
  }

  const panel = (): readonly Node[] => {
    if (state.at === 'setup')
      return [
        element('h2', { text: 'Feedback is not set up' }),
        element('p', { attributes: { role: 'status' }, text: state.status.reason }),
        element('div', {
          children: [
            button('Close', { on: () => go({ at: 'closed' }) }),
            ...(state.status.help
              ? [link(state.status.help.text, { href: state.status.help.href, primary: true })]
              : []),
          ],
          className: 'row',
        }),
      ]

    if (state.at === 'picking')
      return [
        element('p', { text: 'Click anything on the page to comment on it.' }),
        element('div', {
          children: [
            element('span', { className: 'muted', text: 'Esc to stop' }),
            button(notes.length ? 'Done' : 'Cancel', { on: settle }),
          ],
          className: 'row head',
        }),
      ]

    if (state.at === 'reviewing')
      return [
        element('div', {
          children: [
            element('h2', { text: 'Feedback' }),
            button('Hide', {
              on: hide,
              quiet: true,
              title: 'Hide this widget until the page opens with ?' + parameter,
            }),
          ],
          className: 'row head',
        }),
        element('ol', {
          children: notes.map((entry, index) =>
            element('li', {
              children: [
                element('span', { className: 'pin', text: String(index + 1) }),
                element('p', { text: entry.note }),
                button('Remove', {
                  on: () => {
                    notes.splice(index, 1)
                    settle()
                  },
                  quiet: true,
                }),
              ],
            }),
          ),
        }),
        element('div', {
          children: [
            button('New comment', { on: () => go({ at: 'picking' }) }),
            button('Send', { on: () => void send(), primary: true }),
          ],
          className: 'row',
        }),
      ]

    if (state.at === 'sending' && state.prompt)
      return [
        element('h2', { text: 'Approve in Tempo Wallet' }),
        element('p', { className: 'muted', text: 'Tempo Wallet shows this code:' }),
        element('p', { className: 'code', text: state.prompt.code }),
        element('div', {
          children: [
            button('Cancel', { on: cancel }),
            link('Open Tempo Wallet', { href: state.prompt.url, primary: true }),
          ],
          className: 'row',
        }),
      ]

    if (state.at === 'sending')
      return [
        element('p', { attributes: { role: 'status' }, text: 'Sending…' }),
        element('div', { children: [button('Cancel', { on: cancel })], className: 'row' }),
      ]

    if (state.at === 'sent')
      return [
        element('p', { attributes: { role: 'status' }, text: state.sent.label }),
        element('div', {
          children: [
            button('Done', { on: () => go({ at: 'closed' }) }),
            ...(state.sent.link
              ? [link(state.sent.link.text, { href: state.sent.link.href, primary: true })]
              : []),
          ],
          className: 'row',
        }),
      ]

    if (state.at === 'failed')
      return [
        element('p', { attributes: { role: 'alert' }, className: 'error', text: state.error }),
        element('div', {
          children: [
            button('Back', { on: settle }),
            button('Try again', { on: () => void send(), primary: true }),
          ],
          className: 'row',
        }),
      ]

    return []
  }

  const show = () => {
    if (parts) return

    const host = element('div', { attributes: { 'data-nanocode-feedback': '' } })
    const root = host.attachShadow({ mode: 'open' })
    parts = {
      editor: element('form', { attributes: { 'aria-label': 'Comment' }, className: 'editor' }),
      highlight: element('div', { className: 'highlight' }),
      host,
      launcher: element('button', {
        attributes: { 'aria-haspopup': 'dialog', type: 'button' },
        className: 'launcher',
      }),
      overlay: element('div', { className: 'overlay' }),
      panel: element('section', { attributes: { 'aria-label': 'Feedback' }, className: 'panel' }),
      pins: element('div', { className: 'pins' }),
    }
    parts.editor.addEventListener('submit', save)
    parts.launcher.addEventListener('click', launch)
    parts.overlay.addEventListener('click', pick)
    parts.overlay.addEventListener('pointermove', hover)
    root.append(
      element('style', { text: Styles.css }),
      parts.overlay,
      parts.highlight,
      parts.pins,
      parts.editor,
      parts.panel,
      parts.launcher,
    )
    document.body.append(host)
    addEventListener('keydown', key, true)
    addEventListener('resize', schedule, { passive: true })
    addEventListener('scroll', schedule, { capture: true, passive: true })
    render()
    void options.target
      .status?.()
      .catch((error: unknown) => ({
        ready: false as const,
        reason: error instanceof Error ? error.message : String(error),
      }))
      .then((status) => {
        if (!status || status.ready || !parts) return
        unready = status
        go({ at: 'setup', status })
      })
  }

  const unmount = () => {
    controller?.abort()
    cancelAnimationFrame(frame)
    frame = 0
    removeEventListener('keydown', key, true)
    removeEventListener('resize', schedule)
    removeEventListener('scroll', schedule, { capture: true })
    parts?.host.remove()
    parts = undefined
    state = { at: 'closed' }
  }

  if (new URL(location.href).searchParams.has(parameter) || storage?.getItem(remembered) === '1')
    show()

  return { show, unmount }
}

export declare namespace mount {
  type Options = {
    excerpt: number
    parameter?: string | undefined
    storage?: Storage | undefined
    target: Target
  }
  type ReturnType = { show(): void; unmount(): void }
}

type Note = { element: Element; note: string }

type Parts = {
  editor: HTMLFormElement
  highlight: HTMLDivElement
  host: HTMLDivElement
  launcher: HTMLButtonElement
  overlay: HTMLDivElement
  panel: HTMLElement
  pins: HTMLDivElement
}

type State =
  | { at: 'closed' }
  | { at: 'failed'; error: string }
  | { at: 'picking' }
  | { at: 'reviewing' }
  | { at: 'sending'; prompt?: Prompt | undefined }
  | { at: 'sent'; sent: Sent }
  | { at: 'setup'; status: Unready }
  | { at: 'writing'; element: Element }

function button(text: string, options: button.Options = {}) {
  const made = element('button', {
    attributes: {
      type: options.type ?? 'button',
      ...(options.title ? { title: options.title } : {}),
    },
    className: [options.primary ? 'primary' : '', options.quiet ? 'quiet' : '']
      .filter(Boolean)
      .join(' '),
    text,
  })
  if (options.on) made.addEventListener('click', options.on)
  return made
}

declare namespace button {
  type Options = {
    on?: (() => void) | undefined
    primary?: boolean | undefined
    quiet?: boolean | undefined
    title?: string | undefined
    type?: 'button' | 'submit' | undefined
  }
}

function clamp(value: number, most: number) {
  return Math.max(12, Math.min(value, most))
}

function element<const Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  options: element.Options = {},
): HTMLElementTagNameMap[Tag] {
  const made = document.createElement(tag)
  for (const [name, value] of Object.entries(options.attributes ?? {}))
    made.setAttribute(name, value)
  if (options.className) made.className = options.className
  if (options.text !== undefined) made.textContent = options.text
  made.append(...(options.children ?? []))
  return made
}

declare namespace element {
  type Options = {
    attributes?: Record<string, string> | undefined
    children?: readonly (Node | string)[] | undefined
    className?: string | undefined
    text?: string | undefined
  }
}

function link(text: string, options: link.Options) {
  return element('a', {
    attributes: { href: options.href, rel: 'noopener', target: '_blank' },
    className: options.primary ? 'button primary' : 'button',
    text,
  })
}

declare namespace link {
  type Options = { href: string; primary?: boolean | undefined }
}

function outline(target: HTMLElement, box: DOMRect) {
  target.style.height = box.height + 'px'
  target.style.transform = `translate(${box.left}px, ${box.top}px)`
  target.style.width = box.width + 'px'
}

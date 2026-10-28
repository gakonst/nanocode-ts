'use client'

import { isValidElement, type JSX, type ReactNode, useMemo, useRef } from 'react'
import {
  type Components,
  defaultRehypePlugins,
  Streamdown,
  type StreamdownProps,
  useIsCodeFenceIncomplete,
} from 'streamdown'
import { Code } from './Code.tsx'
import { Image } from './Image.tsx'
import type { Markdown } from './Markdown.tsx'
import { useLinks, usePart } from './Provider.tsx'

type PartOf = ReturnType<typeof usePart>

type PluggableList = NonNullable<StreamdownProps['rehypePlugins']>

type Pluggable = PluggableList[number]

type Hast = { type: string; tagName?: string; value?: string; children?: Hast[] }

const blockTags = new Set([
  'blockquote',
  'div',
  'li',
  'ol',
  'section',
  'table',
  'tbody',
  'thead',
  'tr',
  'ul',
])

function trim() {
  const visit = (node: Hast, root: boolean) => {
    if (!node.children) return
    if (root || blockTags.has(node.tagName ?? ''))
      node.children = node.children.filter(
        (child) => child.type !== 'text' || !/^\s*\n\s*$/.test(child.value ?? ''),
      )
    for (const child of node.children) visit(child, false)
  }
  return (tree: Hast) => visit(tree, true)
}

const [sanitize, schema] = defaultRehypePlugins.sanitize as [
  Extract<Pluggable, (...args: never[]) => unknown>,
  { protocols?: Record<string, string[]> },
]

const rehype: PluggableList = [
  defaultRehypePlugins.raw!,
  [
    sanitize,
    {
      ...schema,
      protocols: {
        ...schema.protocols,
        src: [...(schema.protocols?.src ?? []), 'data', 'workspace', 'sandbox'],
      },
    },
  ],
  defaultRehypePlugins.harden!,
  trim,
]

const linkPattern = /^(https?:|mailto:)/i

type Props<T extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[T] & { node?: unknown }

function text(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(text).join('')
  if (isValidElement<{ children?: ReactNode }>(children)) return text(children.props.children)
  return children === undefined || children === null || typeof children === 'boolean'
    ? ''
    : String(children)
}

function Fence(props: Fence.Props) {
  const incomplete = useIsCodeFenceIncomplete()
  return (
    <>
      {props.render.current?.(props.language, props.code) ?? (
        <Code code={props.code} framed incomplete={incomplete} language={props.language} />
      )}
    </>
  )
}

declare namespace Fence {
  type Props = {
    code: string
    language: string
    render: { current: Markdown.Props['code'] }
  }
}

function popup(event: { preventDefault(): void }, href: string) {
  if (globalThis.open?.(href, 'nanocode-link', 'popup,width=960,height=800')) event.preventDefault()
}

const destinationPattern = /(\]\()(<[^>\n]*>|[^()\s]+)/g

function mapped(
  text: string,
  links: ((href: string) => string | undefined) | undefined,
  popups: Set<string>,
): string {
  if (!links || !text.includes('](')) return text
  return text.replace(destinationPattern, (whole: string, open: string, destination: string) => {
    const href = destination.startsWith('<') ? destination.slice(1, -1) : destination
    if (linkPattern.test(href)) return whole
    const target = links(href)
    if (!target) return whole
    const absolute = new URL(target, globalThis.location?.href ?? 'https://localhost/').href
    popups.add(absolute)
    return open + absolute
  })
}

function components(
  part: PartOf,
  render: { current: Markdown.Props['code'] },
  popups: Set<string>,
): Components {
  const heading = (level: number) => (props: Props<'h1'>) => {
    const Tag = ('h' + level) as 'h1'
    return <Tag {...part('heading', { level })}>{props.children}</Tag>
  }
  const align = (props: Props<'td'>) => {
    const value = (props.style as { textAlign?: string } | undefined)?.textAlign ?? props.align
    return value === 'left' || value === 'center' || value === 'right' ? value : undefined
  }
  return {
    a: (props: Props<'a'>) => {
      const href = props.href
      if (!href || !linkPattern.test(href))
        return <span {...part('link', { incomplete: true })}>{props.children}</span>
      return (
        <a
          href={href}
          onClick={popups.has(href) ? (event) => popup(event, href) : undefined}
          rel="noreferrer"
          target="_blank"
          title={props.title}
          {...part('link')}
        >
          {props.children}
        </a>
      )
    },
    blockquote: (props: Props<'blockquote'>) => (
      <blockquote {...part('quote')}>{props.children}</blockquote>
    ),
    code: (props: Props<'code'> & { 'data-block'?: string }) => {
      if (!('data-block' in props)) return <code {...part('inline')}>{props.children}</code>
      const language = /language-(\S+)/.exec(props.className ?? '')?.[1] ?? 'text'
      return (
        <Fence code={text(props.children).replace(/\n$/, '')} language={language} render={render} />
      )
    },
    del: (props: Props<'del'>) => <del {...part('strike')}>{props.children}</del>,
    em: (props: Props<'em'>) => <em {...part('em')}>{props.children}</em>,
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    hr: () => <hr {...part('rule')} />,
    img: (props: Props<'img'>) => (
      <Image
        alt={props.alt}
        src={typeof props.src === 'string' ? props.src : ''}
        title={props.title}
      />
    ),
    inlineCode: (props: Props<'code'>) => <code {...part('inline')}>{props.children}</code>,
    li: (props: Props<'li'>) => <li {...part('item')}>{props.children}</li>,
    ol: (props: Props<'ol'>) => (
      <ol start={props.start} {...part('list', { ordered: true })}>
        {props.children}
      </ol>
    ),
    p: (props: Props<'p'>) => <p {...part('paragraph')}>{props.children}</p>,
    strong: (props: Props<'strong'>) => <strong {...part('strong')}>{props.children}</strong>,
    table: (props: Props<'table'>) => <table {...part('table')}>{props.children}</table>,
    td: (props: Props<'td'>) => (
      <td {...part('cell', { align: align(props), header: false })}>{props.children}</td>
    ),
    th: (props: Props<'th'>) => (
      <th {...part('cell', { align: align(props), header: true })}>{props.children}</th>
    ),
    ul: (props: Props<'ul'>) => <ul {...part('list', { ordered: false })}>{props.children}</ul>,
  }
}

const off = { enabled: false }

const tableRow = /^ {0,3}\|.*\|/

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function table(text: string): string {
  const lines = text.split('\n')
  const last =
    lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 2 : lines.length - 1
  const typed = lines[last] ?? ''
  if (
    /^ {0,3}\|[ :|-]*$/.test(typed) &&
    tableRow.test(lines[last - 1] ?? '') &&
    !tableRow.test(lines[last - 2] ?? '')
  ) {
    const written = cells(typed)
    lines[last] =
      '|' +
      cells(lines[last - 1]!)
        .map((_, column) => (/^:?-+:?$/.test(written[column] ?? '') ? written[column] : '---'))
        .join('|') +
      '|'
  } else if (/^ {0,3}\|[^|]+\|/.test(typed) && !tableRow.test(lines[last - 1] ?? '')) {
    const header = typed.trimEnd().endsWith('|') ? typed : typed + '|'
    lines[last] =
      header +
      '\n|' +
      cells(header)
        .map(() => '---')
        .join('|') +
      '|'
  }
  return lines.join('\n')
}

const spacedLink = /(!?\[[^\]\n]*\]\()((?:workspace|sandbox):[^()<>\n]*?)(\s+"[^"\n]*")?\)/g

function spaced(text: string): string {
  return text.includes('workspace:') || text.includes('sandbox:')
    ? text.replace(
        spacedLink,
        (whole: string, open: string, destination: string, title: string | undefined) =>
          /\s/.test(destination) ? open + '<' + destination + '>' + (title ?? '') + ')' : whole,
      )
    : text
}

export default function Streamed(props: Markdown.Props) {
  const part = usePart()
  const render = useRef(props.code)
  render.current = props.code
  const links = useLinks()
  const popups = useMemo(() => new Set<string>(), [])
  const parts = useMemo(() => components(part, render, popups), [part, popups])
  const { className, ...attributes } = part('markdown', { live: props.live })
  return (
    <Streamdown
      {...attributes}
      className={typeof className === 'string' ? className : undefined}
      components={parts}
      controls={false}
      isAnimating={props.live ?? false}
      linkSafety={off}
      mode="streaming"
      parseIncompleteMarkdown
      rehypePlugins={rehype}
    >
      {mapped(spaced(props.live === false ? props.text : table(props.text)), links, popups)}
    </Streamdown>
  )
}

'use client'

import { type Components, toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import {
  createContext,
  isValidElement,
  type JSX,
  memo,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
} from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { harden } from 'rehype-harden'
import sanitize, { defaultSchema } from 'rehype-sanitize'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { type Processor, unified } from 'unified'
import * as Source from '../client/Markdown.ts'
import { Code } from './Code.tsx'
import { Image } from './Image.tsx'
import type { Markdown } from './Markdown.tsx'
import { useLinks, usePart } from './Provider.tsx'

type PartOf = ReturnType<typeof usePart>

type Hast = { type: string; tagName?: string; value?: string; children?: Hast[] }

type Mdast = { type: string; value?: string; children?: Mdast[] }

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

const flowParents = new Set(['blockquote', 'footnoteDefinition', 'listItem', 'root'])

const breakTag = /^<br\s*\/?>$/i

function literal() {
  const phrase = (value: string): Mdast[] =>
    value
      .split(/(<br\s*\/?>)/i)
      .filter(Boolean)
      .map((piece) => (breakTag.test(piece) ? { type: 'break' } : { type: 'text', value: piece }))
  const visit = (node: Mdast) => {
    if (!node.children) return
    node.children = node.children.flatMap((child) => {
      if (child.type !== 'html') {
        visit(child)
        return [child]
      }
      const children = phrase(child.value ?? '')
      return flowParents.has(node.type) ? [{ type: 'paragraph', children }] : children
    })
  }
  return (tree: Mdast) => visit(tree)
}

function flavored(this: Processor) {
  const data = this.data()
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), gfm()]
  data.fromMarkdownExtensions = [...(data.fromMarkdownExtensions ?? []), gfmFromMarkdown()]
}

const processor = unified()
  .use(remarkParse)
  .use(flavored)
  .use(literal)
  .use(remarkRehype)
  .use(sanitize, {
    ...defaultSchema,
    protocols: {
      ...defaultSchema.protocols,
      href: [...(defaultSchema.protocols?.href ?? []), 'nanocode'],
      src: [...(defaultSchema.protocols?.src ?? []), 'data', 'nanocode', 'workspace', 'sandbox'],
    },
  })
  .use(harden, {
    allowDataImages: true,
    allowedImagePrefixes: ['*'],
    allowedLinkPrefixes: ['*'],
    allowedProtocols: ['*'],
  })
  .use(trim)
  .freeze()

const Open = createContext(false)

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
  const incomplete = useContext(Open)
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
    code: (props: Props<'code'>) => <code {...part('inline')}>{props.children}</code>,
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
    li: (props: Props<'li'>) => <li {...part('item')}>{props.children}</li>,
    ol: (props: Props<'ol'>) => (
      <ol start={props.start} {...part('list', { ordered: true })}>
        {props.children}
      </ol>
    ),
    p: (props: Props<'p'>) => <p {...part('paragraph')}>{props.children}</p>,
    pre: (props: Props<'pre'>) => {
      const code = isValidElement<{ className?: string; children?: ReactNode }>(props.children)
        ? props.children.props
        : undefined
      const language = /language-(\S+)/.exec(code?.className ?? '')?.[1] ?? 'text'
      return (
        <Fence code={text(code?.children).replace(/\n$/, '')} language={language} render={render} />
      )
    },
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

const Block = memo(function Block(props: Block.Props) {
  const tree = processor.runSync(processor.parse(props.text), props.text)
  return (
    <Open.Provider value={props.open}>
      {toJsxRuntime(tree, {
        components: props.components,
        Fragment,
        jsx,
        jsxs,
        passKeys: true,
        passNode: true,
      })}
    </Open.Provider>
  )
})

declare namespace Block {
  type Props = { components: Components; open: boolean; text: string }
}

export default function Streamed(props: Markdown.Props) {
  const part = usePart()
  const render = useRef(props.code)
  render.current = props.code
  const links = useLinks()
  const popups = useMemo(() => new Set<string>(), [])
  const parts = useMemo(() => components(part, render, popups), [part, popups])
  const source = mapped(spaced(props.text), links, popups)
  const blocks = Source.blocks(props.live === false ? source : Source.complete(source))
  const last = blocks.length - 1
  return (
    <div {...part('markdown', { live: props.live })}>
      {blocks.map((block, index) => (
        <Block
          components={parts}
          key={index}
          open={props.live !== false && index === last && Source.fenced(block)}
          text={block}
        />
      ))}
    </div>
  )
}

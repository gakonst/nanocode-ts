export type Node = {
  checked?: boolean | undefined
  childNodes: ArrayLike<Node>
  getAttribute?(name: string): string | null
  nodeName: string
  nodeType: number
  textContent: string | null
}

const textNode = 3

const elementNode = 1

const fragmentNode = 11

const blockTags = new Set([
  'ARTICLE',
  'BLOCKQUOTE',
  'DIV',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'THEAD',
  'TR',
  'UL',
])

const skipped = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'SVG', 'TEMPLATE', 'VIDEO'])

const tag = (node: Node) => node.nodeName.toUpperCase()

const attr = (node: Node, name: string) => node.getAttribute?.(name) ?? null

const kids = (node: Node) => Array.from(node.childNodes)

const isBlock = (node: Node) => node.nodeType === elementNode && blockTags.has(tag(node))

export function markdown(root: Node): string {
  return blocks(kids(root), '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function blocks(nodes: readonly Node[], separator: string): string {
  const out: string[] = []
  let line = ''
  const flush = () => {
    const text = line.replace(/^ +| +$/gm, '')
    if (text.trim()) out.push(text.trim())
    line = ''
  }
  for (const node of nodes) {
    if (isBlock(node)) {
      flush()
      const text = block(node)
      if (text.trim()) out.push(text)
    } else line += inline(node)
  }
  flush()
  return out.join(separator)
}

function inline(node: Node): string {
  if (node.nodeType === textNode) return (node.textContent ?? '').replace(/\s+/g, ' ')
  if (node.nodeType !== elementNode && node.nodeType !== fragmentNode) return ''

  const name = tag(node)
  if (skipped.has(name) || attr(node, 'data-copy') !== null) return ''

  const inner = () =>
    kids(node)
      .map((child) => (isBlock(child) ? ' ' + block(child) + ' ' : inline(child)))
      .join('')
  switch (name) {
    case 'BR':
      return '\n'
    case 'STRONG':
    case 'B':
      return wrap('**', inner())
    case 'EM':
    case 'I':
      return wrap('*', inner())
    case 'DEL':
    case 'S':
      return wrap('~~', inner())
    case 'CODE':
      return codeSpan(node.textContent ?? '')
    case 'A':
      return link(attr(node, 'href'), inner())
    case 'IMG':
      return attr(node, 'data-shortcode') ?? ''
    case 'INPUT':
      return attr(node, 'type') === 'checkbox'
        ? (node.checked ?? attr(node, 'checked') !== null)
          ? '[x] '
          : '[ ] '
        : ''
    default:
      return inner()
  }
}

function wrap(mark: string, text: string): string {
  const [, before, body, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!
  return body ? before + mark + body + mark + after : text
}

function codeSpan(text: string): string {
  if (!text) return ''
  const fence = '`'.repeat(longestRun(text) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return fence + pad + text + pad + fence
}

const longestRun = (text: string) =>
  Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))

function link(href: string | null, text: string): string {
  const label = text.trim()
  if (!href || !/^(https?:|mailto:|\/(?!\/))/.test(href)) return text
  if (!label || label === href) return href
  return '[' + label + '](' + href + ')'
}

function block(node: Node): string {
  const name = tag(node)
  if (attr(node, 'data-copy') !== null) return ''
  if (/^H[1-6]$/.test(name)) {
    const level = Number(attr(node, 'data-markdown-level') ?? name[1])
    const text = kids(node).map(inline).join('').trim()
    return text && '#'.repeat(level) + ' ' + text
  }

  switch (name) {
    case 'PRE':
      return fenced(node)
    case 'UL':
    case 'OL':
      return list(node, name === 'OL')
    case 'LI':
      return item('- ', node)
    case 'BLOCKQUOTE':
      return blocks(kids(node), '\n\n')
        .split('\n')
        .map((line) => (line ? '> ' + line : '>'))
        .join('\n')
    case 'TABLE':
    case 'THEAD':
    case 'TBODY':
    case 'TR':
      return table(node)
    case 'HR':
      return '---'
    default:
      return blocks(kids(node), '\n\n')
  }
}

function fenced(pre: Node): string {
  const code = (pre.textContent ?? '').replace(/\n$/, '')
  const element = kids(pre).find((child) => child.nodeType === elementNode && tag(child) === 'CODE')
  const language =
    /(?:^|\s)language-(\S+)/.exec((element && attr(element, 'class')) ?? '')?.[1] ?? ''
  const fence = '`'.repeat(Math.max(3, longestRun(code) + 1))
  return fence + language + '\n' + code + '\n' + fence
}

function list(node: Node, ordered: boolean): string {
  const start = Number.parseInt(attr(node, 'start') ?? '1', 10) || 1
  return kids(node)
    .filter((child) => child.nodeType === elementNode && tag(child) === 'LI')
    .map((child, index) => item(ordered ? start + index + '. ' : '- ', child))
    .filter(Boolean)
    .join('\n')
}

function item(marker: string, node: Node): string {
  const text = blocks(kids(node), '\n')
  if (!text.trim()) return ''
  const indent = ' '.repeat(marker.length)
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? marker + line : line ? indent + line : ''))
    .join('\n')
}

function table(node: Node): string {
  const rows: Node[] = []
  const collect = (at: Node) => {
    for (const child of kids(at))
      if (child.nodeType === elementNode) {
        if (tag(child) === 'TR') rows.push(child)
        else if (!/^T[HD]$/.test(tag(child))) collect(child)
      }
  }
  if (tag(node) === 'TR') rows.push(node)
  else collect(node)

  const lines = rows
    .map((row) =>
      kids(row)
        .filter((cell) => cell.nodeType === elementNode && /^T[HD]$/.test(tag(cell)))
        .map((cell) => kids(cell).map(inline).join('').trim().replace(/\|/g, '\\|')),
    )
    .filter((cells) => cells.length)
    .map((cells) => '| ' + cells.join(' | ') + ' |')
  const head = lines[0]
  if (head === undefined) return ''
  const columns = head.split(' | ').length
  return [head, '|' + ' --- |'.repeat(columns), ...lines.slice(1)].join('\n')
}

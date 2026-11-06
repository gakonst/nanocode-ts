export type Edit = { caret: number; end?: number | undefined; text: string }

export type Code = {
  end: number
  kind: 'block' | 'fence' | 'inline' | 'rendered' | 'rendered-inline'
  start: number
}

export type Fence = {
  close: Range | null
  indent: string
  open: Range
}

export type Piece = { end: number; kind: 'break' | 'pill' | 'text' | Code['kind']; start: number }

export type Range = { end: number; start: number }

const opening = /^( {0,3})(`{3,})([^`]*)$/

const step = '  '

const opens = /[\s([{"'“‘]/

const closes = /[\s)\]}.,;:!?"'”’]/

export function isRendered(kind: string): boolean {
  return kind === 'rendered' || kind === 'rendered-inline'
}

function lineAt(text: string, at: number): Range {
  const start = text.lastIndexOf('\n', at - 1) + 1
  const newline = text.indexOf('\n', at)
  return { end: newline < 0 ? text.length : newline, start }
}

export function fences(text: string): readonly Fence[] {
  const found: Fence[] = []
  let open: { end: number; indent: string; start: number; ticks: number } | null = null
  let start = 0
  for (const line of text.split('\n')) {
    const end = start + line.length
    if (open) {
      const close = /^ {0,3}(`{3,}) *$/.exec(line)
      if (close && close[1]!.length >= open.ticks) {
        found.push({ close: { end, start }, indent: open.indent, open })
        open = null
      }
    } else {
      const match = opening.exec(line)
      if (match) open = { end, indent: match[1]!, start, ticks: match[2]!.length }
    }
    start = end + 1
  }
  if (open) found.push({ close: null, indent: open.indent, open })
  return found
}

function place(text: string, at: number) {
  for (const fence of fences(text)) {
    if (at < fence.open.start) break
    if (at <= fence.open.end) return { fence, on: 'open' as const }
    if (!fence.close || at < fence.close.start) return { fence, on: 'inside' as const }
    if (at <= fence.close.end) return { fence, on: 'close' as const }
  }
  return null
}

export function inCode(text: string, options: inCode.Options): boolean {
  return place(text, options.at) !== null
}

export declare namespace inCode {
  type Options = { at: number }
}

const replace = (
  text: string,
  from: number,
  to: number,
  insert: string,
  caret = from + insert.length,
): Edit => ({ caret, text: text.slice(0, from) + insert + text.slice(to) })

export function enter(text: string, options: enter.Options): Edit | null {
  const from = options.from
  const to = options.to
  const where = place(text, from)
  if (!where || where.on === 'close') return null

  const fence = where.fence
  if (where.on === 'open') {
    if (from < fence.open.start + fence.indent.length + 3) return null
    if (!fence.close && to === from && from === fence.open.end) {
      const line = '\n' + fence.indent
      const ticks = opening.exec(text.slice(fence.open.start, fence.open.end))![2]!
      return replace(text, from, to, line + line + ticks, from + line.length)
    }
    return replace(text, from, to, '\n' + fence.indent)
  }

  const start = lineAt(text, from).start
  const indent = /^[ \t]*/.exec(text.slice(start, from))![0]
  return replace(text, from, to, '\n' + indent)
}

export declare namespace enter {
  type Options = { from: number; to: number }
}

export function indent(text: string, options: indent.Options): Edit | null {
  const from = options.from
  const to = options.to
  const outdent = options.outdent
  const where = place(text, from)
  if (where?.on !== 'inside') return null
  if (!outdent && from === to) return replace(text, from, to, step)

  const first = lineAt(text, from)
  const last = lineAt(text, Math.max(from, to))
  const lines = text.slice(first.start, last.end).split('\n')
  let before = 0
  let total = 0
  const moved = lines.map((line, index) => {
    const by = outdent ? -Math.min(step.length, /^ */.exec(line)![0].length) : step.length
    if (index === 0) before = by
    total += by
    return by <= 0 ? line.slice(-by) : step + line
  })
  if (lines.every((line, index) => moved[index] === line)) return null

  return {
    caret: Math.max(first.start, from + before),
    end: Math.max(first.start, to + total),
    text: text.slice(0, first.start) + moved.join('\n') + text.slice(last.end),
  }
}

export declare namespace indent {
  type Options = { from: number; outdent: boolean; to: number }
}

function inSpan(text: string, at: number): boolean {
  const start = lineAt(text, at).start
  return (text.slice(start, at).match(/`/g)?.length ?? 0) % 2 === 1
}

export function backtick(text: string, options: backtick.Options): Edit | null {
  const from = options.from
  const to = options.to
  if (place(text, from) !== null || place(text, to) !== null) return null
  if (from !== to) {
    if (text.slice(from, to).includes('\n')) return null
    return {
      caret: from + 1,
      end: to + 1,
      text: text.slice(0, from) + '`' + text.slice(from, to) + '`' + text.slice(to),
    }
  }

  const next = text[from] ?? '\n'
  if (next === '`' && inSpan(text, from)) return { caret: from + 1, text }

  const start = lineAt(text, from).start
  if (!text.slice(start, from).trim()) return null
  if (!opens.test(text[from - 1]!) || !closes.test(next)) return null
  return replace(text, from, from, '``', from + 1)
}

export declare namespace backtick {
  type Options = { from: number; to: number }
}

export function deleteBackticks(text: string, options: deleteBackticks.Options): Edit | null {
  const caret = options.caret
  if (
    text[caret - 1] !== '`' ||
    text[caret] !== '`' ||
    text[caret - 2] === '`' ||
    text[caret + 1] === '`'
  )
    return null
  if (place(text, caret) !== null || !inSpan(text, caret)) return null
  return replace(text, caret - 1, caret + 1, '')
}

export declare namespace deleteBackticks {
  type Options = { caret: number }
}

export function codes(text: string, options: codes.Options = {}): readonly Code[] {
  const selection = options.selection ?? null
  const found: Code[] = []
  const away = (start: number, end: number) =>
    !selection || selection[0] > end || selection[1] < start
  const lines = (from: number, to: number, kind: Code['kind']) => {
    let start = from
    for (const line of text.slice(from, to).split('\n')) {
      if (line) found.push({ end: start + line.length, kind, start })
      start += line.length + 1
    }
  }
  const spans = (from: number, to: number) => {
    const runs = [...text.slice(from, to).matchAll(/`+/g)].map((match) => ({
      size: match[0].length,
      start: from + match.index,
    }))
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!
      const closeAt = runs.findIndex((other, j) => j > i && other.size === run.size)
      if (closeAt < 0) continue
      const close = runs[closeAt]!
      if (/\n[ \t]*\n/.test(text.slice(run.start, close.start))) continue
      const end = close.start + close.size
      if (end - run.start > 2 * run.size) {
        if (!text.slice(run.start, end).includes('\n') && away(run.start, end))
          found.push({ end, kind: 'rendered-inline', start: run.start })
        else lines(run.start, end, 'inline')
      }
      i = closeAt
    }
  }

  let at = 0
  for (const fence of fences(text)) {
    const open = fence.open
    const close = fence.close
    spans(at, open.start)
    if (close && away(open.start, close.end)) {
      found.push({ end: close.end, kind: 'rendered', start: open.start })
      at = close.end
      continue
    }
    lines(open.start, open.end, 'fence')
    const body = open.end + 1
    const end = close ? close.start - 1 : text.length
    if (body < end) lines(body, end, 'block')
    if (close) lines(close.start, close.end, 'fence')
    at = close ? close.end : text.length
  }
  spans(at, text.length)
  return found.sort((a, b) => a.start - b.start)
}

export declare namespace codes {
  type Options = { selection?: readonly [number, number] | null | undefined }
}

export function spanned(span: string): string {
  const ticks = /^`+/.exec(span)![0].length
  const code = span.slice(ticks, -ticks)
  return /^ .* $/.test(code) && code.trim() ? code.slice(1, -1) : code
}

export function fenced(block: string): fenced.ReturnType {
  const lines = block.split('\n')
  return {
    code: lines.slice(1, -1).join('\n'),
    lang: opening.exec(lines[0]!)?.[3]!.trim().split(/\s+/)[0]!.toLowerCase() ?? '',
  }
}

export declare namespace fenced {
  type ReturnType = { code: string; lang: string }
}

export function pieces(text: string, options: pieces.Options): readonly Piece[] {
  const found: Piece[] = []
  const kind = Array.from({ length: text.length }, (): Piece['kind'] => 'text')
  for (const span of options.code) for (let i = span.start; i < span.end; i++) kind[i] = span.kind
  const starts = new Set(
    options.code.filter((span) => isRendered(span.kind)).map((span) => span.start),
  )
  for (let i = 0; i < text.length; i++)
    if (text[i] === '\n' && !isRendered(kind[i]!)) kind[i] = 'break'

  const pilled = new Set<number>()
  for (const pill of options.pills) {
    if (isRendered(kind[pill.start]!)) continue
    for (let i = pill.start; i < pill.end; i++) kind[i] = 'pill'
    pilled.add(pill.start)
  }

  for (let i = 0; i < text.length; i++) {
    const last = found.at(-1)
    const current = kind[i]!
    if (
      last &&
      last.kind === current &&
      current !== 'break' &&
      !(current === 'pill' && pilled.has(i)) &&
      !starts.has(i)
    )
      last.end = i + 1
    else found.push({ end: i + 1, kind: current, start: i })
  }
  return found
}

export declare namespace pieces {
  type Options = { code: readonly Code[]; pills: readonly Range[] }
}

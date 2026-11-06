export const incompleteLink = 'nanocode:incomplete'

type Opener = { at: number; char: string; count: number }

const space = (c: string | undefined) => c === undefined || /\s/.test(c)

const punct = (c: string | undefined) => c !== undefined && /[\p{P}\p{S}]/u.test(c)

const word = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c)

const runLength = (text: string, at: number) => {
  let end = at
  while (text[end] === text[at]) end++
  return end - at
}

function fences(lines: readonly string[]): { code: readonly boolean[]; open: boolean } {
  const code: boolean[] = []
  let fence: string | null = null
  for (const line of lines) {
    const marker = /^[\s>]*(?:(?:[-*+]|\d+[.)])\s+)?(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      code.push(true)
      if (
        marker &&
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = null
    } else if (marker && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) {
      code.push(true)
      fence = marker[1]!
    } else code.push(false)
  }
  return { code, open: fence !== null }
}

const blockStart = /^\s*(?:[-*+](?:\s|$)|\d+[.)](?:\s|$)|#{1,6}(?:\s|$)|>|\|)/

const rule = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/

const closedLine = (line: string) => /^\s*(?:#{1,6}(?:\s|$)|\|)/.test(line) || rule.test(line)

export function complete(text: string): string {
  const rows = text.trimEnd().split('\n')
  if (fences(rows).open || /\n[ \t]*\n\s*$/.test(text)) return closeInline(text)

  const row = (line: string | undefined) => line !== undefined && /^\s*\|/.test(line)
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/(?<!\\)\|$/, '')
      .split(/(?<!\\)\|/)
  const valid = (cell: string) => /^\s*:?-+:?\s*$/.test(cell)
  const delimiter = (header: string, typed = '') => {
    const done = typed ? cells(typed) : []
    return `|${cells(header)
      .map((_, i) => {
        const cell = done[i]
        return ` ${cell && valid(cell) ? cell.trim() : '---'} |`
      })
      .join('')}`
  }

  const [header, last] = rows.slice(-2)
  if (rows.length > 1 && row(header) && !row(rows.at(-3)) && /^\s*\|[\s|:-]*$/.test(last!)) {
    const done = cells(last!).length === cells(header!).length && cells(last!).every(valid)
    return done ? text : [...rows.slice(0, -1), delimiter(header!, last)].join('\n')
  }
  if (row(last) && !row(rows.at(-2))) {
    if (!text.slice(rows.join('\n').length).includes('\n'))
      return closeInline(rows.slice(0, -1).join('\n'))
    return `${closeInline(text).trimEnd()}\n${delimiter(last!)}`
  }
  return closeInline(text)
}

function closeInline(text: string): string {
  let lines = text.split('\n')
  if (fences(lines).open) return text

  const last = lines.length - 1
  if (
    last > 0 &&
    /^ {0,3}(?:-{1,2}|={1,2})[ \t]*$/.test(lines[last]!) &&
    lines[last - 1]!.trim() &&
    !fences(lines.slice(0, last)).code[last - 1]
  ) {
    lines = lines.slice(0, last)
    text = lines.join('\n') + '\n'
  }

  const body = text.trimEnd()
  const tail = text.slice(body.length)
  if ((tail.match(/\n/g) ?? []).length > 1) return text

  lines = body.split('\n')
  const { code } = fences(lines)
  let first = lines.length - 1
  if (code[first] || rule.test(lines[first]!)) return text
  while (
    first > 0 &&
    !blockStart.test(lines[first]!) &&
    lines[first - 1]!.trim() &&
    !code[first - 1] &&
    !closedLine(lines[first - 1]!)
  )
    first--
  let from = lines.slice(0, first).reduce((sum, line) => sum + line.length + 1, 0)
  from += /^(?:\s*(?:>|[-*+](?=\s)|\d+[.)](?=\s)|#{1,6}(?=\s|$)))*\s*/.exec(lines[first]!)![0]
    .length
  if (/^\s*\|/.test(lines[first]!)) from = body.lastIndexOf('|') + 1

  const openers: Opener[] = []
  const brackets: number[] = []
  let codeAt = -1
  let destination = -1
  let destinationBracket = -1
  for (let i = from; i < body.length; ) {
    const ch = body[i]
    if (ch === '\\') {
      i += 2
      continue
    }

    if (ch === '`') {
      const n = runLength(body, i)
      let close = i + n
      while (close < body.length && (body[close] !== '`' || runLength(body, close) !== n))
        close += body[close] === '`' ? runLength(body, close) : 1
      if (close < body.length) {
        i = close + n
        continue
      }
      if (i + n < body.length) codeAt = i
      break
    }

    if (ch === '<') {
      const autolink = /^<[a-zA-Z][\w+.-]*:[^\s<>]*>/.exec(body.slice(i))
      if (autolink) {
        i += autolink[0].length
        continue
      }
    }

    if (
      (ch === 'h' || ch === 'w') &&
      /^(?:https?:\/\/|www\.)/.test(body.slice(i, i + 8)) &&
      !word(body[i - 1])
    ) {
      while (i < body.length && !space(body[i])) i++
      continue
    }

    if (ch === '[') {
      brackets.push(i)
      i++
      continue
    }

    if (ch === ']') {
      const open = brackets.pop()
      if (open !== undefined && i + 1 === body.length) {
        destination = i
        destinationBracket = open
        break
      }
      if (open === undefined || body[i + 1] !== '(') {
        i++
        continue
      }

      let end = i + 2
      for (let depth = 0; end < body.length && (body[end] !== ')' || depth > 0); end++) {
        if (body[end] === '\\') end++
        else if (body[end] === '(') depth++
        else if (body[end] === ')') depth--
      }
      if (end >= body.length) {
        destination = i
        destinationBracket = open
        break
      }

      while (openers.length && openers.at(-1)!.at > open) openers.pop()
      i = end + 1
      continue
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const n = runLength(body, i)
      const before = i > from ? body[i - 1] : ' '
      const after = body[i + n]
      const left = !space(after) && (!punct(after) || space(before) || punct(before))
      const right = !space(before) && (!punct(before) || space(after) || punct(after))
      const canOpen = ch === '_' ? left && (!right || punct(before)) : left
      const canClose = ch === '_' ? right && (!left || punct(after)) : right
      let rest = ch === '~' && n > 2 ? 0 : n
      for (let k = openers.length - 1; canClose && k >= 0 && rest > 0; k--) {
        const opener = openers[k]!
        if (
          opener.char !== ch ||
          (ch === '~' && opener.count !== rest && !(rest === 1 && i + n === body.length))
        )
          continue
        const used = Math.min(rest, opener.count)
        opener.count -= used
        rest -= used
        openers.length = opener.count ? k + 1 : k
      }

      if (
        rest > 0 &&
        canOpen &&
        (ch === '~' ? rest === 2 : ch === '_' || !(word(before) && word(after)))
      )
        openers.push({ at: i + n - rest, char: ch, count: rest })
      i += n
      continue
    }

    i++
  }

  const dangling = /(?:\*+|_+|~+|`+)$/.exec(body)
  if (
    dangling &&
    codeAt < 0 &&
    destination < 0 &&
    dangling.index >= from &&
    (dangling.index === from || /[\s([{]/.test(body[dangling.index - 1]!))
  )
    return closeInline(body.slice(0, dangling.index))

  const close = (list: Opener[]) =>
    list
      .reverse()
      .map((opener) => opener.char.repeat(opener.count))
      .join('')
  const split = (bracket: number) => [
    close(openers.filter((opener) => opener.at > bracket)),
    close(openers.filter((opener) => opener.at < bracket)),
  ]
  if (destination >= 0) {
    const [inner, outer] = split(destinationBracket)
    return `${body.slice(0, destination)}${inner}](${incompleteLink})${outer}${tail}`
  }

  let codeClose = ''
  if (codeAt >= 0) {
    const ticks = runLength(body, codeAt)
    const trailing = body.endsWith('`') ? body.length - body.search(/`+$/) : 0
    if (trailing >= ticks) return text
    codeClose = '`'.repeat(ticks - trailing)
  }

  const bracket = brackets.at(-1)
  if (bracket === undefined) return body + codeClose + close(openers) + tail
  const [inner, outer] = split(bracket)
  return `${body}${codeClose}${inner}](${incompleteLink})${outer}${tail}`
}

export function separateLists(text: string): string {
  const lines = text.split('\n')
  const { code } = fences(lines)
  let prose = false
  return lines
    .map((line, index) => {
      if (!line.trim() || code[index]) {
        prose = false
        return line
      }

      const item = /^ {0,3}\d{1,9}[.)][ \t]+\S/.test(line)
      const split = item && prose
      if (index === 0 || !lines[index - 1]!.trim() || code[index - 1] || split)
        prose = !item && !/^(?: {4}|\t| {0,3}(?:[>|]|[-*+](?:\s|$)))/.test(line)
      if (rule.test(line) || /^ {0,3}(?:=+|#{1,6}(?:\s|$))/.test(line)) prose = false
      return split ? '\n' + line : line
    })
    .join('\n')
}

export function blocks(text: string): readonly string[] {
  const lines = text.split('\n')
  if (lines.some((line) => /^ {0,3}\[[^\]]+\]:/.test(line))) return [text]

  const { code } = fences(lines)
  const found: string[][] = []
  let list = false
  lines.forEach((line, index) => {
    const item = /^(?:[-*+]|\d+[.)])(?:\s|$)/.test(line)
    if (
      index === 0 ||
      (!lines[index - 1]!.trim() && !code[index - 1] && /^\S/.test(line) && !(item && list))
    ) {
      found.push([])
      list = false
    }
    list ||= item
    found.at(-1)!.push(line)
  })
  return found.map((block) => block.join('\n'))
}

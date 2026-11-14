type Span = { from: number; to: number }

export function complete(reply: string, updates: readonly string[]): string {
  try {
    const calls = locate(reply, ['result', 'Ok', 'nested_calls'])
    if (!calls || reply[calls.from] !== '[') return reply

    const completed = new Map<string, string>()
    const started = new Map<string, string>()
    for (const frame of updates) {
      const update = locate(frame, ['update'])
      if (!update || frame[update.from] !== '{') continue

      const members = fields(frame, update.from)
      const done = members.get('completed')
      if (done) {
        const id = frame[done.from] === '{' ? fields(frame, done.from).get('call_id') : undefined
        if (id) completed.set(frame.slice(id.from, id.to), frame.slice(done.from, done.to))
        continue
      }

      const id = members.get('call_id')
      const input = members.get('input')
      if (id && input) started.set(frame.slice(id.from, id.to), frame.slice(input.from, input.to))
    }

    const expanded = items(reply, calls.from).map((span) => {
      const listed = reply.slice(span.from, span.to)
      if (listed[0] !== '{') return listed

      const id = fields(listed, 0).get('call_id')
      if (!id) return listed

      const key = listed.slice(id.from, id.to)
      const call = fields(listed, 0).has('delivered') ? completed.get(key) : listed
      if (call === undefined) return listed

      const input = started.get(key)
      return input === undefined || fields(call, 0).has('input')
        ? call
        : `{"input":${input},${call.slice(1)}`
    })

    return `${reply.slice(0, calls.from)}[${expanded.join(',')}]${reply.slice(calls.to)}`
  } catch {
    return reply
  }
}

function end(text: string, at: number): number {
  const first = text[at]
  if (first === '"') {
    let index = at + 1
    while (text[index] !== '"') {
      if (index >= text.length) throw new Error('unterminated string')
      index += text[index] === '\\' ? 2 : 1
    }
    return index + 1
  }

  if (first === '{' || first === '[') {
    let depth = 0
    for (let index = at; index < text.length; index++) {
      const character = text[index]
      if (character === '"') index = end(text, index) - 1
      else if (character === '{' || character === '[') depth++
      else if ((character === '}' || character === ']') && --depth === 0) return index + 1
    }
    throw new Error('unterminated value')
  }

  let index = at
  while (index < text.length && !',}]'.includes(text[index]!)) index++
  return index
}

function fields(text: string, at: number): Map<string, Span> {
  const found = new Map<string, Span>()
  let index = at + 1
  while (text[index] !== '}') {
    const key = end(text, index)
    if (text[index] !== '"' || text[key] !== ':') throw new Error('malformed object')

    const to = end(text, key + 1)
    found.set(JSON.parse(text.slice(index, key)) as string, { from: key + 1, to })
    index = text[to] === ',' ? to + 1 : to
  }
  return found
}

function items(text: string, at: number): Span[] {
  const found: Span[] = []
  let index = at + 1
  while (text[index] !== ']') {
    const to = end(text, index)
    if (to === index) throw new Error('malformed array')

    found.push({ from: index, to })
    index = text[to] === ',' ? to + 1 : to
  }
  return found
}

function locate(text: string, path: readonly string[]): Span | undefined {
  let span: Span = { from: 0, to: text.length }
  for (const key of path) {
    if (text[span.from] !== '{') return undefined

    const next = fields(text, span.from).get(key)
    if (!next) return undefined
    span = next
  }
  return span
}

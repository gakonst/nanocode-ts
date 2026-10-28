/**
 * Streaming reader of a tool call's JSON arguments, which reads top-level string fields before the
 * object closes.
 *
 * @module
 */

/** Reader of one tool call's streamed arguments. */
export type ToolInput = {
  /** Top-level string fields read so far. */
  readonly fields: Map<string, string>
  /** Arguments text received so far. */
  readonly raw: string
  /** Returns the fields as an object, or the raw text when the arguments are not an object. */
  arguments(): unknown
  /** Reads the next delta of the arguments text. */
  push(delta: string): void
  /** Returns the fields as display text, or the raw text when no field was read. */
  text(): string
}

const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

const special = /["\\]/g

/** Creates a reader with no arguments text. */
export function create(): ToolInput {
  const fields = new Map<string, string>()
  let depth = 0
  let expectingKey = true
  let key: string | undefined
  let object: boolean | undefined
  let pending = ''
  let raw = ''
  let role: 'key' | 'value' | 'other' | undefined
  let value = ''

  return {
    fields,
    get raw() {
      return raw
    },
    arguments() {
      return object ? Object.fromEntries(fields) : raw
    },
    push(delta) {
      raw += delta
      const text = pending + delta
      pending = ''
      let index = 0
      if (object === undefined) {
        const start = text.search(/\S/)
        if (start < 0) return
        object = text[start] === '{'
        index = start + 1
      }
      if (!object) return
      while (index < text.length) {
        if (role === undefined) {
          const char = text[index++]
          if (char === '"') {
            role =
              depth > 0 ? 'other' : expectingKey ? 'key' : key === undefined ? 'other' : 'value'
            value = ''
          } else if (depth === 0 && char === ':') expectingKey = false
          else if (depth === 0 && char === ',') {
            expectingKey = true
            key = undefined
          } else if (char === '{' || char === '[') depth++
          else if (char === '}' || char === ']') depth--
          continue
        }
        special.lastIndex = index
        const found = special.exec(text)
        const end = found ? found.index : text.length
        value += text.slice(index, end)
        if (!found) break
        if (text[end] === '"') {
          if (role === 'key') key = value
          else if (role === 'value' && key !== undefined) {
            fields.set(key, value)
            key = undefined
          }
          role = undefined
          value = ''
          index = end + 1
          continue
        }
        const escape = text[end + 1]
        if (escape === undefined || (escape === 'u' && end + 6 > text.length)) {
          pending = text.slice(end)
          break
        }
        if (escape === 'u') {
          value += String.fromCharCode(Number.parseInt(text.slice(end + 2, end + 6), 16))
          index = end + 6
        } else {
          value += escapes[escape] ?? escape
          index = end + 2
        }
      }
      if (role === 'value' && key !== undefined) fields.set(key, value)
    },
    text() {
      if (!fields.size) return raw
      if (fields.size === 1) return [...fields.values()][0]!
      return [...fields].map(([key, value]) => `${key}: ${value}`).join('\n')
    },
  }
}

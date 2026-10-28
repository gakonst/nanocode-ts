const ansi = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\^_])/g

export function bytes(size: number): string {
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return Math.round(size / 1024) + ' KB'
  return (size / 1024 / 1024).toFixed(1) + ' MB'
}

export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return value
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return value
  }
}

export function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`
  if (milliseconds < 60_000)
    return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(milliseconds / 60_000)
  return `${minutes}m ${Math.round((milliseconds - minutes * 60_000) / 1000)}s`
}

export function paragraphs(text: string, options: paragraphs.Options): paragraphs.ReturnType {
  const { final = false, from } = options
  const chunks: string[] = []
  let start = from
  let fenced = (text.slice(0, from).match(/^```/gm)?.length ?? 0) % 2 === 1
  let index = from
  while (index < text.length) {
    const line = text.indexOf('\n', index)
    if (line === -1) break
    if (text.startsWith('```', index)) fenced = !fenced
    if (!fenced && text.startsWith('\n', line + 1)) {
      const chunk = text.slice(start, line).trim()
      if (chunk) chunks.push(chunk)
      start = line + 2
    }
    index = line + 1
  }
  if (!final) return { chunks, next: start }
  const rest = text.slice(start).trim()
  if (rest) chunks.push(rest)
  return { chunks, next: text.length }
}

export declare namespace paragraphs {
  type Options = {
    final?: boolean | undefined
    from: number
  }

  type ReturnType = {
    chunks: string[]
    next: number
  }
}

export function plain(text: string): string {
  return text.includes('\u001b') ? text.replace(ansi, '') : text
}

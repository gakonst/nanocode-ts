export type Line =
  | { after: number; before: number; kind: 'same'; text: string }
  | { before: number; kind: 'removed'; text: string }
  | { after: number; kind: 'added'; text: string }

export type Skip = { count: number; kind: 'skip'; lines: readonly Line[] }

const split = (source: string) =>
  source === '' ? [] : source.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')

export function lines(options: lines.Options): readonly Line[] {
  const a = split(options.before ?? '')
  const b = split(options.after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++

  const out: Line[] = []
  for (let i = 0; i < head; i++)
    out.push({ after: i + 1, before: i + 1, kind: 'same', text: a[i]! })

  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const n = x.length
  const m = y.length
  if (options.maxCells !== undefined && n * m > options.maxCells) {
    x.forEach((text, i) => out.push({ before: head + i + 1, kind: 'removed', text }))
    y.forEach((text, j) => out.push({ after: head + j + 1, kind: 'added', text }))
  } else {
    const lcs = new Uint32Array((n + 1) * (m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] =
          x[i] === y[j]
            ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
            : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!)
      }
    }

    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) {
        out.push({ after: head + j + 1, before: head + i + 1, kind: 'same', text: x[i]! })
        i++
        j++
      } else if (i < n && (j === m || lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) {
        out.push({ before: head + i + 1, kind: 'removed', text: x[i]! })
        i++
      } else {
        out.push({ after: head + j + 1, kind: 'added', text: y[j]! })
        j++
      }
    }
  }

  for (let k = tail; k > 0; k--)
    out.push({
      after: b.length - k + 1,
      before: a.length - k + 1,
      kind: 'same',
      text: a[a.length - k]!,
    })
  return out
}

export declare namespace lines {
  type Options = {
    after: string
    before?: string | null | undefined
    maxCells?: number | undefined
  }
}

export function collapse(
  lines: readonly Line[],
  options: collapse.Options,
): readonly (Line | Skip)[] {
  const out: (Line | Skip)[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.kind !== 'same') {
      out.push(line)
      i++
      continue
    }

    let end = i
    while (end < lines.length && lines[end]!.kind === 'same') end++
    const keepStart = i === 0 ? 0 : options.context
    const keepEnd = end === lines.length ? 0 : options.context
    const hidden = end - i - keepStart - keepEnd
    if (hidden >= options.minimum) {
      out.push(...lines.slice(i, i + keepStart))
      out.push({ count: hidden, kind: 'skip', lines: lines.slice(i + keepStart, end - keepEnd) })
      out.push(...lines.slice(end - keepEnd, end))
    } else out.push(...lines.slice(i, end))
    i = end
  }
  return out
}

export declare namespace collapse {
  type Options = {
    context: number
    minimum: number
  }
}

export function stats(lines: readonly Line[]): stats.ReturnType {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'added') added++
    else if (line.kind === 'removed') removed++
  }
  return { added, removed }
}

export declare namespace stats {
  type ReturnType = { added: number; removed: number }
}

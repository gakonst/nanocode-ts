export type Token = {
  color?: string | undefined
  content: string
  fontStyle?: number | undefined
}

const property = (color: string) => /^var\((--[\w-]+)/.exec(color)?.[1] ?? color

export function runs(line: readonly Token[], options: runs.Options = {}): readonly Token[] {
  const palette = options.palette
  const out: { color?: string; content: string; fontStyle?: number; key: unknown }[] = []
  for (const token of line) {
    const shown =
      token.color && (!palette || palette[property(token.color)] !== undefined)
        ? token.color
        : undefined
    const key = shown && palette ? palette[property(shown)] : shown
    const last = out.at(-1)
    if (
      last &&
      (!token.content.trim() ||
        (last.key === key && (last.fontStyle ?? 0) === (token.fontStyle ?? 0)))
    ) {
      last.content += token.content
      continue
    }
    out.push({
      content: token.content,
      key,
      ...(shown ? { color: shown } : {}),
      ...(shown && token.fontStyle ? { fontStyle: token.fontStyle } : {}),
    })
  }
  return out.map((run) => {
    const { key: _, ...token } = run
    return token
  })
}

export declare namespace runs {
  type Options = { palette?: Readonly<Record<string, unknown>> | undefined }
}

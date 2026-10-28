export type File = {
  data: string
  path: string
}

const close = '</nanocode-attachments>'

const open = '\n\n<nanocode-attachments>'

export const path = /^\/workspace\/uploads\/[\w.-]{1,100}$/

export function carry(text: string, files: readonly File[]): string {
  return files.length ? text + open + JSON.stringify(files) + close : text
}

export function parse(text: string): {
  text: string
  files: { path: string; bytes: Uint8Array }[]
} {
  const start = text.lastIndexOf(open)
  if (start < 0 || !text.endsWith(close)) return { text, files: [] }

  let carried: unknown
  try {
    carried = JSON.parse(text.slice(start + open.length, -close.length))
  } catch {
    return { text, files: [] }
  }

  const files = (Array.isArray(carried) ? carried : []).flatMap((item) => {
    const file = item as Partial<File>
    if (typeof file?.path !== 'string' || !path.test(file.path) || typeof file.data !== 'string')
      return []
    try {
      return [
        { path: file.path, bytes: Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0)) },
      ]
    } catch {
      return []
    }
  })

  return { text: text.slice(0, start), files: files.slice(0, 8) }
}

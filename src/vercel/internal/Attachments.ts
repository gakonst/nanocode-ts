/**
 * Attachments that a prompt carries to the Function as base64 files at the end of its text.
 *
 * @module
 */

/** File that a prompt carries. */
export type File = {
  /** Base64 contents. */
  data: string
  /** Workspace path under `/workspace/uploads/`. */
  path: string
}

// The markers are durable: Workflow replays parse prompts that carry them.
const close = '</nanocode-attachments>'

const open = '\n\n<nanocode-attachments>'

/** Pattern of an attachment's workspace path. */
export const path = /^\/workspace\/uploads\/[\w.-]{1,100}$/

/** Appends `files` to a prompt's text, and returns the text alone when there are none. */
export function carry(text: string, files: readonly File[]): string {
  return files.length ? text + open + JSON.stringify(files) + close : text
}

/** Splits the carried files from a prompt's text, and decodes at most eight valid ones. */
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

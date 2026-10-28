/**
 * Workspace paths of the browser client: links and image sources that name a file in the session's
 * workspace.
 *
 * @module
 */

/** Returns the workspace path that `src` names, or `undefined` when it names none or escapes the root. */
export function path(src: unknown, options: path.Options = {}): string | undefined {
  const { root = '/workspace' } = options
  if (typeof src !== 'string') return undefined
  const value = src.trim()
  const scheme =
    /^(?:workspace|sandbox):(?:\/\/)?(.*)$/i.exec(value) ?? /^file:\/\/(\/.*)$/i.exec(value)
  const found = scheme ? scheme[1]! : value.startsWith(root + '/') ? value : undefined
  if (found === undefined) return undefined
  const raw = (() => {
    try {
      return decodeURIComponent(found)
    } catch {
      return found
    }
  })()
  const absolute = raw.startsWith('/') ? raw : '/' + raw
  const resolved = absolute === root || absolute.startsWith(root + '/') ? absolute : root + absolute
  return resolved.split('/').includes('..') ? undefined : resolved.split(/[?#]/)[0]
}

export declare namespace path {
  type Options = {
    /** Workspace root. Defaults to `/workspace`. */
    root?: string | undefined
  }
}

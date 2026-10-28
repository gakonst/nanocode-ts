/**
 * Hand relays: the socket address and token that connect a hand to a session, and the commands that
 * start one.
 *
 * @module
 */

/** Socket address and token of a hand relay. */
export type Access = {
  /** WebSocket URL of the relay. */
  url: string
  /** Token that the hand presents. */
  token: string
}

/** Source of hand access and of the hands that a relay holds. */
export type Source = {
  /** Returns the access for a new hand, or `undefined` when the session has none. */
  hand(): Promise<Access | undefined>
  /** Returns the names of the connected hands. `null` is a hand that sent no name. */
  hands(): Promise<readonly (string | null)[]>
}

/** URL of the install script of the `nc` command. */
export const installUrl = 'https://nanocode.xyz/install'

/** Returns the shell commands that connect a hand: one with the install, and one without. */
export function commands(access: Access, options: commands.Options = {}): commands.ReturnType {
  const { install = installUrl } = options
  return {
    command: `curl -fsSL ${install} | sh -s -- hand '${access.url}' --token ${access.token}`,
    short: `nc hand '${access.url}' --token ${access.token}`,
  }
}

export declare namespace commands {
  type Options = {
    /** URL of the install script. Defaults to `installUrl`. */
    install?: string | undefined
  }

  type ReturnType = {
    /** Command that installs `nc` and connects the hand. */
    command: string
    /** Command that connects the hand with an installed `nc`. */
    short: string
  }
}

/** Returns a random relay token of 32 hexadecimal characters. */
export function createToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/** Returns the WebSocket URL of `path`, resolved against `options.base` or the page's URL. */
export function socketUrl(path: string, options: socketUrl.Options = {}): string {
  const { base = page() } = options
  return new URL(path, base).href.replace(/^http/, 'ws')
}

export declare namespace socketUrl {
  type Options = {
    /** Base URL. Defaults to the page's URL. */
    base?: string | undefined
  }
}

/** Returns a source whose hands connect to the relay at `options.url` with `options.token`. */
export function source(options: source.Options): Source {
  const { token, url } = options
  const http = new URL(url, page()).href.replace(/^ws/, 'http')
  return {
    hand: async () => ({ url: socketUrl(url), token: token() }),
    hands: async () => {
      const response = await fetch(
        `${http}${http.includes('?') ? '&' : '?'}token=${encodeURIComponent(token())}`,
        { cache: 'no-store' },
      ).catch(() => undefined)
      if (!response?.ok) return []
      return ((await response.json()) as { hands?: (string | null)[] }).hands ?? []
    },
  }
}

export declare namespace source {
  type Options = {
    /** Returns the current relay token. */
    token: () => string
    /** URL of the relay. */
    url: string
  }
}

function page() {
  return (globalThis as { location?: { href: string } }).location?.href
}

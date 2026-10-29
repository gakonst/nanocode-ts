export type Access = {
  url: string
  token: string
}

export type Source = {
  hand(): Promise<Access | undefined>
  hands(): Promise<readonly (string | null)[]>
  listing?(): Promise<Listing>
}

export type Listing = {
  hands: readonly (string | null)[]
  toolsOnly: readonly (string | null)[]
}

export function listing(body: {
  hands?: readonly (string | null)[] | undefined
  tools_only?: readonly (string | null)[] | undefined
}): Listing {
  return { hands: body.hands ?? [], toolsOnly: body.tools_only ?? [] }
}

export function where(listing: Listing): string {
  const named = (name: string | null) => name ?? 'your machine'
  const scripts = listing.hands.filter((name) => !listing.toolsOnly.includes(name)).map(named)
  const tools = listing.toolsOnly.filter((name) => listing.hands.includes(name)).map(named)
  return [
    scripts.length ? `on ${scripts.join(', ')}` : '',
    tools.length ? `tools from ${tools.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

export const installUrl = 'https://nanocode.xyz/install'

export const tabUrl = 'https://nanocode.xyz/hand'

export function commands(access: Access, options: commands.Options = {}): commands.ReturnType {
  const { install = installUrl, tab = tabUrl } = options
  return {
    command: `curl -fsSL ${install} | sh -s -- hand '${access.url}' --token ${access.token}`,
    short: `nc hand '${access.url}' --token ${access.token}`,
    ...(tab
      ? { tab: `${tab}#${new URLSearchParams({ url: access.url, token: access.token })}` }
      : {}),
  }
}

export declare namespace commands {
  type Options = {
    install?: string | undefined
    tab?: string | false | undefined
  }

  type ReturnType = {
    command: string
    short: string
    tab?: string
  }
}

export function createToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export function socketUrl(path: string, options: socketUrl.Options = {}): string {
  const { base = page() } = options
  return new URL(path, base).href.replace(/^http/, 'ws')
}

export declare namespace socketUrl {
  type Options = {
    base?: string | undefined
  }
}

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
    token: () => string
    url: string
  }
}

function page() {
  return (globalThis as { location?: { href: string } }).location?.href
}

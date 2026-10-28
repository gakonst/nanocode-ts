export type Resolve = (host: string, signal?: AbortSignal) => Promise<readonly string[]>

export type GuardOptions = { resolve?: Resolve; redirects?: number }

const LOCAL_NAME =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa|in-addr\.arpa|ip6\.arpa)$/
const REDIRECT = new Set([301, 302, 303, 307, 308])
const GUARDED = Symbol.for('nanocode-ts.egress')
const DOH = 'https://cloudflare-dns.com/dns-query'
const CACHE_LIMIT = 1024

export function ipv4(text: string): number[] | undefined {
  const parts = text.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return undefined
  return parts.map(Number)
}

export function ipv6(text: string): number[] | undefined {
  let host = text
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase()
  const tail: number[] = []
  const dotted = host.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const four = ipv4(dotted[2]!)
    if (!four) return undefined
    tail.push((four[0]! << 8) | four[1]!, (four[2]! << 8) | four[3]!)
    host = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1)
  }
  if (!/^[0-9a-f:]*$/.test(host) || host.split('::').length > 2) return undefined
  const parse = (side: string) =>
    side === ''
      ? []
      : side.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN))
  const [left = '', right] = host.split('::')
  const head = parse(left)
  const rest = right === undefined ? [] : parse(right)
  const total = head.length + rest.length + tail.length
  if ([...head, ...rest].some(Number.isNaN)) return undefined
  if (right === undefined ? total !== 8 : total > 7) return undefined
  return [...head, ...new Array<number>(8 - total).fill(0), ...rest, ...tail]
}

function publicIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function embedded(high: number, low: number): number[] {
  return [high >> 8, high & 255, low >> 8, low & 255]
}

function publicIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff))
    return g5 === 0xffff && publicIpv4(embedded(g6, g7))
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return false
  if (g0 === 0x64 && g1 === 0xff9b)
    return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && publicIpv4(embedded(g6, g7))
  if (g0 === 0x2002) return publicIpv4(embedded(g1, g2))
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8 || (g1 >= 0x10 && g1 <= 0x2f))) return false
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return false
  if (
    (g0 & 0xfe00) === 0xfc00 ||
    (g0 & 0xffc0) === 0xfe80 ||
    (g0 & 0xffc0) === 0xfec0 ||
    (g0 & 0xff00) === 0xff00
  )
    return false
  return true
}

export function publicAddress(address: string): boolean {
  const four = ipv4(address)
  if (four) return publicIpv4(four)
  const six = ipv6(address)
  return six ? publicIpv6(six) : false
}

function hostOf(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
}

function literal(host: string): boolean {
  return ipv4(host) !== undefined || (host.includes(':') && ipv6(host) !== undefined)
}

export function publicTarget(target: string): boolean {
  return refusal(target) === undefined
}

function refusal(target: string): string | undefined {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return 'fetch refused: ' + target + ' is not a URL'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return 'fetch refused: ' + url.protocol + ' URLs are not allowed, only http(s)'
  const host = hostOf(url)
  if (!host) return 'fetch refused: ' + target + ' names no host'
  if (literal(host))
    return publicAddress(host) ? undefined : 'fetch refused: ' + host + ' is not a public address'
  if (/^[\d.]+$/.test(host)) return 'fetch refused: ' + host + ' is not a valid public address'
  if (!host.includes('.') || LOCAL_NAME.test(host))
    return 'fetch refused: ' + host + ' is a local name'
  return undefined
}

export async function check(
  target: string,
  resolve: Resolve = doh(),
  signal?: AbortSignal,
): Promise<string | undefined> {
  const refused = refusal(target)
  if (refused) return refused
  const host = hostOf(new URL(target))
  if (literal(host)) return undefined
  let addresses: readonly string[]
  try {
    addresses = await resolve(host, signal)
  } catch (error) {
    return (
      'fetch refused: could not resolve ' +
      host +
      ': ' +
      (error instanceof Error ? error.message : String(error))
    )
  }
  if (!addresses.length) return 'fetch refused: ' + host + ' does not resolve'
  const bad = addresses.find((address) => !publicAddress(address))
  return bad === undefined
    ? undefined
    : 'fetch refused: ' + host + ' resolves to ' + bad + ', which is not a public address'
}

export function refused(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  })
}

const answers = new Map<string, { until: number; addresses: readonly string[] }>()

export function doh(
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  endpoint = DOH,
): Resolve {
  return async (host, signal) => {
    const key = endpoint + ' ' + host
    const hit = answers.get(key)
    if (hit && hit.until > Date.now()) return hit.addresses
    const records = await Promise.all(
      ['A', 'AAAA'].map(async (type) => {
        const response = await fetcher(
          endpoint + '?name=' + encodeURIComponent(host) + '&type=' + type,
          { headers: { accept: 'application/dns-json' }, ...(signal ? { signal } : {}) },
        )
        if (!response.ok) throw new Error('DNS over HTTPS answered ' + response.status)
        const body = (await response.json()) as {
          Status?: number
          Answer?: { type?: number; data?: string; TTL?: number }[]
        }
        if (body.Status !== 0 && body.Status !== 3)
          throw new Error('DNS over HTTPS status ' + body.Status)
        return body.Answer ?? []
      }),
    )
    const found = records
      .flat()
      .filter(
        (answer) => (answer.type === 1 || answer.type === 28) && typeof answer.data === 'string',
      )
    const addresses = found.map((answer) => answer.data!)
    const ttl = Math.max(5, Math.min(300, ...found.map((answer) => answer.TTL ?? 5)))
    if (answers.size >= CACHE_LIMIT) answers.clear()
    answers.set(key, { until: Date.now() + ttl * 1000, addresses })
    return addresses
  }
}

export function guarded(fetcher: typeof fetch): boolean {
  return (fetcher as unknown as Record<symbol, unknown>)[GUARDED] === true
}

export function mark<F extends typeof fetch>(fetcher: F): F {
  Object.defineProperty(fetcher, GUARDED, { value: true })
  return fetcher
}

export function guard(fetcher: typeof fetch, options: GuardOptions = {}): typeof fetch {
  if (guarded(fetcher)) return fetcher
  const resolve = options.resolve ?? doh()
  const limit = options.redirects ?? 20
  return mark(async (input, init) => {
    const request = new Request(input, init)
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow')
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined
    let url = request.url
    let method = request.method
    let body: ArrayBuffer | undefined =
      method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer()
    const headers = new Headers(request.headers)
    const rest: RequestInit = { ...init }
    for (let hop = 0; ; hop++) {
      const message = await check(url, resolve, signal ?? undefined)
      if (message) return refused(message)
      const response = await fetcher(url, {
        ...rest,
        method,
        headers,
        body: body ?? null,
        redirect: 'manual',
        ...(signal ? { signal } : {}),
      })
      const location = response.headers.get('location')
      if (mode === 'manual' || !REDIRECT.has(response.status) || location === null) return response
      await response.body?.cancel().catch(() => undefined)
      if (mode === 'error')
        throw new TypeError('fetch failed: ' + url + ' redirected and redirect is error')
      if (hop >= limit)
        throw new TypeError('fetch failed: more than ' + limit + ' redirects from ' + request.url)
      const next = new URL(location, url)
      if (
        response.status === 303
          ? method !== 'HEAD'
          : (response.status === 301 || response.status === 302) && method === 'POST'
      ) {
        method = 'GET'
        body = undefined
        for (const name of [
          'content-type',
          'content-length',
          'content-encoding',
          'content-language',
          'content-location',
        ])
          headers.delete(name)
      }
      if (next.origin !== new URL(url).origin)
        for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name)
      url = next.href
    }
  })
}

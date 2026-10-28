import * as Egress from '../internal/Egress.ts'

export type Options = {
  archive?(owner: string, repo: string, ref: string): string
  details?: boolean
  maxBytes?: number
  maxDownloadBytes?: number
  maxFileBytes?: number
  maxFiles?: number
  stallMs?: number
  token?: Token
}

export type Token = string | (() => string | null | undefined | Promise<string | null | undefined>)

export type FetchOptions = {
  token?: Token | undefined
}

export function codeload(options: codeload.Options): string {
  return (
    'https://codeload.github.com/' +
    options.owner +
    '/' +
    options.repo +
    '/tar.gz/' +
    options.ref.split('/').map(encodeURIComponent).join('/')
  )
}

export declare namespace codeload {
  type Options = {
    owner: string
    ref: string
    repo: string
  }
}

const allowed = [
  /^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/(?:tar\.gz|legacy\.tar\.gz|zip|legacy\.zip)\//,
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:archive|releases\/download|raw)\//,
  /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\//,
  /^https:\/\/(?:objects|release-assets)\.githubusercontent\.com\//,
  /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+(?:\/(?:tarball|zipball|commits|releases|contents)(?:\/[^?#]*)?)?(?:\?[^#]*)?$/,
]

const apiHost = 'api.github.com'

const limitedHeader = 'x-nanocode-github'

const rateLimitHint =
  'api.github.com rate limits unauthenticated requests per address (60 an hour), and this host shares its address with others. Read files from https://raw.githubusercontent.com/OWNER/REPO/REF/PATH, download archives from https://codeload.github.com/OWNER/REPO/tar.gz/REF, or run git clone, none of which use the apiHost; the host can also set a GitHub token (its github.token option).'

async function tokenOf(token: Token | undefined): Promise<string | undefined> {
  const value = typeof token === 'function' ? await token() : token
  return value ? value : undefined
}

async function rateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) return true
  if (response.status !== 403) return false
  if (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))
    return true
  const text = await response
    .clone()
    .text()
    .catch(() => '')
  return /rate limit/i.test(text)
}

async function head(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < limit) {
      const next = await reader.read()
      if (next.done) break
      text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      [limitedHeader]: 'fallback',
      ...init.headers,
    },
  })
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

async function defaultBranch(
  fetcher: typeof fetch,
  repository: string,
  signal: AbortSignal | null,
): Promise<{ branch: string | null; commit: string | null } | null> {
  const response = await fetcher(
    'https://github.com/' + repository + '.git/info/refs?service=git-upload-pack',
    { headers: { 'user-agent': 'git/2.47.0' }, redirect: 'follow', ...(signal ? { signal } : {}) },
  )
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  const text = await head(response, 16384)
  const branch = /symref=HEAD:refs\/heads\/([^\s\0]+)/.exec(text)?.[1] ?? null
  const commit = /0000[0-9a-f]{4}([0-9a-f]{40}) HEAD\0/.exec(text)?.[1] ?? null
  return branch || commit ? { branch, commit } : null
}

async function commitOf(
  fetcher: typeof fetch,
  repository: string,
  ref: string,
  signal: AbortSignal | null,
): Promise<Record<string, unknown> | null> {
  const response = await fetcher(
    'https://github.com/' +
      repository +
      '/commit/' +
      ref.split('/').map(encodeURIComponent).join('/') +
      '.patch',
    { headers: { 'user-agent': 'nanocode-ts' }, redirect: 'follow', ...(signal ? { signal } : {}) },
  )
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  const text = await head(response, 65536)
  const sha = /^From ([0-9a-f]{40}) /.exec(text)?.[1]
  if (!sha) return null
  const end = text.indexOf('\n\n')
  const headers = (end < 0 ? text : text.slice(0, end)).replace(/\n[ \t]+/g, ' ')
  const field = (name: string) => new RegExp('^' + name + ': (.*)$', 'm').exec(headers)?.[1] ?? null
  const from = field('From')
  const person = from ? /^(.*?)\s*<([^>]*)>$/.exec(from) : null
  const date = field('Date')
  const subject = (field('Subject') ?? '').replace(/^\[PATCH[^\]]*\]\s*/, '')
  const rest = end < 0 ? '' : text.slice(end + 2)
  const cut = rest.search(/^---$/m)
  const body = (cut < 0 ? '' : rest.slice(0, cut)).trim()
  const author = {
    name: person?.[1]?.replace(/^"|"$/g, '') ?? from,
    email: person?.[2] ?? null,
    date: date ? new Date(date).toISOString() : null,
  }
  return {
    sha,
    html_url: 'https://github.com/' + repository + '/commit/' + sha,
    commit: { author, committer: author, message: body ? subject + '\n\n' + body : subject },
  }
}

async function fallback(fetcher: typeof fetch, request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname)
  if (!match) return null
  const repository = match[1] + '/' + match[2]
  const rest = match[3] ?? ''
  const signal = request.signal
  const note = 'api.github.com rate limited this request; this answer comes from '
  const archive = /^\/(tarball|zipball)(?:\/(.+))?$/.exec(rest)
  if (archive) {
    const response = await fetcher(
      'https://codeload.github.com/' +
        repository +
        '/' +
        (archive[1] === 'tarball' ? 'tar.gz' : 'zip') +
        '/' +
        (archive[2] ?? 'HEAD'),
      {
        method: request.method,
        headers: { 'user-agent': 'nanocode-ts' },
        redirect: 'follow',
        signal,
      },
    )
    return response.ok ? response : null
  }
  if (rest === '/releases/latest') {
    const response = await fetcher('https://github.com/' + repository + '/releases/latest', {
      method: 'HEAD',
      headers: { 'user-agent': 'nanocode-ts' },
      redirect: 'manual',
      signal,
    })
    await response.body?.cancel().catch(() => undefined)
    const location = response.headers.get('location') ?? ''
    const tag = /\/releases\/tag\/([^?#]+)$/.exec(location)?.[1]
    if (!tag) return null
    const name = decodeURIComponent(tag)
    return json({
      tag_name: name,
      name,
      html_url: new URL(location, 'https://github.com/').href,
      tarball_url: 'https://codeload.github.com/' + repository + '/tar.gz/refs/tags/' + tag,
      zipball_url: 'https://codeload.github.com/' + repository + '/zip/refs/tags/' + tag,
      assets_download_url:
        'https://github.com/' + repository + '/releases/download/' + tag + '/ASSET_NAME',
      nanocode_note:
        note +
        "github.com's latest-release redirect, so only the tag is known and assets are not listed",
    })
  }
  const contents = /^\/contents\/(.+)$/.exec(rest)
  if (contents && request.method === 'GET') {
    const path = contents[1]!.replace(/\/+$/, '')
    const ref = url.searchParams.get('ref') ?? 'HEAD'
    const download =
      'https://raw.githubusercontent.com/' +
      repository +
      '/' +
      ref.split('/').map(encodeURIComponent).join('/') +
      '/' +
      path
    const response = await fetcher(download, {
      headers: { 'user-agent': 'nanocode-ts' },
      redirect: 'follow',
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    if (/raw/.test(request.headers.get('accept') ?? ''))
      return new Response(response.body, {
        status: 200,
        headers: {
          'content-type': response.headers.get('content-type') ?? 'text/plain; charset=utf-8',
          [limitedHeader]: 'fallback',
        },
      })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const file = decodeURIComponent(path)
    return json({
      type: 'file',
      encoding: 'base64',
      size: bytes.length,
      name: file.split('/').pop(),
      path: file,
      content: base64(bytes),
      download_url: download,
      html_url: 'https://github.com/' + repository + '/blob/' + ref + '/' + path,
      nanocode_note: note + 'raw.githubusercontent.com, so sha is not known',
    })
  }
  const commit = /^\/commits\/([^?#]+)$/.exec(rest)
  if (commit) {
    const data = await commitOf(fetcher, repository, decodeURIComponent(commit[1]!), signal)
    return data
      ? json({
          ...data,
          nanocode_note:
            note + "the commit's .patch on github.com, so stats and files are not listed",
        })
      : null
  }
  if (rest === '' || rest === '/') {
    const refs = await defaultBranch(fetcher, repository, signal)
    return refs?.branch
      ? json({
          name: match[2],
          full_name: repository,
          default_branch: refs.branch,
          html_url: 'https://github.com/' + repository,
          clone_url: 'https://github.com/' + repository + '.git',
          private: false,
          nanocode_note:
            note + "git's ref advertisement, so only the name and default branch are known",
        })
      : null
  }
  return null
}

async function limited(response: Response): Promise<Response> {
  const text = await response.text().catch(() => '')
  let message = 'apiHost rate limit exceeded'
  try {
    const parsed = JSON.parse(text) as { message?: unknown }
    if (typeof parsed.message === 'string') message = parsed.message.replace(/\.$/, '')
  } catch {}
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    [limitedHeader]: 'limited',
  })
  for (const [name, value] of response.headers)
    if (/^(x-ratelimit-|retry-after$)/.test(name)) headers.set(name, value)
  return new Response(
    JSON.stringify({
      message: message + '. ' + rateLimitHint,
      documentation_url:
        'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api',
    }),
    { status: response.status, statusText: response.statusText, headers },
  )
}

export function wrap(fetcher: typeof fetch, options: FetchOptions = {}): typeof fetch {
  const layer: typeof fetch = async (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).hostname !== apiHost)
      return fetcher(input, init)
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    const token =
      request.method === 'GET' || request.method === 'HEAD'
        ? await tokenOf(options.token)
        : undefined
    const authorized = token !== undefined && !headers.has('authorization')
    if (authorized) headers.set('authorization', 'Bearer ' + token)
    if (!headers.has('user-agent')) headers.set('user-agent', 'nanocode-ts')
    const body =
      request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer()
    const mode = request.redirect
    let response = await fetcher(request.url, {
      method: request.method,
      headers,
      body,
      redirect: authorized && mode === 'follow' ? 'manual' : mode,
      signal: request.signal,
    })
    const location = response.headers.get('location')
    if (
      authorized &&
      mode === 'follow' &&
      response.status >= 300 &&
      response.status <= 399 &&
      location !== null
    ) {
      await response.body?.cancel().catch(() => undefined)
      const next = new URL(location, request.url)
      if (next.hostname !== apiHost) headers.delete('authorization')
      response = await fetcher(next.href, {
        method: response.status === 303 ? 'GET' : request.method,
        headers,
        body: response.status === 303 ? null : body,
        redirect: 'follow',
        signal: request.signal,
      })
    }
    if (response.headers.has(limitedHeader) || !(await rateLimited(response))) return response
    const alternative = await fallback(fetcher, request).catch((error) => {
      if (request.signal.aborted) throw error
      return null
    })
    if (alternative) {
      await response.body?.cancel().catch(() => undefined)
      return alternative
    }
    return limited(response)
  }
  return Egress.guarded(fetcher) ? Egress.mark(layer) : layer
}

export function archives(
  fetcher: typeof fetch = globalThis.fetch,
  options: FetchOptions = {},
): typeof fetch {
  const network = wrap(fetcher, options)
  return Egress.mark(async (input, init) => {
    const request = new Request(input, init)
    if (
      (request.method !== 'GET' && request.method !== 'HEAD') ||
      !allowed.some((pattern) => pattern.test(request.url))
    )
      throw new TypeError(
        request.method +
          ' ' +
          request.url +
          ' refused: this host reaches only public GitHub repositories (raw.githubusercontent.com files, codeload.github.com archives, github.com/OWNER/REPO/archive/, /releases/download/ and /raw/ files, and GET https://api.github.com/repos/OWNER/REPO with its /contents, /commits, /releases, /tarball and /zipball), so no other URL works from cells, curl or wget',
      )
    if (typeof (globalThis as { document?: unknown }).document !== 'undefined')
      return network(request)
    if (!request.headers.has('user-agent')) request.headers.set('user-agent', 'nanocode-ts')
    const mode = request.redirect
    const headers = new Headers(request.headers)
    let url = request.url
    for (let hop = 0; ; hop++) {
      const response = await network(url, {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: request.signal,
      })
      const location = response.headers.get('location')
      if (mode === 'manual' || response.status < 300 || response.status > 399 || location === null)
        return response
      await response.body?.cancel().catch(() => undefined)
      const next = new URL(location, url).href
      if (mode === 'error' || hop >= 10 || !allowed.some((pattern) => pattern.test(next)))
        throw new TypeError(
          request.method +
            ' ' +
            url +
            ' redirected to ' +
            next +
            ', which this host does not reach (only public GitHub repositories)',
        )
      if (new URL(next).origin !== new URL(url).origin)
        for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name)
      url = next
    }
  })
}

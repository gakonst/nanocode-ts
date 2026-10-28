import { CommandError, PipeError, type CommandContext, type CommandHandler } from '../shell.ts'
import { decode, encode, FsError, parentOf } from '../fs.ts'
import { escapes } from '../text.ts'
import { mkdirs } from './files.ts'

const VALUES = new Set([
  '-X',
  '--request',
  '-H',
  '--header',
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
  '--data-urlencode',
  '--json',
  '-o',
  '--output',
  '-w',
  '--write-out',
  '-u',
  '--user',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '-b',
  '--cookie',
  '-m',
  '--max-time',
  '--connect-timeout',
  '--retry',
  '--retry-delay',
  '--retry-max-time',
  '-F',
  '--form',
  '--form-string',
  '--url',
  '-T',
  '--upload-file',
  '--max-redirs',
  '-x',
  '--proxy',
  '-c',
  '--cookie-jar',
  '--resolve',
  '--cacert',
  '--cert',
  '--key',
  '-r',
  '--range',
  '--oauth2-bearer',
  '-C',
  '--continue-at',
  '-D',
  '--dump-header',
  '--max-filesize',
  '--limit-rate',
  '-K',
  '--config',
  '--output-dir',
  '-z',
  '--time-cond',
  '-y',
  '--speed-time',
  '-Y',
  '--speed-limit',
  '-E',
  '--proto',
  '--proto-redir',
  '--interface',
  '--dns-servers',
  '--expect100-timeout',
  '--keepalive-time',
  '--happy-eyeballs-timeout-ms',
  '-Q',
  '--quote',
  '--retry-all-errors-max',
])

const FLAGS: Record<string, string> = {
  s: '--silent',
  S: '--show-error',
  i: '--include',
  I: '--head',
  L: '--location',
  f: '--fail',
  v: '--verbose',
  k: '--insecure',
  G: '--get',
  O: '--remote-name',
  g: '--globoff',
  N: '--no-buffer',
  n: '--netrc',
  q: '--disable',
  '#': '--progress-bar',
  Z: '--parallel',
  J: '--remote-header-name',
  R: '--remote-time',
  '0': '--http1.0',
  '1': '--tlsv1',
  '2': '--sslv2',
  '3': '--sslv3',
  '4': '--ipv4',
  '6': '--ipv6',
  a: '--append',
  B: '--use-ascii',
  j: '--junk-session-cookies',
  l: '--list-only',
  M: '--manual',
  p: '--proxytunnel',
  V: '--version',
  h: '--help',
}

const SHORT_VALUES = 'XHdowuAebmFTrxcCDKzyYEQ'

const MAX_REDIRECTS = 50

const FLUSH_BYTES = 1 << 20

type Transfer = {
  url: string
  method: string
  headers: Headers
  body: BodyInit | undefined
  follow: boolean
  maxRedirects: number
  timeoutMs: number | undefined
  onHead?: (head: string) => void
}

type Received = {
  response: Response
  heads: string[]
  redirects: number
  url: string
  controller: AbortController
  done(): void
}

export class TransferError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

function headOf(response: Response): string {
  let head =
    'HTTP/1.1 ' + response.status + (response.statusText ? ' ' + response.statusText : '') + '\r\n'
  response.headers.forEach((value, key) => {
    head += key + ': ' + value + '\r\n'
  })
  return head + '\r\n'
}

export async function request(ctx: CommandContext, transfer: Transfer): Promise<Received> {
  if (!ctx.fetch) throw new TransferError(7, 'network access is not available in this shell')
  const controller = new AbortController()
  const abort = () => controller.abort()
  ctx.signal.addEventListener('abort', abort, { once: true })
  const timer =
    transfer.timeoutMs !== undefined
      ? setTimeout(() => controller.abort('timeout'), transfer.timeoutMs)
      : undefined
  const done = () => {
    if (timer !== undefined) clearTimeout(timer)
    ctx.signal.removeEventListener('abort', abort)
  }
  const started = Date.now()
  const heads: string[] = []
  let url = transfer.url
  let method = transfer.method
  let body = transfer.body
  let redirects = 0
  try {
    for (;;) {
      let response = await ctx.fetch(url, {
        method,
        headers: transfer.headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      })
      if (
        String(response.type) === 'opaqueredirect' ||
        (response.status === 0 && transfer.follow)
      ) {
        response = await ctx.fetch(url, {
          method,
          headers: transfer.headers,
          body,
          redirect: 'follow',
          signal: controller.signal,
        })
        return {
          response,
          heads: [...heads, headOf(response)],
          redirects: redirects + (response.redirected ? 1 : 0),
          url: response.url || url,
          controller,
          done,
        }
      }
      const location = response.headers.get('location')
      if (
        !transfer.follow ||
        location === null ||
        response.status < 300 ||
        response.status > 399 ||
        response.status === 304
      ) {
        heads.push(headOf(response))
        return { response, heads, redirects, url, controller, done }
      }
      heads.push(headOf(response))
      transfer.onHead?.(heads[heads.length - 1])
      await response.body?.cancel()
      if (redirects >= transfer.maxRedirects)
        throw new TransferError(47, 'Maximum (' + transfer.maxRedirects + ') redirects followed')
      redirects++
      url = new URL(location, url).href
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        if (method !== 'HEAD') method = 'GET'
        body = undefined
        transfer.headers.delete('content-type')
      }
    }
  } catch (error) {
    done()
    if (error instanceof TransferError) throw error
    if (controller.signal.reason === 'timeout')
      throw new TransferError(
        28,
        'Operation timed out after ' + (Date.now() - started) + ' milliseconds',
      )
    if (ctx.signal.aborted) throw error
    const message =
      error instanceof Error
        ? error.cause instanceof Error
          ? error.message + ': ' + error.cause.message
          : error.message
        : String(error)
    throw new TransferError(
      /resolve|ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(message) ? 6 : 7,
      message,
    )
  }
}

export async function stream(
  ctx: CommandContext,
  received: Received,
  sink: (chunk: Uint8Array) => Promise<void> | void,
  timeoutMs: number | undefined,
): Promise<number> {
  const reader = received.response.body?.getReader()
  let total = 0
  const started = Date.now()
  try {
    if (!reader) return 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      await sink(value)
    }
    return total
  } catch (error) {
    await reader?.cancel().catch(() => undefined)
    if (
      error instanceof TransferError ||
      error instanceof PipeError ||
      error instanceof CommandError ||
      error instanceof FsError
    )
      throw error
    if (received.controller.signal.reason === 'timeout')
      throw new TransferError(
        28,
        'Operation timed out after ' +
          (timeoutMs ?? Date.now() - started) +
          ' milliseconds with ' +
          total +
          ' bytes received',
      )
    if (ctx.signal.aborted) throw error
    throw new TransferError(
      56,
      'Failure when receiving data from the peer: ' +
        (error instanceof Error ? error.message : String(error)),
    )
  } finally {
    received.done()
  }
}

export function textStream(write: (text: string) => void) {
  let carry = new Uint8Array()
  const push = (chunk: Uint8Array, last: boolean) => {
    let bytes = chunk
    if (carry.length) {
      bytes = new Uint8Array(carry.length + chunk.length)
      bytes.set(carry)
      bytes.set(chunk, carry.length)
    }
    let cut = bytes.length
    if (!last) {
      let back = 0
      while (back < 3 && cut - back - 1 >= 0 && (bytes[cut - back - 1] & 0xc0) === 0x80) back++
      const lead = bytes[cut - back - 1]
      const need =
        lead === undefined ? 0 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
      if (lead !== undefined && lead >= 0xc0 && back + 1 < need) cut -= back + 1
    }
    carry = bytes.slice(cut)
    if (cut) write(decode(bytes.subarray(0, cut)))
  }
  return {
    push: (chunk: Uint8Array) => push(chunk, false),
    end: () => push(new Uint8Array(), true),
  }
}

export function fileSink(ctx: CommandContext, path: string, append: boolean) {
  let pending: Uint8Array[] = []
  let size = 0
  let started = append
  const flush = async () => {
    if (!pending.length && started) return
    const data = pending.length === 1 ? pending[0] : concat(pending, size)
    pending = []
    size = 0
    await ctx.fs.write(path, data, started)
    started = true
  }
  return {
    async push(chunk: Uint8Array) {
      pending.push(chunk)
      size += chunk.length
      if (size >= FLUSH_BYTES) await flush()
    },
    flush,
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function filename(response: Response, url: string, header: boolean): string {
  if (header) {
    const disposition = response.headers.get('content-disposition') ?? ''
    const match =
      /filename\*\s*=\s*[^']*'[^']*'([^;]+)|filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\s]+)/i.exec(
        disposition,
      )
    const name = match
      ? match[1] !== undefined
        ? decodeURIComponent(match[1])
        : (match[2] ?? match[3] ?? '')
      : ''
    const base = name.slice(name.lastIndexOf('/') + 1)
    if (base) return base
  }
  return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
}

export const curl: CommandHandler = async (ctx) => {
  const flags = new Set<string>()
  const values: [string, string][] = []
  const urls: string[] = []
  const args = ctx.args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=')
      const name = eq > 0 ? arg.slice(0, eq) : arg
      if (VALUES.has(name)) {
        const value = eq > 0 ? arg.slice(eq + 1) : args[++i]
        if (value === undefined)
          throw new CommandError('option ' + name + ': requires parameter', 2)
        values.push([name, value])
      } else if (name === '--remote-name-all') flags.add('--remote-name')
      else flags.add(name)
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j]
        if (SHORT_VALUES.includes(c)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i]
          if (value === undefined)
            throw new CommandError('option -' + c + ': requires parameter', 2)
          values.push(['-' + c, value])
          break
        }
        if (!FLAGS[c]) throw new CommandError('option -' + c + ': is unknown', 2)
        if (c === 'O') values.push(['-O', ''])
        flags.add(FLAGS[c])
      }
      continue
    }
    urls.push(arg)
  }
  const get = (...names: string[]) =>
    values.filter(([name]) => names.includes(name)).map(([, value]) => value)
  urls.push(...get('--url'))
  if (flags.has('--version')) {
    ctx.stdout.write(
      'curl 8.5.0 (nanocode-ts)\nProtocols: http https\nFeatures: alt-svc HTTP2 HTTPS-proxy libz SSL UnixSockets\n',
    )
    return 0
  }
  const silent = flags.has('--silent') && !flags.has('--show-error')
  const fail = (code: number, message: string) => {
    if (!silent) ctx.stderr.write('curl: (' + code + ') ' + message + '\n')
    return code
  }
  if (!urls.length) return fail(2, 'no URL specified')
  if (!ctx.fetch) return fail(7, 'network access is not available in this shell')
  const headers = new Headers()
  for (const header of get('-H', '--header')) {
    if (header.startsWith('@')) continue
    const colon = header.indexOf(':')
    if (colon < 0) {
      if (header.endsWith(';')) headers.set(header.slice(0, -1), '')
      continue
    }
    const value = header.slice(colon + 1).trim()
    if (value === '') headers.delete(header.slice(0, colon).trim())
    else headers.append(header.slice(0, colon).trim(), value)
  }
  const user = get('-u', '--user')[0]
  if (user !== undefined) headers.set('authorization', 'Basic ' + btoa(user))
  const bearer = get('--oauth2-bearer')[0]
  if (bearer !== undefined) headers.set('authorization', 'Bearer ' + bearer)
  const agent = get('-A', '--user-agent')[0]
  headers.set('user-agent', agent ?? headers.get('user-agent') ?? 'curl/8.5.0')
  if (!headers.has('accept')) headers.set('accept', '*/*')
  const referer = get('-e', '--referer')[0]
  if (referer !== undefined) headers.set('referer', referer)
  const cookie = get('-b', '--cookie')[0]
  if (cookie !== undefined && cookie.includes('=')) headers.set('cookie', cookie)
  const range = get('-r', '--range')[0]
  if (range !== undefined) headers.set('range', 'bytes=' + range)
  const readData = async (value: string, binary: boolean) => {
    if (!value.startsWith('@')) return value
    const file = value.slice(1)
    const text = file === '-' ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(file)))
    return binary ? text : text.replace(/[\r\n]/g, '')
  }
  const data: string[] = []
  for (const [name, value] of values) {
    if (name === '-d' || name === '--data' || name === '--data-ascii')
      data.push(await readData(value, false))
    else if (name === '--data-binary') data.push(await readData(value, true))
    else if (name === '--data-raw') data.push(value)
    else if (name === '--data-urlencode') {
      const eq = value.indexOf('=')
      const at = value.indexOf('@')
      if (at >= 0 && (eq < 0 || at < eq)) {
        const content = encodeURIComponent(await readData(value.slice(at), true))
        data.push(at > 0 ? value.slice(0, at) + '=' + content : content)
      } else if (eq < 0) data.push(encodeURIComponent(value))
      else data.push(value.slice(0, eq + 1) + encodeURIComponent(value.slice(eq + 1)))
    } else if (name === '--json') {
      data.push(await readData(value, true))
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
      headers.set('accept', 'application/json')
    }
  }
  const forms = values.filter(
    ([name]) => name === '-F' || name === '--form' || name === '--form-string',
  )
  let body: BodyInit | undefined
  let method = get('-X', '--request')[0]
  if (flags.has('--get') && data.length) {
    for (let i = 0; i < urls.length; i++)
      urls[i] += (urls[i].includes('?') ? '&' : '?') + data.join('&')
  } else if (forms.length) {
    const form = new FormData()
    for (const [option, field] of forms) {
      const eq = field.indexOf('=')
      if (eq < 0) throw new CommandError('illegally formatted input field', 2)
      const key = field.slice(0, eq)
      const raw = field.slice(eq + 1)
      if (option === '--form-string') {
        form.append(key, raw)
        continue
      }
      const [value, ...parameters] = raw.split(';')
      const parameter = (name: string) =>
        parameters
          .map((p) => p.trim())
          .find((p) => p.startsWith(name + '='))
          ?.slice(name.length + 1)
          .replace(/^"|"$/g, '')
      const type = parameter('type')
      if (value.startsWith('@') || value.startsWith('<')) {
        const path = value.slice(1)
        const bytes =
          path === '-'
            ? encode(ctx.stdin.read())
            : await ctx.fs.read(ctx.resolve(path)).catch(() => {
                throw new CommandError('Failed to open/read local data from file/application', 26)
              })
        const blob = new Blob(
          [bytes as Uint8Array<ArrayBuffer>],
          type ? { type } : value.startsWith('@') ? { type: 'application/octet-stream' } : {},
        )
        if (value.startsWith('@'))
          form.append(key, blob, parameter('filename') ?? path.slice(path.lastIndexOf('/') + 1))
        else form.append(key, type ? blob : decode(bytes))
      } else if (type) form.append(key, new Blob([value], { type }), parameter('filename') ?? '')
      else form.append(key, value)
    }
    body = form
    method ??= 'POST'
  } else if (data.length) {
    body = data.join('&')
    if (!headers.has('content-type'))
      headers.set('content-type', 'application/x-www-form-urlencoded')
    method ??= 'POST'
  }
  const upload = get('-T', '--upload-file')[0]
  if (upload !== undefined) {
    body = (
      upload === '-' ? encode(ctx.stdin.read()) : await ctx.fs.read(ctx.resolve(upload))
    ) as Uint8Array<ArrayBuffer>
    method ??= 'PUT'
    if (upload !== '-' && urls[0]?.endsWith('/'))
      urls[0] += upload.slice(upload.lastIndexOf('/') + 1)
  }
  if (flags.has('--head')) method = 'HEAD'
  method ??= 'GET'
  const timeout = get('-m', '--max-time')[0]
  const timeoutMs = timeout !== undefined ? Number(timeout) * 1000 : undefined
  const maxRedirects = Number(get('--max-redirs')[0] ?? MAX_REDIRECTS)
  const maxFilesize = get('--max-filesize')[0]
  const outputs = values
    .filter(([name]) => name === '-o' || name === '--output' || name === '-O')
    .map(([, value]) => value)
  const outputDir = get('--output-dir')[0]
  const dump = get('-D', '--dump-header')[0]
  const resume = get('-C', '--continue-at')[0]
  const verbose = flags.has('--verbose')
  const include = flags.has('--include') || flags.has('--head')
  let status = 0
  for (let index = 0; index < urls.length; index++) {
    let url = urls[index]
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url
    if (!/^https?:\/\//i.test(url)) {
      status = fail(1, 'Protocol "' + url.slice(0, url.indexOf(':')) + '" not supported')
      continue
    }
    const outputSpec = outputs[index]
    let output = outputSpec === '' ? undefined : outputSpec
    const remote = outputSpec === ''
    const resolveOutput = (name: string) =>
      ctx.resolve(
        outputDir !== undefined && !name.startsWith('/')
          ? outputDir.replace(/\/$/, '') + '/' + name
          : name,
      )
    const requestHeaders = new Headers(headers)
    let offset = 0
    if (resume !== undefined && output !== undefined && output !== '-') {
      if (resume === '-') offset = (await ctx.fs.stat(resolveOutput(output)))?.size ?? 0
      else offset = Number(resume)
      if (offset > 0) requestHeaders.set('range', 'bytes=' + offset + '-')
    } else if (resume !== undefined && resume !== '-' && Number(resume) > 0)
      requestHeaders.set('range', 'bytes=' + Number(resume) + '-')
    const started = Date.now()
    if (verbose) {
      ctx.stderr.write(
        '> ' +
          method +
          ' ' +
          new URL(url).pathname +
          new URL(url).search +
          ' HTTP/1.1\n> Host: ' +
          new URL(url).host +
          '\n',
      )
      requestHeaders.forEach((value, key) => ctx.stderr.write('> ' + key + ': ' + value + '\n'))
      ctx.stderr.write('>\n')
    }
    let received: Received
    try {
      received = await request(ctx, {
        url,
        method,
        headers: requestHeaders,
        body,
        follow: flags.has('--location'),
        maxRedirects,
        timeoutMs,
      })
    } catch (error) {
      if (error instanceof TransferError) {
        status = fail(error.code, error.message)
        continue
      }
      throw error
    }
    const response = received.response
    const head = received.heads.join('')
    if (verbose)
      ctx.stderr.write(
        head
          .split('\r\n')
          .map((line) => (line ? '< ' + line : '<'))
          .join('\n')
          .replace(/<\n<$/, '<') + '\n',
      )
    if (dump !== undefined) {
      if (dump === '-') ctx.stdout.write(head)
      else await ctx.fs.write(ctx.resolve(dump), encode(head))
    }
    const failed = (flags.has('--fail') || flags.has('--fail-with-body')) && response.status >= 400
    const length = Number(response.headers.get('content-length') ?? NaN)
    if (maxFilesize !== undefined && length > Number(maxFilesize)) {
      await response.body?.cancel()
      received.done()
      status = fail(63, 'Maximum file size exceeded')
      continue
    }
    if (remote) {
      output = filename(response, url, flags.has('--remote-header-name'))
      if (!output) {
        await response.body?.cancel()
        received.done()
        status = fail(
          23,
          'Failed writing received data to disk/application: Remote file name has no length',
        )
        continue
      }
    }
    const resumed = offset > 0 && response.status === 206
    if (offset > 0 && response.status === 416) {
      await response.body?.cancel()
      received.done()
      continue
    }
    if (offset > 0 && response.status === 200 && resume !== undefined && output !== undefined) {
      await response.body?.cancel()
      received.done()
      status = fail(33, "HTTP server doesn't seem to support byte ranges. Cannot resume.")
      continue
    }
    let size = 0
    try {
      if (failed && !flags.has('--fail-with-body')) {
        await response.body?.cancel()
        received.done()
        if (!silent || flags.has('--show-error'))
          ctx.stderr.write('curl: (22) The requested URL returned error: ' + response.status + '\n')
      } else if (output !== undefined && output !== '-') {
        const path = resolveOutput(output)
        if (flags.has('--create-dirs')) await mkdirs(ctx.fs, parentOf(path))
        const sink = fileSink(ctx, path, resumed || flags.has('--append'))
        if (include) await sink.push(encode(head))
        size =
          method === 'HEAD'
            ? 0
            : await stream(ctx, received, (chunk) => sink.push(chunk), timeoutMs)
        if (method === 'HEAD') received.done()
        await sink.flush()
      } else {
        if (include && dump !== '-') ctx.stdout.write(head)
        const limit = ctx.stdout.piped ? Infinity : ctx.limits.maxBufferLength
        const text = textStream((chunk) => ctx.stdout.write(chunk))
        if (method === 'HEAD') {
          await response.body?.cancel()
          received.done()
        } else
          size = await stream(
            ctx,
            received,
            async (chunk) => {
              if (size + chunk.length > limit)
                throw new TransferError(
                  63,
                  'Maximum output of ' +
                    limit +
                    ' bytes to the terminal exceeded; write it to a file with -o or pipe it',
                )
              size += chunk.length
              text.push(chunk)
              if (ctx.stdout.backlog) await ctx.stdout.drain()
            },
            timeoutMs,
          )
        text.end()
      }
    } catch (error) {
      if (error instanceof PipeError) {
        if (!silent) ctx.stderr.write('curl: (23) Failure writing output to destination\n')
        return 23
      }
      if (error instanceof TransferError) {
        status = fail(error.code, error.message)
        continue
      }
      if (error instanceof Error && 'code' in error && error.code === 'EFBIG') {
        status = fail(
          63,
          'Maximum file size exceeded: ' + output + ' would be larger than this file system allows',
        )
        continue
      }
      throw error
    }
    const writeOut = get('-w', '--write-out')[0]
    if (writeOut !== undefined) {
      const seconds = (Date.now() - started) / 1000
      const variables: Record<string, string> = {
        content_type: response.headers.get('content-type') ?? '',
        exitcode: failed ? '22' : '0',
        filename_effective: output ?? '',
        http_code: String(response.status),
        http_version: '1.1',
        method,
        num_headers: String([...response.headers.keys()].length),
        num_redirects: String(received.redirects),
        redirect_url:
          response.status >= 300 && response.status < 400 && response.headers.get('location')
            ? new URL(response.headers.get('location')!, received.url).href
            : '',
        response_code: String(response.status),
        scheme: new URL(received.url).protocol.slice(0, -1).toUpperCase(),
        size_download: String(size),
        size_header: String(encode(head).length),
        speed_download: String(Math.round(size / Math.max(seconds, 0.001))),
        time_starttransfer: seconds.toFixed(6),
        time_total: seconds.toFixed(6),
        url: url,
        url_effective: received.url,
      }
      const [expanded] = escapes(writeOut)
      ctx.stdout.write(
        expanded
          .replace(/%\{header\{([^}]+)\}\}/g, (_, name: string) => response.headers.get(name) ?? '')
          .replace(/%\{([a-z_]+)\}/g, (whole, name: string) => variables[name] ?? whole),
      )
    }
    if (failed) status = 22
  }
  return status
}

const WGET_VALUES = new Set([
  '-O',
  '--output-document',
  '-P',
  '--directory-prefix',
  '--header',
  '-U',
  '--user-agent',
  '--post-data',
  '--post-file',
  '-T',
  '--timeout',
  '--max-redirect',
  '-t',
  '--tries',
  '-i',
  '--input-file',
  '--method',
  '--body-data',
  '--user',
  '--password',
  '-o',
  '--output-file',
  '-a',
  '--append-output',
  '--referer',
  '-e',
  '--execute',
  '-w',
  '--wait',
  '--limit-rate',
  '-Q',
  '--quota',
  '--bind-address',
  '--dns-timeout',
  '--connect-timeout',
  '--read-timeout',
  '--retry-on-http-error',
  '--http-user',
  '--http-password',
  '--ca-certificate',
  '--default-page',
])

const WGET_FLAGS: Record<string, string> = {
  q: '--quiet',
  c: '--continue',
  S: '--server-response',
  N: '--timestamping',
  v: '--verbose',
  x: '--force-directories',
  r: '--recursive',
  k: '--convert-links',
  p: '--page-requisites',
  b: '--background',
  d: '--debug',
  F: '--force-html',
  4: '--inet4-only',
  6: '--inet6-only',
  h: '--help',
  V: '--version',
}

function human(bytes: number): string {
  if (bytes < 1024) return bytes + ''
  const units = ['K', 'M', 'G']
  let value = bytes
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return (value < 10 ? value.toFixed(1) : Math.round(value).toString()) + units[unit]
}

export const wget: CommandHandler = async (ctx) => {
  const flags = new Set<string>()
  const values: [string, string][] = []
  const urls: string[] = []
  const args = ctx.args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=')
      const name = eq > 0 ? arg.slice(0, eq) : arg
      if (WGET_VALUES.has(name)) {
        const value = eq > 0 ? arg.slice(eq + 1) : args[++i]
        if (value === undefined)
          throw new CommandError("option '" + name + "' requires an argument", 2)
        values.push([name, value])
      } else flags.add(name)
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (arg === '-nv' || arg === '-nc' || arg === '-nd' || arg === '-nH' || arg === '-np') {
        flags.add(arg)
        continue
      }
      for (let j = 1; j < arg.length; j++) {
        const option = '-' + arg[j]
        if (WGET_VALUES.has(option)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i]
          if (value === undefined)
            throw new CommandError("option requires an argument -- '" + arg[j] + "'", 2)
          values.push([option, value])
          break
        }
        const flag = WGET_FLAGS[arg[j]]
        if (!flag) throw new CommandError("invalid option -- '" + arg[j] + "'", 2)
        flags.add(flag)
      }
      continue
    }
    urls.push(arg)
  }
  const get = (...names: string[]) =>
    values.filter(([name]) => names.includes(name)).map(([, value]) => value)
  if (flags.has('--version')) {
    ctx.stdout.write('GNU Wget 1.21.4 (nanocode-ts)\n')
    return 0
  }
  for (const list of get('-i', '--input-file')) {
    const text = list === '-' ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(list)))
    urls.push(
      ...text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')),
    )
  }
  const quiet = flags.has('--quiet')
  const brief = flags.has('-nv')
  const log = (text: string) => {
    if (!quiet) ctx.stderr.write(text)
  }
  if (!urls.length) {
    ctx.stderr.write('wget: missing URL\nUsage: wget [OPTION]... [URL]...\n')
    return 1
  }
  if (!ctx.fetch) {
    ctx.stderr.write('wget: network access is not available in this shell\n')
    return 4
  }
  const headers = new Headers({
    'user-agent': get('-U', '--user-agent')[0] ?? 'Wget/1.21.4',
    accept: '*/*',
  })
  for (const header of get('--header')) {
    const colon = header.indexOf(':')
    if (colon > 0) headers.append(header.slice(0, colon).trim(), header.slice(colon + 1).trim())
  }
  const referer = get('--referer')[0]
  if (referer !== undefined) headers.set('referer', referer)
  const user = get('--user', '--http-user')[0]
  if (user !== undefined)
    headers.set(
      'authorization',
      'Basic ' + btoa(user + ':' + (get('--password', '--http-password')[0] ?? '')),
    )
  let body: string | undefined
  let method = get('--method')[0]?.toUpperCase()
  const post = get('--post-data', '--body-data')[0]
  const postFile = get('--post-file')[0]
  if (post !== undefined) body = post
  else if (postFile !== undefined) body = decode(await ctx.fs.read(ctx.resolve(postFile)))
  if (body !== undefined) {
    method ??= 'POST'
    if (!headers.has('content-type'))
      headers.set('content-type', 'application/x-www-form-urlencoded')
  }
  if (flags.has('--spider')) method = 'HEAD'
  method ??= 'GET'
  const timeout = get('-T', '--timeout', '--read-timeout')[0]
  const timeoutMs = timeout !== undefined ? Number(timeout) * 1000 : undefined
  const maxRedirects = Number(get('--max-redirect')[0] ?? 20)
  const document = get('-O', '--output-document')[0]
  const prefix = get('-P', '--directory-prefix')[0]
  let status = 0
  let documentStarted = false
  for (let raw of urls) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw
    const url = raw
    const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
    if (!brief) log('--' + stamp() + '--  ' + url + '\n')
    const requestHeaders = new Headers(headers)
    let target: string | undefined
    if (document === undefined) {
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || 'index.html'
      target = prefix !== undefined ? prefix.replace(/\/$/, '') + '/' + name : name
    } else if (document !== '-') target = document
    let offset = 0
    if (flags.has('--continue') && target !== undefined) {
      offset = (await ctx.fs.stat(ctx.resolve(target)))?.size ?? 0
      if (offset > 0) requestHeaders.set('range', 'bytes=' + offset + '-')
    }
    let received: Received
    try {
      received = await request(ctx, {
        url,
        method,
        headers: requestHeaders,
        body,
        follow: true,
        maxRedirects,
        timeoutMs,
        onHead: (head) => {
          const location = /\r\nlocation: ([^\r]*)/i.exec(head)?.[1]
          if (!brief)
            log(
              'HTTP request sent, awaiting response... ' +
                head.slice(9, head.indexOf('\r\n')) +
                '\nLocation: ' +
                (location ?? '') +
                ' [following]\n',
            )
        },
      })
    } catch (error) {
      if (error instanceof TransferError) {
        log(
          (brief ? url + ':\n' : '') +
            (error.code === 6
              ? 'wget: unable to resolve host address: ' + error.message
              : error.code === 47
                ? maxRedirects + ' redirections exceeded.'
                : 'failed: ' + error.message + '.') +
            '\n',
        )
        status = error.code === 47 ? 8 : 4
        continue
      }
      throw error
    }
    const response = received.response
    if (flags.has('--server-response'))
      log(
        received.heads
          .join('')
          .split('\r\n')
          .filter(Boolean)
          .map((line) => '  ' + line)
          .join('\n') + '\n',
      )
    const reason = response.status + ' ' + (response.statusText || (response.ok ? 'OK' : ''))
    if (!brief) log('HTTP request sent, awaiting response... ' + reason.trim() + '\n')
    if (offset > 0 && response.status === 416) {
      await response.body?.cancel()
      received.done()
      log('\n    The file is already fully retrieved; nothing to do.\n\n')
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      received.done()
      log(
        (brief ? stamp() + ' ' + url + ':\n' : '') + stamp() + ' ERROR ' + reason.trim() + '.\n\n',
      )
      status = 8
      continue
    }
    const length = response.headers.get('content-length')
    if (!brief)
      log(
        'Length: ' +
          (length === null ? 'unspecified' : length + ' (' + human(Number(length)) + ')') +
          (response.headers.get('content-type')
            ? ' [' + response.headers.get('content-type') + ']'
            : '') +
          '\n',
      )
    if (method === 'HEAD') {
      await response.body?.cancel()
      received.done()
      if (!brief) log('Remote file exists.\n\n')
      continue
    }
    if (
      target !== undefined &&
      document === undefined &&
      flags.has('-nc') &&
      (await ctx.fs.stat(ctx.resolve(target)))
    ) {
      await response.body?.cancel()
      received.done()
      log("File '" + target + "' already there; not retrieving.\n\n")
      continue
    }
    if (target !== undefined && document === undefined && offset === 0) {
      let n = 1
      const base = target
      while (await ctx.fs.stat(ctx.resolve(target))) target = base + '.' + n++
    }
    if (!brief && target !== undefined) log("Saving to: '" + target + "'\n\n")
    const started = Date.now()
    let size = 0
    try {
      if (target === undefined) {
        const text = textStream((chunk) => ctx.stdout.write(chunk))
        size = await stream(
          ctx,
          received,
          async (chunk) => {
            text.push(chunk)
            if (ctx.stdout.backlog) await ctx.stdout.drain()
          },
          timeoutMs,
        )
        text.end()
      } else {
        const path = ctx.resolve(target)
        if (prefix !== undefined) await mkdirs(ctx.fs, parentOf(path))
        const sink = fileSink(
          ctx,
          path,
          (offset > 0 && response.status === 206) || (document !== undefined && documentStarted),
        )
        size = await stream(ctx, received, (chunk) => sink.push(chunk), timeoutMs)
        await sink.flush()
        if (document !== undefined) documentStarted = true
      }
    } catch (error) {
      if (error instanceof PipeError) return 3
      if (error instanceof TransferError) {
        log('Read error (' + error.message + ').\n')
        status = 4
        continue
      }
      if (error instanceof Error && 'code' in error && error.code === 'EFBIG') {
        log("Cannot write to '" + target + "' (File too large).\n")
        status = 3
        continue
      }
      throw error
    }
    const seconds = Math.max((Date.now() - started) / 1000, 0.001)
    const rate = human(size / seconds) + 'B/s'
    if (brief)
      log(
        stamp() +
          ' URL:' +
          received.url +
          ' [' +
          size +
          (length !== null ? '/' + length : '') +
          '] -> "' +
          (target ?? '-') +
          '" [1]\n',
      )
    else
      log(
        stamp() +
          ' (' +
          rate +
          ') - ' +
          (target === undefined ? 'written to stdout' : "'" + target + "' saved") +
          ' [' +
          size +
          (length !== null ? '/' + length : '') +
          ']\n\n',
      )
  }
  return status
}

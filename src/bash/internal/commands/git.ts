import { CommandError, type CommandContext, type CommandHandler } from '../Shell.ts'
import { FsError, normalize, type FileSystem, type NewFile } from '../../FileSystem.ts'
import { breathe, decode, encode, parentOf, writeMany } from '../Fs.ts'
import { TarReader } from './archive.ts'
import * as GitHub from '../../GitHub.ts'

const MAX_BYTES = 200 * 1024 * 1024

const MAX_FILE_BYTES = 8 * 1024 * 1024

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024

const MAX_FILES = 50_000

const STALL_MS = 30_000

const BATCH_BYTES = 4 * 1024 * 1024

const ATTEMPTS = 2

const MARKER = '.git/nanocode.json'

const SUPPORTED =
  'clone, init, status, add, rm, mv, commit, diff, apply, log, show, checkout, switch, restore, reset, branch, rev-parse, remote, ls-files, describe, config'

type Snapshot = {
  repository: string
  url: string
  ref: string
  branch: string | null
  commit: string | null
  author: string | null
  date: string | null
  message: string | null
  cloned: string
  files: Record<string, Entry>
  omitted?: string[]
  local?: Local
}

type Clone = {
  repository: string
  ref: string | undefined
  directory: string | undefined
  quiet: boolean
}

const NAME = /^[A-Za-z0-9_.-]+$/

export function repositoryOf(spec: string): string | null {
  const patterns = [
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^(?:github\.com\/)?([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(spec)
    if (match && NAME.test(match[1]) && NAME.test(match[2])) return match[1] + '/' + match[2]
  }
  return null
}

function parseClone(args: string[]): Clone {
  const operands: string[] = []
  let ref: string | undefined
  let quiet = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = (name: string) => {
      const eq = arg.indexOf('=')
      if (eq > 0) return arg.slice(eq + 1)
      const next = args[++i]
      if (next === undefined)
        throw new CommandError("fatal: option '" + name + "' requires a value", 129)
      return next
    }
    if (arg === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (arg === '-b' || arg === '--branch' || arg.startsWith('--branch=')) ref = value('branch')
    else if (
      arg === '--depth' ||
      arg.startsWith('--depth=') ||
      arg === '--filter' ||
      arg.startsWith('--filter=') ||
      arg === '--origin' ||
      arg.startsWith('--origin=') ||
      arg === '-o' ||
      arg === '--shallow-since' ||
      arg.startsWith('--shallow-since=') ||
      arg === '-c' ||
      arg === '--config' ||
      arg.startsWith('--config=') ||
      arg === '-j' ||
      arg === '--jobs' ||
      arg.startsWith('--jobs=')
    )
      value(arg)
    else if (arg === '-q' || arg === '--quiet') quiet = true
    else if (
      arg.startsWith('--depth') ||
      [
        '--single-branch',
        '--no-single-branch',
        '--recursive',
        '--recurse-submodules',
        '--shallow-submodules',
        '--no-tags',
        '--progress',
        '-v',
        '--verbose',
        '--no-checkout',
        '-n',
        '--bare',
        '--mirror',
        '--no-hardlinks',
        '-l',
        '--local',
      ].includes(arg)
    )
      continue
    else if (arg.startsWith('-'))
      throw new CommandError("error: unknown option '" + arg.replace(/^-+/, '') + "'", 129)
    else operands.push(arg)
  }
  if (!operands.length)
    throw new CommandError('fatal: You must specify a repository to clone.', 129)
  if (operands.length > 2) throw new CommandError('fatal: Too many arguments.', 129)
  const repository = repositoryOf(operands[0])
  if (!repository)
    throw new CommandError(
      'fatal: only GitHub repositories can be cloned here (https://github.com/OWNER/REPO, git@github.com:OWNER/REPO.git or OWNER/REPO): ' +
        operands[0],
      128,
    )
  return { repository, ref, directory: operands[1], quiet }
}

class Stalled extends Error {}

type Watch = {
  signal: AbortSignal
  arm(): void
  stop(): void
  race<T>(promise: Promise<T>): Promise<T>
}

function watchdog(parent: AbortSignal, ms: number, what: string): Watch {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let fail: (error: Error) => void = () => {}
  const stalled = new Promise<never>((_, reject) => {
    fail = reject
  })
  stalled.catch(() => {})
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    arm() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        const error = new Stalled(what + ' sent no data for ' + Math.round(ms / 1000) + ' s')
        controller.abort(error)
        fail(error)
      }, ms)
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer)
    },
    race: (promise) => Promise.race([promise, stalled]),
  }
}

function lost(error: unknown): boolean {
  return (
    error instanceof Stalled ||
    (error instanceof Error &&
      !(error instanceof CommandError) &&
      /network connection lost|connection (?:was )?(?:reset|closed|lost)|terminated|socket hang up|ECONNRESET|other side closed/i.test(
        error.message,
      ))
  )
}

async function fetchArchive(
  ctx: CommandContext,
  github: GitHub.Options,
  repository: string,
  ref: string,
): Promise<{ response: Response; watch: Watch }> {
  if (!ctx.fetch)
    throw new CommandError('fatal: network access is not available in this shell', 128)
  const fetcher = GitHub.wrap(ctx.fetch, { token: github.token })
  const [owner, repo] = repository.split('/')
  const urls = github.archive
    ? [github.archive(owner, repo, ref)]
    : [
        GitHub.codeload({ owner, ref, repo }),
        'https://api.github.com/repos/' + repository + '/tarball/' + encodeURIComponent(ref),
      ]
  const stallMs = github.stallMs ?? STALL_MS
  let last = 0
  for (const url of urls) {
    const watch = watchdog(ctx.signal, stallMs, 'GitHub')
    let response: Response
    try {
      watch.arm()
      response = await watch.race(fetcher(url, { signal: watch.signal, redirect: 'follow' }))
    } catch (error) {
      watch.stop()
      if (ctx.signal.aborted) throw error
      if (error instanceof Error && /network access|refused: this host/.test(error.message))
        throw new CommandError('fatal: ' + error.message, 128)
      last = error instanceof Stalled ? -2 : -1
      continue
    }
    if (response.ok && response.body) return { response, watch }
    watch.stop()
    last = response.status
    await response.body?.cancel().catch(() => {})
  }
  if (last === 404)
    throw new CommandError(
      "fatal: repository 'https://github.com/" +
        repository +
        ".git/' or ref '" +
        ref +
        "' not found (private repositories cannot be cloned here)",
      128,
    )
  if (last === -2)
    throw new Stalled(
      'GitHub did not start sending the archive within ' + Math.round(stallMs / 1000) + ' s',
    )
  throw new CommandError(
    'fatal: unable to download https://github.com/' +
      repository +
      ' at ' +
      ref +
      (last > 0 ? ' (HTTP ' + last + ')' : ''),
    128,
  )
}

async function details(
  ctx: CommandContext,
  github: GitHub.Options,
  repository: string,
  ref: string,
  commit: string | null,
): Promise<{
  branch: string | null
  author: string | null
  date: string | null
  message: string | null
  commit: string | null
}> {
  const out = {
    branch: ref === 'HEAD' || /^[0-9a-f]{40}$/.test(ref) ? null : ref,
    author: null as string | null,
    date: null as string | null,
    message: null as string | null,
    commit,
  }
  if (!ctx.fetch) return out
  const fetcher = GitHub.wrap(ctx.fetch, { token: github.token })
  const get = async (path: string): Promise<unknown> => {
    try {
      const response = await fetcher('https://api.github.com/repos/' + repository + path, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'nanocode-ts' },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(5000)]),
      })
      return response.ok ? await response.json() : null
    } catch {
      return null
    }
  }
  const [repo, info] = await Promise.all([
    ref === 'HEAD' ? get('') : null,
    get('/commits/' + encodeURIComponent(commit ?? ref)),
  ])
  const branch = (repo as { default_branch?: unknown } | null)?.default_branch
  if (typeof branch === 'string') out.branch = branch
  const data = info as {
    sha?: unknown
    commit?: { author?: { name?: unknown; email?: unknown; date?: unknown }; message?: unknown }
  } | null
  if (typeof data?.sha === 'string') out.commit = data.sha
  const author = data?.commit?.author
  if (typeof author?.name === 'string')
    out.author = author.name + (typeof author.email === 'string' ? ' <' + author.email + '>' : '')
  if (typeof author?.date === 'string') out.date = author.date
  if (typeof data?.commit?.message === 'string') out.message = data.commit.message
  return out
}

async function removeTree(fs: FileSystem, path: string) {
  const stat = await fs.stat(path)
  if (stat?.kind === 'directory')
    for (const name of await fs.list(path))
      await removeTree(fs, (path === '/' ? '' : path) + '/' + name)
  if (stat) await fs.remove(path)
}

async function clone(ctx: CommandContext, github: GitHub.Options, args: string[]): Promise<number> {
  const options = parseClone(args)
  const name = options.repository.split('/')[1]
  const directory = options.directory ?? name
  const target = ctx.resolve(directory)
  const existing = await ctx.fs.stat(target)
  if (existing && (existing.kind !== 'directory' || (await ctx.fs.list(target)).length))
    throw new CommandError(
      "fatal: destination path '" + directory + "' already exists and is not an empty directory.",
      128,
    )
  const ref = options.ref ?? 'HEAD'
  if (!ctx.fetch)
    throw new CommandError('fatal: network access is not available in this shell', 128)
  if (!options.quiet) ctx.stderr.write("Cloning into '" + directory + "'...\n")
  const known = new Set<string>()
  const ensure = async (path: string) => {
    if (known.has(path)) return
    const parent = parentOf(path)
    if (parent !== path) await ensure(parent)
    const stat = await ctx.fs.stat(path)
    if (!stat) await ctx.fs.mkdir(path)
    else if (stat.kind !== 'directory') throw new FsError('ENOTDIR', path)
    known.add(path)
  }
  const maxBytes = github.maxBytes ?? MAX_BYTES
  const maxFiles = github.maxFiles ?? MAX_FILES
  const maxFileBytes = github.maxFileBytes ?? MAX_FILE_BYTES
  const maxDownload = github.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES
  const created = !existing
  let files: Record<string, Entry> = {}
  let reader = new TarReader(maxFileBytes)
  let omitted: { path: string; bytes: number; reason: string }[] = []
  let written = 0
  let count = 0
  let skipped = 0
  let queued: { relative: string; file: NewFile }[] = []
  let dirs: string[] = []
  let queuedBytes = 0
  const folder = (path: string) => {
    if (known.has(path)) return
    folder(parentOf(path))
    known.add(path)
    dirs.push(path)
  }
  const flush = async () => {
    const batch = queued
    const made = dirs
    queued = []
    dirs = []
    queuedBytes = 0
    if (!batch.length && !made.length) return
    const [refused, ids] = await Promise.all([
      writeMany(
        ctx.fs,
        made,
        batch.map((entry) => entry.file),
      ),
      Promise.all(batch.map((entry) => blobId(entry.file.data))),
    ])
    const failed = new Set(refused)
    batch.forEach((entry, index) => {
      if (!failed.has(entry.file.path)) {
        files[entry.relative] = [entry.file.data.length, entry.file.mtime, ids[index]!]
        return
      }
      omitted.push({
        path: entry.relative,
        bytes: entry.file.data.length,
        reason: 'larger than this filesystem stores',
      })
      count--
      written -= entry.file.data.length
    })
  }
  for (let attempt = 1; ; attempt++) {
    files = {}
    reader = new TarReader(maxFileBytes)
    omitted = []
    written = 0
    count = 0
    skipped = 0
    queued = []
    dirs = []
    queuedBytes = 0
    known.clear()
    let watch: Watch | undefined
    let stream: ReadableStreamDefaultReader<Uint8Array> | undefined
    let root: string | undefined
    let bytes = 0
    try {
      const download = await fetchArchive(ctx, github, options.repository, ref)
      watch = download.watch
      stream = download.response.body!.pipeThrough(new DecompressionStream('gzip')).getReader()
      await ensure(target)
      for (;;) {
        if (ctx.signal.aborted) throw new CommandError('fatal: clone aborted', 130)
        watch.arm()
        const next = await watch.race(stream.read())
        if (next.done) break
        bytes += next.value.length
        if (bytes > maxDownload)
          throw new CommandError(
            'fatal: repository archive is larger than ' +
              Math.round(maxDownload / 1024 / 1024) +
              ' MiB uncompressed; clone a smaller repository or fetch single files with curl',
            128,
          )
        watch.stop()
        for (const entry of reader.push(next.value)) {
          const parts = entry.name.split('/')
          if (
            entry.name.startsWith('/') ||
            entry.name.includes('\\') ||
            entry.name.includes('\0') ||
            parts.some((part) => part === '..' || part === '.' || part === '' || part === '.git')
          )
            throw new CommandError(
              'fatal: repository archive contains an unsafe path: ' + entry.name,
              128,
            )
          root ??= parts[0]
          if (parts[0] !== root)
            throw new CommandError('fatal: repository archive must contain one root directory', 128)
          if (parts.length === 1) continue
          const relative = parts.slice(1).join('/')
          const path = target + '/' + relative
          if (entry.type === 'directory') {
            folder(path)
            continue
          }
          if (entry.type !== 'file') {
            skipped++
            continue
          }
          const reason =
            entry.omitted !== undefined
              ? 'larger than ' + size(maxFileBytes)
              : count >= maxFiles
                ? 'past the ' + maxFiles + '-file limit'
                : written + entry.data.length > maxBytes
                  ? 'past the ' + size(maxBytes) + ' limit'
                  : undefined
          if (reason) {
            omitted.push({ path: relative, bytes: entry.omitted ?? entry.data.length, reason })
            continue
          }
          count++
          written += entry.data.length
          folder(parentOf(path))
          queued.push({ relative, file: { path, data: entry.data, mtime: Date.now() } })
          queuedBytes += entry.data.length + 512
          if (queuedBytes >= BATCH_BYTES) await flush()
        }
        await breathe()
        if (reader.done) break
      }
      await flush()
      if (!root) throw new CommandError('fatal: repository archive is empty', 128)
      watch.stop()
      await stream.cancel().catch(() => {})
      break
    } catch (error) {
      watch?.stop()
      await stream?.cancel().catch(() => {})
      if (created) await removeTree(ctx.fs, target).catch(() => {})
      else
        for (const name of await ctx.fs.list(target).catch(() => [] as string[]))
          await removeTree(ctx.fs, target + '/' + name).catch(() => {})
      if (!ctx.signal.aborted && lost(error)) {
        const reason = error instanceof Error ? error.message.replace(/\.$/, '') : String(error)
        if (attempt < ATTEMPTS) {
          if (!options.quiet)
            ctx.stderr.write(
              'warning: the download of ' +
                options.repository +
                (bytes ? ' broke off after ' + size(bytes) : ' did not start') +
                ' (' +
                reason +
                '); retrying\n',
            )
          continue
        }
        throw new CommandError(
          'fatal: could not download https://github.com/' +
            options.repository +
            ' at ' +
            ref +
            ': ' +
            reason +
            ' (' +
            ATTEMPTS +
            ' attempts); try again later, clone with -b <tag> for a smaller ref, or fetch single files with curl',
          128,
        )
      }
      if (
        error instanceof Error &&
        !(error instanceof CommandError) &&
        /exceeds the limit/.test(error.message)
      )
        throw new CommandError('fatal: ' + error.message, 128)
      throw error
    }
  }
  const pax = reader.global['comment']
  const commit = pax && /^[0-9a-f]{40}$/.test(pax) ? pax : null
  const info =
    github.details === false
      ? { branch: ref === 'HEAD' ? null : ref, author: null, date: null, message: null, commit }
      : await details(ctx, github, options.repository, ref, commit)
  const snapshot: Snapshot = {
    repository: options.repository,
    url: 'https://github.com/' + options.repository + '.git',
    ref,
    branch: info.branch,
    commit: info.commit,
    author: info.author,
    date: info.date,
    message: info.message,
    cloned: new Date().toISOString(),
    files,
    ...(omitted.length ? { omitted: omitted.map((item) => item.path) } : {}),
  }
  await ensure(target + '/.git')
  await ctx.fs.write(
    target + '/.git/HEAD',
    encode(
      snapshot.branch
        ? 'ref: refs/heads/' + snapshot.branch + '\n'
        : (snapshot.commit ?? ref) + '\n',
    ),
  )
  await ctx.fs.write(
    target + '/.git/config',
    encode(
      '[remote "origin"]\n\turl = ' +
        snapshot.url +
        '\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' +
        (snapshot.branch
          ? '[branch "' +
            snapshot.branch +
            '"]\n\tremote = origin\n\tmerge = refs/heads/' +
            snapshot.branch +
            '\n'
          : ''),
    ),
  )
  await ctx.fs.write(target + '/' + MARKER, encode(JSON.stringify(snapshot)))
  if (omitted.length) {
    const raw =
      'https://raw.githubusercontent.com/' +
      options.repository +
      '/' +
      (snapshot.commit ?? ref) +
      '/'
    ctx.stderr.write(
      'warning: left out ' +
        omitted.length +
        ' file' +
        (omitted.length === 1 ? '' : 's') +
        ' (' +
        size(omitted.reduce((total, item) => total + item.bytes, 0)) +
        '); fetch one with curl -sLO ' +
        raw +
        'PATH\n',
    )
    for (const item of omitted.slice(0, 10))
      ctx.stderr.write('  ' + item.path + ' (' + size(item.bytes) + ', ' + item.reason + ')\n')
    if (omitted.length > 10)
      ctx.stderr.write(
        '  ... and ' + (omitted.length - 10) + ' more, listed in .git/nanocode.json\n',
      )
  }
  if (!options.quiet)
    ctx.stderr.write(
      'Downloaded ' +
        count +
        ' files (' +
        size(written) +
        ') from ' +
        options.repository +
        ' at ' +
        (snapshot.commit ? snapshot.commit.slice(0, 7) : ref) +
        ': a source snapshot without history' +
        (skipped ? '; skipped ' + skipped + ' symbolic link' + (skipped === 1 ? '' : 's') : '') +
        '.\n',
    )
  return 0
}

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? (bytes / 1024).toFixed(1) + ' KiB'
    : (bytes / 1024 / 1024).toFixed(2) + ' MiB'
}

async function locate(ctx: CommandContext): Promise<{ root: string; snapshot: Snapshot }> {
  let dir = ctx.cwd
  for (;;) {
    const stat = await ctx.fs.stat((dir === '/' ? '' : dir) + '/' + MARKER)
    if (stat?.kind === 'file')
      return {
        root: dir,
        snapshot: JSON.parse(
          decode(await ctx.fs.read((dir === '/' ? '' : dir) + '/' + MARKER)),
        ) as Snapshot,
      }
    if (dir === '/') break
    dir = parentOf(dir)
  }
  throw new CommandError(
    'fatal: not a git repository (or any of the parent directories): .git',
    128,
  )
}

async function walk(
  fs: FileSystem,
  root: string,
  prefix: string,
  out: Map<string, { size: number; mtime: number }>,
) {
  for (const name of await fs.list(root + (prefix ? '/' + prefix : ''))) {
    const relative = prefix ? prefix + '/' + name : name
    if (relative === '.git') continue
    const stat = await fs.stat(root + '/' + relative)
    if (!stat) continue
    if (stat.kind === 'directory') await walk(fs, root, relative, out)
    else out.set(relative, { size: stat.size, mtime: stat.mtime })
  }
}

function relativeTo(ctx: CommandContext, root: string, path: string): string {
  const absolute = normalize(root + '/' + path)
  const base = ctx.cwd === '/' ? '/' : ctx.cwd + '/'
  if (absolute.startsWith(base)) return absolute.slice(base.length)
  const up = ctx.cwd.split('/').filter(Boolean)
  const target = absolute.split('/').filter(Boolean)
  let common = 0
  while (common < up.length && common < target.length && up[common] === target[common]) common++
  return [...Array(up.length - common).fill('..'), ...target.slice(common)].join('/')
}

type Entry = [number, number] | [number, number, string]

type Commit = {
  parent: string | null
  message: string
  author: string
  date: string
  changes: Record<string, string | null>
}

type Local = {
  branch: string | null
  head: string | null
  branches: Record<string, string | null>
  commits: Record<string, Commit>
  index: Record<string, string | null>
  stat: Record<string, [number, number, string]>
  config?: Record<string, string>
}

type Repo = { root: string; snapshot: Snapshot; local: Local }

const HEX = /^[0-9a-f]{4,40}$/

function localOf(snapshot: Snapshot): Local {
  return (
    snapshot.local ?? {
      branch: snapshot.branch,
      head: null,
      branches: snapshot.branch ? { [snapshot.branch]: null } : {},
      commits: {},
      index: {},
      stat: {},
    }
  )
}

async function open(ctx: CommandContext): Promise<Repo> {
  const { root, snapshot } = await locate(ctx)
  return { root, snapshot, local: localOf(snapshot) }
}

async function save(ctx: CommandContext, repo: Repo): Promise<void> {
  repo.snapshot.local = repo.local
  await ctx.fs.write(repo.root + '/' + MARKER, encode(JSON.stringify(repo.snapshot)))
  await ctx.fs.write(
    repo.root + '/.git/HEAD',
    encode(
      repo.local.branch
        ? 'ref: refs/heads/' + repo.local.branch + '\n'
        : (repo.local.head ?? repo.snapshot.commit ?? repo.snapshot.ref) + '\n',
    ),
  )
}

async function blobId(data: Uint8Array): Promise<string> {
  const header = encode('blob ' + data.length + '\0')
  const all = new Uint8Array(header.length + data.length)
  all.set(header)
  all.set(data, header.length)
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-1', all)))
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const value of bytes) out += value.toString(16).padStart(2, '0')
  return out
}

function baseRef(snapshot: Snapshot, path: string): string {
  return (snapshot.files[path] as Entry)[2] ?? 'base:' + path
}

function baseTree(snapshot: Snapshot): Map<string, string> {
  const tree = new Map<string, string>()
  for (const path of Object.keys(snapshot.files)) tree.set(path, baseRef(snapshot, path))
  return tree
}

function chain(local: Local, id: string | null): string[] {
  const out: string[] = []
  for (let at = id; at; at = local.commits[at]?.parent ?? null) out.push(at)
  return out.reverse()
}

function treeAt(repo: Repo, id: string | null): Map<string, string> {
  const tree = baseTree(repo.snapshot)
  for (const at of chain(repo.local, id)) {
    for (const [path, ref] of Object.entries(repo.local.commits[at]!.changes)) {
      if (ref === null) tree.delete(path)
      else tree.set(path, ref)
    }
  }
  return tree
}

function indexTree(repo: Repo, head: Map<string, string>): Map<string, string> {
  const tree = new Map(head)
  for (const [path, ref] of Object.entries(repo.local.index)) {
    if (ref === null) tree.delete(path)
    else tree.set(path, ref)
  }
  return tree
}

function resolveRev(repo: Repo, spec: string): string | null | undefined {
  const { local, snapshot } = repo
  const match = /^(.*?)((?:[~^]\d*)*)$/.exec(spec)!
  let name = match[1]!
  if (name === 'HEAD' || name === '@' || name === '') name = 'HEAD'
  let id: string | null | undefined
  if (name === 'HEAD') id = local.head
  else if (Object.hasOwn(local.branches, name)) id = local.branches[name]!
  else if (snapshot.branch && (name === 'origin/' + snapshot.branch || name === 'origin/HEAD'))
    id = null
  else if (HEX.test(name)) {
    const found = Object.keys(local.commits).filter((key) => key.startsWith(name))
    if (found.length === 1) id = found[0]!
    else if (snapshot.commit?.startsWith(name)) id = null
    else return undefined
  } else return undefined
  for (const step of match[2]!.match(/[~^]\d*/g) ?? []) {
    const count =
      step[0] === '~'
        ? Number(step.slice(1) || 1)
        : step.length > 1 && step.slice(1) === '0'
          ? 0
          : 1
    for (let i = 0; i < count; i++) {
      if (!id) return undefined
      id = local.commits[id]!.parent
    }
  }
  return id
}

function shortOf(repo: Repo, id: string | null): string {
  return (id ?? repo.snapshot.commit ?? '0000000').slice(0, 7)
}

async function content(ctx: CommandContext, repo: Repo, ref: string): Promise<Uint8Array> {
  if (!ref.startsWith('base:')) {
    const object = repo.root + '/.git/objects/' + ref
    if ((await ctx.fs.stat(object))?.kind === 'file') return ctx.fs.read(object)
  }
  const path = ref.startsWith('base:')
    ? ref.slice(5)
    : Object.keys(repo.snapshot.files).find(
        (name) => (repo.snapshot.files[name] as Entry)[2] === ref,
      )
  if (path === undefined || !repo.snapshot.repository || !ctx.fetch)
    throw new CommandError('fatal: unable to read object ' + ref.replace(/^base:/, ''), 128)
  const url =
    'https://raw.githubusercontent.com/' +
    repo.snapshot.repository +
    '/' +
    (repo.snapshot.commit ?? repo.snapshot.ref) +
    '/' +
    path.split('/').map(encodeURIComponent).join('/')
  const response = await ctx.fetch(url, { signal: ctx.signal })
  if (!response.ok)
    throw new CommandError(
      'fatal: unable to fetch the original ' +
        path +
        ' from ' +
        url +
        ' (HTTP ' +
        response.status +
        ')',
      128,
    )
  const data = new Uint8Array(await response.arrayBuffer())
  if (!ref.startsWith('base:')) await store(ctx, repo, ref, data)
  return data
}

async function store(ctx: CommandContext, repo: Repo, id: string, data: Uint8Array): Promise<void> {
  const object = repo.root + '/.git/objects/' + id
  if (await ctx.fs.stat(object)) return
  if (!(await ctx.fs.stat(repo.root + '/.git/objects')))
    await ctx.fs.mkdir(repo.root + '/.git/objects')
  await ctx.fs.write(object, data)
}

async function hashWork(
  ctx: CommandContext,
  repo: Repo,
  path: string,
  keep: boolean,
): Promise<string | null> {
  const full = repo.root + '/' + path
  const stat = await ctx.fs.stat(full)
  if (!stat || stat.kind !== 'file') return null
  const cached = repo.local.stat[path] ?? (repo.snapshot.files[path] as Entry | undefined)
  if (cached && cached[0] === stat.size && cached[1] === stat.mtime) {
    const id = cached[2] ?? 'base:' + path
    if (keep && !id.startsWith('base:') && !(await ctx.fs.stat(repo.root + '/.git/objects/' + id)))
      await store(ctx, repo, id, await ctx.fs.read(full))
    return id
  }
  const data = await ctx.fs.read(full)
  const id = await blobId(data)
  repo.local.stat[path] = [stat.size, stat.mtime, id]
  if (keep) await store(ctx, repo, id, data)
  return id
}

async function worktree(ctx: CommandContext, repo: Repo): Promise<Set<string>> {
  const found = new Map<string, { size: number; mtime: number }>()
  await walk(ctx.fs, repo.root, '', found)
  return new Set(found.keys())
}

type State = {
  head: Map<string, string>
  index: Map<string, string>
  present: Set<string>
  staged: Map<string, 'A' | 'M' | 'D'>
  unstaged: Map<string, 'M' | 'D'>
  untracked: string[]
}

async function state(ctx: CommandContext, repo: Repo): Promise<State> {
  const head = treeAt(repo, repo.local.head)
  const index = indexTree(repo, head)
  const present = await worktree(ctx, repo)
  const staged = new Map<string, 'A' | 'M' | 'D'>()
  for (const path of new Set([...head.keys(), ...index.keys()])) {
    const a = head.get(path)
    const b = index.get(path)
    if (a === b) continue
    staged.set(path, a === undefined ? 'A' : b === undefined ? 'D' : 'M')
  }
  const unstaged = new Map<string, 'M' | 'D'>()
  const omitted = new Set(repo.snapshot.omitted)
  for (const [path, ref] of index) {
    if (!present.has(path)) {
      if (!omitted.has(path)) unstaged.set(path, 'D')
      continue
    }
    if ((await hashWork(ctx, repo, path, false)) !== ref) unstaged.set(path, 'M')
  }
  const untracked = [...present].filter((path) => !index.has(path) && !omitted.has(path)).sort()
  return { head, index, present, staged, unstaged, untracked }
}

function scoped(ctx: CommandContext, root: string, specs: string[]): (path: string) => boolean {
  if (!specs.length) return () => true
  const prefixes = specs.map((spec) => {
    const absolute = ctx.resolve(spec)
    return absolute === root
      ? ''
      : absolute.startsWith(root + '/')
        ? absolute.slice(root.length + 1)
        : null
  })
  return (path) =>
    prefixes.some(
      (prefix) =>
        prefix !== null && (prefix === '' || path === prefix || path.startsWith(prefix + '/')),
    )
}

function splitPaths(args: string[]): { flags: string[]; rest: string[]; paths: string[] | null } {
  const separator = args.indexOf('--')
  const own = separator < 0 ? args : args.slice(0, separator)
  return {
    flags: own.filter((arg) => arg.startsWith('-')),
    rest: own.filter((arg) => !arg.startsWith('-')),
    paths: separator < 0 ? null : args.slice(separator + 1),
  }
}

async function gitInit(ctx: CommandContext, args: string[]): Promise<number> {
  let branch = 'main'
  const operands: string[] = []
  let quiet = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-b' || arg === '--initial-branch') branch = args[++i] ?? branch
    else if (arg.startsWith('--initial-branch=')) branch = arg.slice(17)
    else if (arg === '-q' || arg === '--quiet') quiet = true
    else if (!arg.startsWith('-')) operands.push(arg)
  }
  const root = ctx.resolve(operands[0] ?? '.')
  await mkdirTree(ctx.fs, root + '/.git/objects')
  const existing = await ctx.fs.stat(root + '/' + MARKER)
  if (!existing) {
    const snapshot: Snapshot = {
      repository: '',
      url: '',
      ref: '',
      branch,
      commit: null,
      author: null,
      date: null,
      message: null,
      cloned: new Date().toISOString(),
      files: {},
      local: { branch, head: null, branches: {}, commits: {}, index: {}, stat: {} },
    }
    await save(ctx, { root, snapshot, local: snapshot.local! })
  }
  if (!quiet)
    ctx.stdout.write(
      (existing ? 'Reinitialized existing' : 'Initialized empty') +
        ' Git repository in ' +
        root +
        '/.git/\n',
    )
  return 0
}

async function mkdirTree(fs: FileSystem, path: string): Promise<void> {
  const stat = await fs.stat(path)
  if (stat) return
  await mkdirTree(fs, parentOf(path))
  await fs.mkdir(path)
}

async function gitAdd(ctx: CommandContext, args: string[]): Promise<number> {
  const repo = await open(ctx)
  const { flags, rest, paths } = splitPaths(args)
  const all = flags.some((flag) => flag === '-A' || flag === '--all')
  const update = flags.some((flag) => flag === '-u' || flag === '--update')
  const specs = [...rest, ...(paths ?? [])]
  if (!specs.length && !all && !update) {
    ctx.stderr.write(
      "Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\n",
    )
    return 0
  }
  const { head, index, present } = await state(ctx, repo)
  const inScope = scoped(
    ctx,
    repo.root,
    all && !specs.length ? [repo.root] : update && !specs.length ? [ctx.cwd] : specs,
  )
  let matched = 0
  for (const path of new Set([...present, ...index.keys()])) {
    if (!inScope(path) || (update && !index.has(path))) continue
    matched++
    const id = present.has(path) ? await hashWork(ctx, repo, path, true) : null
    if (id !== null && id.startsWith('base:')) continue
    stage(repo, head, path, id)
  }
  if (!matched && specs.length)
    throw new CommandError("fatal: pathspec '" + specs[0] + "' did not match any files", 128)
  await save(ctx, repo)
  return 0
}

function stage(repo: Repo, head: Map<string, string>, path: string, id: string | null): void {
  if ((head.get(path) ?? null) === id) delete repo.local.index[path]
  else repo.local.index[path] = id
}

async function gitRm(ctx: CommandContext, args: string[]): Promise<number> {
  const repo = await open(ctx)
  const { flags, rest, paths } = splitPaths(args)
  const cached = flags.includes('--cached')
  const head = treeAt(repo, repo.local.head)
  const index = indexTree(repo, head)
  const inScope = scoped(ctx, repo.root, [...rest, ...(paths ?? [])])
  let matched = 0
  for (const path of [...index.keys()].filter(inScope)) {
    matched++
    stage(repo, head, path, null)
    if (!cached) await ctx.fs.remove(repo.root + '/' + path).catch(() => {})
    if (!flags.includes('-q')) ctx.stdout.write("rm '" + path + "'\n")
  }
  if (!matched)
    throw new CommandError("fatal: pathspec '" + (rest[0] ?? '') + "' did not match any files", 128)
  await save(ctx, repo)
  return 0
}

function authorOf(ctx: CommandContext, repo: Repo): string {
  const name = ctx.env['GIT_AUTHOR_NAME'] ?? repo.local.config?.['user.name'] ?? 'nanocode'
  const email =
    ctx.env['GIT_AUTHOR_EMAIL'] ?? repo.local.config?.['user.email'] ?? 'nanocode@localhost'
  return name + ' <' + email + '>'
}

async function commitId(commit: Commit): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-1', new Uint8Array(encode(JSON.stringify(commit)))),
    ),
  )
}

async function gitCommit(ctx: CommandContext, args: string[]): Promise<number> {
  const repo = await open(ctx)
  const messages: string[] = []
  let all = false
  let allowEmpty = false
  let amend = false
  let quiet = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-m' || arg === '--message') messages.push(args[++i] ?? '')
    else if (arg.startsWith('--message=')) messages.push(arg.slice(10))
    else if (/^-[a-zA-Z]*m$/.test(arg) && arg.length > 2) {
      if (arg.includes('a')) all = true
      if (arg.includes('q')) quiet = true
      messages.push(args[++i] ?? '')
    } else if (/^-m./.test(arg)) messages.push(arg.slice(2))
    else if (arg === '-a' || arg === '--all') all = true
    else if (/^-[aq]+$/.test(arg)) {
      if (arg.includes('a')) all = true
      if (arg.includes('q')) quiet = true
    } else if (arg === '--allow-empty') allowEmpty = true
    else if (arg === '--amend') amend = true
    else if (arg === '-q' || arg === '--quiet') quiet = true
  }
  if (all) {
    const { head, index, present } = await state(ctx, repo)
    for (const path of index.keys())
      stage(repo, head, path, present.has(path) ? await hashWork(ctx, repo, path, true) : null)
  }
  const parentId = amend
    ? repo.local.head
      ? repo.local.commits[repo.local.head]!.parent
      : null
    : repo.local.head
  if (amend && !repo.local.head) throw new CommandError('fatal: You have nothing to amend.', 128)
  const base = treeAt(repo, parentId)
  const target = indexTree(repo, treeAt(repo, repo.local.head))
  const changes: Record<string, string | null> = {}
  for (const path of new Set([...base.keys(), ...target.keys()]))
    if (base.get(path) !== target.get(path)) changes[path] = target.get(path) ?? null
  const count = Object.keys(changes).length
  if (!count && !allowEmpty && !amend) {
    const { unstaged, untracked } = await state(ctx, repo)
    await save(ctx, repo)
    ctx.stdout.write(
      'On branch ' +
        (repo.local.branch ?? 'HEAD') +
        '\n' +
        (unstaged.size
          ? 'no changes added to commit (use "git add" and/or "git commit -a")\n'
          : untracked.length
            ? 'nothing added to commit but untracked files present (use "git add" to track)\n'
            : 'nothing to commit, working tree clean\n'),
    )
    return 1
  }
  const message = messages.length
    ? messages.join('\n\n')
    : amend && repo.local.head
      ? repo.local.commits[repo.local.head]!.message
      : ''
  if (!message.trim())
    throw new CommandError(
      'error: commit message is empty; pass -m MESSAGE (this shell has no editor)',
      1,
    )
  const commit: Commit = {
    parent: parentId,
    message,
    author: authorOf(ctx, repo),
    date: new Date().toISOString(),
    changes,
  }
  const id = await commitId(commit)
  repo.local.commits[id] = commit
  repo.local.head = id
  if (repo.local.branch) repo.local.branches[repo.local.branch] = id
  repo.local.index = {}
  await save(ctx, repo)
  if (!quiet) {
    const added = Object.entries(changes).filter(
      ([path, ref]) => ref !== null && !base.has(path),
    ).length
    const deleted = Object.values(changes).filter((ref) => ref === null).length
    ctx.stdout.write(
      '[' +
        (repo.local.branch ?? 'detached HEAD') +
        (parentId === null && !repo.snapshot.commit ? ' (root-commit)' : '') +
        ' ' +
        id.slice(0, 7) +
        '] ' +
        message.split('\n')[0] +
        '\n ' +
        count +
        ' file' +
        (count === 1 ? '' : 's') +
        ' changed' +
        (added ? ', ' + added + ' added' : '') +
        (deleted ? ', ' + deleted + ' deleted' : '') +
        '\n',
    )
  }
  return 0
}

async function gitStatus(ctx: CommandContext, args: string[]): Promise<number> {
  const repo = await open(ctx)
  const found = await state(ctx, repo)
  await save(ctx, repo)
  const show = (path: string) => relativeTo(ctx, repo.root, path)
  if (
    args.includes('-s') ||
    args.includes('--short') ||
    args.some((arg) => arg.startsWith('--porcelain'))
  ) {
    if (args.includes('-b') || args.includes('--branch'))
      ctx.stdout.write('## ' + (repo.local.branch ?? 'HEAD (no branch)') + '\n')
    for (const path of [...new Set([...found.staged.keys(), ...found.unstaged.keys()])].sort())
      ctx.stdout.write(
        (found.staged.get(path) ?? ' ') +
          (found.unstaged.get(path) ?? ' ') +
          ' ' +
          show(path) +
          '\n',
      )
    for (const path of found.untracked) ctx.stdout.write('?? ' + show(path) + '\n')
    return 0
  }
  const ahead = chain(repo.local, repo.local.head).length
  ctx.stdout.write(
    repo.local.branch
      ? 'On branch ' + repo.local.branch + '\n'
      : 'HEAD detached at ' + shortOf(repo, repo.local.head) + '\n',
  )
  if (repo.local.branch && repo.snapshot.repository && repo.snapshot.branch)
    ctx.stdout.write(
      ahead
        ? "Your branch is ahead of 'origin/" +
            repo.snapshot.branch +
            "' by " +
            ahead +
            ' commit' +
            (ahead === 1 ? '' : 's') +
            '.\n'
        : "Your branch is up to date with 'origin/" + repo.snapshot.branch + "'.\n",
    )
  if (!repo.snapshot.repository && !repo.local.head) ctx.stdout.write('\nNo commits yet\n')
  const label = { A: 'new file:   ', M: 'modified:   ', D: 'deleted:    ' }
  if (found.staged.size) {
    ctx.stdout.write('\nChanges to be committed:\n')
    for (const [path, kind] of [...found.staged].sort())
      ctx.stdout.write('\t' + label[kind] + show(path) + '\n')
  }
  if (found.unstaged.size) {
    ctx.stdout.write('\nChanges not staged for commit:\n')
    for (const [path, kind] of [...found.unstaged].sort())
      ctx.stdout.write('\t' + label[kind] + show(path) + '\n')
  }
  if (found.untracked.length) {
    ctx.stdout.write('\nUntracked files:\n')
    for (const path of found.untracked) ctx.stdout.write('\t' + show(path) + '\n')
  }
  if (!found.staged.size && !found.unstaged.size && !found.untracked.length)
    ctx.stdout.write('\nnothing to commit, working tree clean\n')
  else if (!found.staged.size)
    ctx.stdout.write(
      '\n' +
        (found.unstaged.size
          ? 'no changes added to commit (use "git add" and/or "git commit -a")'
          : 'nothing added to commit but untracked files present (use "git add" to track)') +
        '\n',
    )
  return 0
}

type Side = { ref: string | null; work?: boolean }

async function sideText(
  ctx: CommandContext,
  repo: Repo,
  path: string,
  side: Side,
): Promise<Uint8Array | null> {
  if (side.work) {
    const full = repo.root + '/' + path
    return (await ctx.fs.stat(full))?.kind === 'file' ? ctx.fs.read(full) : null
  }
  return side.ref === null ? null : content(ctx, repo, side.ref)
}

async function patch(
  ctx: CommandContext,
  repo: Repo,
  pairs: [string, Side, Side][],
  mode: 'patch' | 'stat' | 'name-only' | 'name-status' | 'quiet',
): Promise<number> {
  const tmp = '/tmp/.git-diff-' + Math.random().toString(36).slice(2)
  let changed = 0
  const stats: [string, number, number][] = []
  for (const [path, a, b] of pairs.sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (!a.work && !b.work && a.ref === b.ref) continue
    const left = await sideText(ctx, repo, path, a)
    const right = await sideText(ctx, repo, path, b)
    if (
      left &&
      right &&
      left.length === right.length &&
      left.every((value, i) => value === right[i])
    )
      continue
    changed++
    if (mode === 'quiet') continue
    if (mode === 'name-only') {
      ctx.stdout.write(relativeTo(ctx, repo.root, path) + '\n')
      continue
    }
    if (mode === 'name-status') {
      ctx.stdout.write(
        (left === null ? 'A' : right === null ? 'D' : 'M') +
          '\t' +
          relativeTo(ctx, repo.root, path) +
          '\n',
      )
      continue
    }
    await mkdirTree(ctx.fs, tmp)
    if (left) await ctx.fs.write(tmp + '/a', left)
    if (right) await ctx.fs.write(tmp + '/b', right)
    const argv = [
      'diff',
      '-u',
      '--label',
      left ? 'a/' + path : '/dev/null',
      '--label',
      right ? 'b/' + path : '/dev/null',
      left ? tmp + '/a' : '/dev/null',
      right ? tmp + '/b' : '/dev/null',
    ]
    if (mode === 'stat') {
      const out = await ctx.exec(
        argv.map((arg) => "'" + arg.replace(/'/g, "'\\''") + "'").join(' '),
      )
      const lines = out.stdout.split('\n').slice(2)
      stats.push([
        path,
        lines.filter((line) => line.startsWith('+')).length,
        lines.filter((line) => line.startsWith('-')).length,
      ])
    } else {
      ctx.stdout.write(
        'diff --git a/' +
          path +
          ' b/' +
          path +
          '\n' +
          (left === null
            ? 'new file mode 100644\n'
            : right === null
              ? 'deleted file mode 100644\n'
              : ''),
      )
      await ctx.run(argv)
    }
    await ctx.fs.remove(tmp + '/a').catch(() => {})
    await ctx.fs.remove(tmp + '/b').catch(() => {})
  }
  await ctx.fs.remove(tmp).catch(() => {})
  if (mode === 'stat' && stats.length) {
    const width = Math.max(...stats.map(([path]) => path.length))
    for (const [path, plus, minus] of stats)
      ctx.stdout.write(
        ' ' +
          path.padEnd(width) +
          ' | ' +
          String(plus + minus).padStart(4) +
          ' ' +
          '+'.repeat(Math.min(plus, 40)) +
          '-'.repeat(Math.min(minus, 40)) +
          '\n',
      )
    const plus = stats.reduce((sum, item) => sum + item[1], 0)
    const minus = stats.reduce((sum, item) => sum + item[2], 0)
    ctx.stdout.write(
      ' ' +
        stats.length +
        ' file' +
        (stats.length === 1 ? '' : 's') +
        ' changed, ' +
        plus +
        ' insertion' +
        (plus === 1 ? '' : 's') +
        '(+), ' +
        minus +
        ' deletion' +
        (minus === 1 ? '' : 's') +
        '(-)\n',
    )
  }
  return changed
}

function diffMode(flags: string[]): 'patch' | 'stat' | 'name-only' | 'name-status' | 'quiet' {
  return flags.includes('--stat') || flags.includes('--shortstat')
    ? 'stat'
    : flags.includes('--name-only')
      ? 'name-only'
      : flags.includes('--name-status')
        ? 'name-status'
        : flags.includes('--quiet')
          ? 'quiet'
          : 'patch'
}

async function gitDiff(ctx: CommandContext, args: string[]): Promise<number> {
  const repo = await open(ctx)
  const { flags, rest, paths } = splitPaths(args)
  const revs: (string | null)[] = []
  const specs = [...(paths ?? [])]
  for (const arg of rest) {
    const range = arg.includes('..') ? arg.split(/\.\.\.?/) : [arg]
    const resolved = range.map((part) => resolveRev(repo, part || 'HEAD'))
    if (resolved.every((id) => id !== undefined)) revs.push(...(resolved as (string | null)[]))
    else specs.push(arg)
  }
  const inScope = scoped(ctx, repo.root, specs)
  const cached = flags.includes('--cached') || flags.includes('--staged')
  const head = treeAt(repo, repo.local.head)
  let left: Map<string, string>
  let right: Map<string, string> | 'work'
  if (revs.length >= 2) {
    left = treeAt(repo, revs[0]!)
    right = treeAt(repo, revs[1]!)
  } else if (cached) {
    left = revs.length ? treeAt(repo, revs[0]!) : head
    right = indexTree(repo, head)
  } else {
    left = revs.length ? treeAt(repo, revs[0]!) : indexTree(repo, head)
    right = 'work'
  }
  const pairs: [string, Side, Side][] = []
  if (right === 'work') {
    const found = await state(ctx, repo)
    for (const path of new Set([...left.keys(), ...(revs.length ? [...found.index.keys()] : [])])) {
      if (!inScope(path)) continue
      const work = found.present.has(path) ? await hashWork(ctx, repo, path, false) : null
      if (work === (left.get(path) ?? null)) continue
      pairs.push([path, { ref: left.get(path) ?? null }, { ref: null, work: true }])
    }
  } else {
    const r = right
    for (const path of new Set([...left.keys(), ...r.keys()]))
      if (inScope(path) && left.get(path) !== r.get(path))
        pairs.push([path, { ref: left.get(path) ?? null }, { ref: r.get(path) ?? null }])
  }
  const changed = await patch(ctx, repo, pairs, diffMode(flags))
  await save(ctx, repo)
  return (flags.includes('--exit-code') || flags.includes('--quiet')) && changed ? 1 : 0
}

async function gitLog(ctx: CommandContext, args: string[], show: boolean): Promise<number> {
  const repo = await open(ctx)
  const { flags, rest } = splitPaths(args)
  let limit = Infinity
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (/^-\d+$/.test(arg)) limit = Number(arg.slice(1))
    else if (arg === '-n' || arg === '--max-count') limit = Number(args[i + 1])
    else if (arg.startsWith('--max-count=')) limit = Number(arg.slice(12))
    else if (/^-n\d+$/.test(arg)) limit = Number(arg.slice(2))
  }
  const revArg = rest.find((arg) => resolveRev(repo, arg) !== undefined && !/^\d+$/.test(arg))
  const start = revArg ? resolveRev(repo, revArg)! : repo.local.head
  if (show) limit = 1
  if (!repo.snapshot.repository && !start)
    throw new CommandError(
      "fatal: your current branch '" +
        (repo.local.branch ?? 'HEAD') +
        "' does not have any commits yet",
      128,
    )
  const format = args
    .find((arg) => arg.startsWith('--format=') || arg.startsWith('--pretty='))
    ?.replace(/^--(?:format|pretty)=(?:format:|tformat:)?/, '')
  const oneline = flags.includes('--oneline') || format === 'oneline'
  const ids = chain(repo.local, start).reverse()
  const entries: {
    id: string
    commit: { message: string; author: string | null; date: string | null }
    parent: string | null
    local: boolean
  }[] = ids.map((id) => ({
    id,
    commit: repo.local.commits[id]!,
    parent: repo.local.commits[id]!.parent,
    local: true,
  }))
  if (repo.snapshot.repository)
    entries.push({
      id: repo.snapshot.commit ?? '0000000000000000000000000000000000000000',
      commit: {
        message: repo.snapshot.message ?? '(commit message unavailable)',
        author: repo.snapshot.author,
        date: repo.snapshot.date,
      },
      parent: null,
      local: false,
    })
  let shown = 0
  for (const entry of entries) {
    if (shown >= limit) break
    shown++
    const decorations = [
      entry.id === (start ?? repo.snapshot.commit) && !revArg
        ? 'HEAD' + (repo.local.branch ? ' -> ' + repo.local.branch : '')
        : '',
      ...Object.entries(repo.local.branches)
        .filter(
          ([name, id]) => (id ?? repo.snapshot.commit) === entry.id && name !== repo.local.branch,
        )
        .map(([name]) => name),
      !entry.local && repo.snapshot.branch ? 'origin/' + repo.snapshot.branch : '',
    ].filter(Boolean)
    const decoration = decorations.length ? ' (' + decorations.join(', ') + ')' : ''
    const subject = entry.commit.message.split('\n')[0]
    if (format && format !== 'oneline') {
      ctx.stdout.write(
        format
          .replace(/%H/g, entry.id)
          .replace(/%h/g, entry.id.slice(0, 7))
          .replace(/%s/g, subject ?? '')
          .replace(/%an/g, (entry.commit.author ?? '').replace(/ <.*$/, ''))
          .replace(/%ae/g, /<(.*)>/.exec(entry.commit.author ?? '')?.[1] ?? '')
          .replace(/%ad|%ai|%aI|%cd/g, entry.commit.date ?? '')
          .replace(/%n/g, '\n') + '\n',
      )
    } else if (oneline)
      ctx.stdout.write(
        (flags.includes('--oneline') ? entry.id.slice(0, 7) : entry.id) +
          decoration +
          ' ' +
          subject +
          '\n',
      )
    else {
      ctx.stdout.write('commit ' + entry.id + decoration + '\n')
      if (entry.commit.author) ctx.stdout.write('Author: ' + entry.commit.author + '\n')
      if (entry.commit.date)
        ctx.stdout.write('Date:   ' + new Date(entry.commit.date).toUTCString() + '\n')
      ctx.stdout.write(
        '\n' +
          entry.commit.message
            .split('\n')
            .map((line) => '    ' + line)
            .join('\n') +
          '\n',
      )
      if (show || flags.includes('-p') || flags.includes('--stat')) {
        if (entry.local) {
          const before = treeAt(repo, entry.parent)
          const after = treeAt(repo, entry.id)
          const pairs: [string, Side, Side][] = Object.keys(
            repo.local.commits[entry.id]!.changes,
          ).map((path) => [
            path,
            { ref: before.get(path) ?? null },
            { ref: after.get(path) ?? null },
          ])
          ctx.stdout.write('\n')
          await patch(
            ctx,
            repo,
            pairs,
            flags.includes('--stat')
              ? 'stat'
              : flags.includes('--name-only')
                ? 'name-only'
                : 'patch',
          )
        } else if (show)
          ctx.stderr.write('(source snapshot: the changes of this commit are not available)\n')
      }
      if (shown < Math.min(limit, entries.length)) ctx.stdout.write('\n')
    }
  }
  return 0
}

async function writeTree(
  ctx: CommandContext,
  repo: Repo,
  from: Map<string, string>,
  to: Map<string, string>,
  only?: (path: string) => boolean,
): Promise<void> {
  for (const path of new Set([...from.keys(), ...to.keys()])) {
    if (only && !only(path)) continue
    const ref = to.get(path)
    const full = repo.root + '/' + path
    if (ref === undefined) {
      await ctx.fs.remove(full).catch(() => {})
      delete repo.local.stat[path]
      continue
    }
    if (from.get(path) === ref && (await hashWork(ctx, repo, path, false)) === ref) continue
    const data = await content(ctx, repo, ref)
    await mkdirTree(ctx.fs, parentOf(full))
    await ctx.fs.write(full, data)
    const stat = await ctx.fs.stat(full)
    if (stat && !ref.startsWith('base:')) repo.local.stat[path] = [stat.size, stat.mtime, ref]
  }
}

async function switchTo(
  ctx: CommandContext,
  repo: Repo,
  id: string | null,
  branch: string | null,
  force: boolean,
): Promise<void> {
  const found = await state(ctx, repo)
  const target = treeAt(repo, id)
  const current = found.index
  if (!force) {
    const blocked = [...new Set([...current.keys(), ...target.keys()])].filter(
      (path) =>
        current.get(path) !== target.get(path) &&
        (found.unstaged.has(path) || found.staged.has(path)),
    )
    if (blocked.length)
      throw new CommandError(
        'error: Your local changes to the following files would be overwritten by checkout:\n' +
          blocked.map((path) => '\t' + path).join('\n') +
          '\nPlease commit your changes or stash them before you switch branches.\nAborting',
        1,
      )
  }
  await writeTree(ctx, repo, force ? found.head : current, target)
  if (force) repo.local.index = {}
  repo.local.head = id
  repo.local.branch = branch
}

async function gitCheckout(ctx: CommandContext, args: string[], command: string): Promise<number> {
  const repo = await open(ctx)
  const { flags, rest, paths } = splitPaths(args)
  const create = args.find(
    (arg, i) =>
      (arg === '-b' || arg === '-B' || arg === '-c' || arg === '-C' || arg === '--create') &&
      args[i + 1],
  )
    ? args[
        args.findIndex(
          (arg) =>
            arg === '-b' || arg === '-B' || arg === '-c' || arg === '-C' || arg === '--create',
        ) + 1
      ]!
    : undefined
  const force = flags.includes('-f') || flags.includes('--force')
  const operands = rest.filter((arg) => arg !== create)
  if (create !== undefined) {
    if (Object.hasOwn(repo.local.branches, create) && !args.includes('-B') && !args.includes('-C'))
      throw new CommandError("fatal: a branch named '" + create + "' already exists", 128)
    const start = operands[0] === undefined ? repo.local.head : resolveRev(repo, operands[0])
    if (start === undefined)
      throw new CommandError(
        "fatal: '" +
          operands[0] +
          "' is not a commit and a branch '" +
          create +
          "' cannot be created from it",
        128,
      )
    if (start !== repo.local.head) await switchTo(ctx, repo, start, create, force)
    repo.local.branches[create] = start
    repo.local.branch = create
    await save(ctx, repo)
    ctx.stderr.write("Switched to a new branch '" + create + "'\n")
    return 0
  }
  const revision =
    operands[0] !== undefined && paths === null ? resolveRev(repo, operands[0]) : undefined
  if (operands.length === 1 && paths === null && revision !== undefined && command !== 'restore') {
    const name = operands[0]!
    const branch = Object.hasOwn(repo.local.branches, name) ? name : null
    await switchTo(ctx, repo, revision, branch, force)
    await save(ctx, repo)
    ctx.stderr.write(
      branch
        ? branch === name && repo.local.head === revision
          ? "Switched to branch '" + branch + "'\n"
          : ''
        : "Note: switching to '" +
            name +
            "'.\n\nYou are in 'detached HEAD' state.\nHEAD is now at " +
            shortOf(repo, revision) +
            '\n',
    )
    return 0
  }
  if (command === 'switch')
    throw new CommandError('fatal: invalid reference: ' + (operands[0] ?? ''), 128)
  const source =
    args.find((arg) => arg.startsWith('--source='))?.slice(9) ?? args[args.indexOf('-s') + 1]
  const from =
    command === 'checkout' && paths !== null && operands[0] !== undefined
      ? operands[0]
      : args.includes('-s') || args.some((arg) => arg.startsWith('--source='))
        ? source
        : undefined
  const specs = paths ?? operands
  if (!specs.length) throw new CommandError('fatal: you must specify path(s) to restore', 128)
  const inScope = scoped(
    ctx,
    repo.root,
    from !== undefined && command === 'checkout' ? (paths ?? []) : specs,
  )
  const head = treeAt(repo, repo.local.head)
  if (command === 'restore' && (flags.includes('--staged') || flags.includes('-S'))) {
    const tree = from !== undefined ? treeAt(repo, resolveRev(repo, from) ?? null) : head
    for (const path of Object.keys(repo.local.index))
      if (inScope(path)) stage(repo, head, path, tree.get(path) ?? null)
    if (!flags.includes('--worktree') && !flags.includes('-W')) {
      await save(ctx, repo)
      return 0
    }
  }
  let tree = indexTree(repo, head)
  if (from !== undefined) {
    const id = resolveRev(repo, from)
    if (id === undefined) throw new CommandError('fatal: invalid reference: ' + from, 128)
    tree = treeAt(repo, id)
    if (command === 'checkout')
      for (const path of tree.keys()) if (inScope(path)) stage(repo, head, path, tree.get(path)!)
  }
  const matches = [...tree.keys()].filter(inScope)
  if (!matches.length)
    throw new CommandError(
      "error: pathspec '" + specs[0] + "' did not match any file(s) known to git",
      1,
    )
  const present = await worktree(ctx, repo)
  const work = new Map<string, string>()
  for (const path of matches)
    if (present.has(path)) work.set(path, (await hashWork(ctx, repo, path, false)) ?? '')
  await writeTree(ctx, repo, work, tree, inScope)
  await save(ctx, repo)
  if (command === 'checkout' && !flags.includes('-q') && !flags.includes('--quiet'))
    ctx.stderr.write(
      'Updated ' +
        matches.length +
        ' path' +
        (matches.length === 1 ? '' : 's') +
        ' from ' +
        (from === undefined ? 'the index' : from) +
        '\n',
    )
  return 0
}

async function gitReset(ctx: CommandContext, args: string[]): Promise<number> {
  const repo = await open(ctx)
  const { flags, rest, paths } = splitPaths(args)
  const head = treeAt(repo, repo.local.head)
  const rev = rest[0] !== undefined ? resolveRev(repo, rest[0]) : undefined
  const specs = [...(rev === undefined ? rest : rest.slice(1)), ...(paths ?? [])]
  if (specs.length) {
    const tree = rev !== undefined ? treeAt(repo, rev) : head
    const inScope = scoped(ctx, repo.root, specs)
    for (const path of new Set([...Object.keys(repo.local.index), ...tree.keys()]))
      if (inScope(path)) stage(repo, head, path, tree.get(path) ?? null)
    await save(ctx, repo)
    return 0
  }
  const target = rev === undefined ? repo.local.head : rev
  if (rest[0] !== undefined && rev === undefined)
    throw new CommandError(
      "fatal: ambiguous argument '" +
        rest[0] +
        "': unknown revision or path not in the working tree.",
      128,
    )
  if (flags.includes('--hard')) {
    const found = await state(ctx, repo)
    const tree = treeAt(repo, target)
    const work = new Map<string, string>()
    for (const path of new Set([...found.index.keys(), ...tree.keys()]))
      if (found.present.has(path)) work.set(path, (await hashWork(ctx, repo, path, false)) ?? '')
    await writeTree(ctx, repo, work, tree)
    for (const path of found.index.keys())
      if (!tree.has(path)) await ctx.fs.remove(repo.root + '/' + path).catch(() => {})
  }
  if (!flags.includes('--soft')) repo.local.index = {}
  else {
    const old = indexTree(repo, head)
    const next = treeAt(repo, target)
    repo.local.index = {}
    for (const path of new Set([...old.keys(), ...next.keys()]))
      if (old.get(path) !== next.get(path)) repo.local.index[path] = old.get(path) ?? null
  }
  repo.local.head = target
  if (repo.local.branch) repo.local.branches[repo.local.branch] = target
  await save(ctx, repo)
  if (flags.includes('--hard'))
    ctx.stdout.write(
      'HEAD is now at ' +
        shortOf(repo, target) +
        ' ' +
        (target
          ? repo.local.commits[target]!.message.split('\n')[0]
          : (repo.snapshot.message?.split('\n')[0] ?? '')) +
        '\n',
    )
  return 0
}

async function gitBranch(ctx: CommandContext, args: string[]): Promise<number> {
  const repo = await open(ctx)
  const { flags, rest } = splitPaths(args)
  if (flags.includes('--show-current')) {
    ctx.stdout.write((repo.local.branch ?? '') + '\n')
    return 0
  }
  if (flags.includes('-d') || flags.includes('-D') || flags.includes('--delete')) {
    for (const name of rest) {
      if (!Object.hasOwn(repo.local.branches, name))
        throw new CommandError("error: branch '" + name + "' not found", 1)
      if (name === repo.local.branch)
        throw new CommandError(
          "error: cannot delete branch '" + name + "' used by the working tree",
          1,
        )
      ctx.stdout.write(
        'Deleted branch ' + name + ' (was ' + shortOf(repo, repo.local.branches[name]!) + ').\n',
      )
      delete repo.local.branches[name]
    }
    await save(ctx, repo)
    return 0
  }
  if ((flags.includes('-m') || flags.includes('-M')) && rest.length) {
    const [from, to] = rest.length === 1 ? [repo.local.branch!, rest[0]!] : [rest[0]!, rest[1]!]
    repo.local.branches[to] = repo.local.branches[from] ?? repo.local.head
    delete repo.local.branches[from]
    if (repo.local.branch === from) repo.local.branch = to
    await save(ctx, repo)
    return 0
  }
  if (rest.length) {
    const start = rest[1] !== undefined ? resolveRev(repo, rest[1]) : repo.local.head
    if (start === undefined)
      throw new CommandError("fatal: not a valid object name: '" + rest[1] + "'", 128)
    if (Object.hasOwn(repo.local.branches, rest[0]!))
      throw new CommandError("fatal: a branch named '" + rest[0] + "' already exists", 128)
    repo.local.branches[rest[0]!] = start
    await save(ctx, repo)
    return 0
  }
  if (!repo.local.branch)
    ctx.stdout.write('* (HEAD detached at ' + shortOf(repo, repo.local.head) + ')\n')
  for (const name of Object.keys(repo.local.branches).sort())
    ctx.stdout.write(
      (name === repo.local.branch ? '* ' : '  ') +
        name +
        (flags.includes('-v') || flags.includes('-vv')
          ? ' ' + shortOf(repo, repo.local.branches[name]!)
          : '') +
        '\n',
    )
  if (
    (flags.includes('-a') || flags.includes('-r')) &&
    repo.snapshot.branch &&
    repo.snapshot.repository
  )
    ctx.stdout.write('  remotes/origin/' + repo.snapshot.branch + '\n')
  return 0
}

async function gitRevParse(ctx: CommandContext, args: string[]): Promise<number> {
  const repo = await open(ctx)
  for (const arg of args.length ? args : ['HEAD']) {
    if (arg === '--show-toplevel') ctx.stdout.write(repo.root + '\n')
    else if (arg === '--abbrev-ref' || arg === '--short' || arg === '--verify' || arg === '-q')
      continue
    else if (arg === '--is-inside-work-tree') ctx.stdout.write('true\n')
    else if (arg === '--git-dir') ctx.stdout.write(relativeTo(ctx, repo.root, '.git') + '\n')
    else {
      const id = resolveRev(repo, arg)
      if (id === undefined)
        throw new CommandError(
          "fatal: ambiguous argument '" +
            arg +
            "': unknown revision or path not in the working tree.",
          128,
        )
      if (args.includes('--abbrev-ref')) {
        ctx.stdout.write(
          (arg === 'HEAD' || arg === '@' ? (repo.local.branch ?? 'HEAD') : arg) + '\n',
        )
        continue
      }
      const full = id ?? repo.snapshot.commit
      if (!full)
        throw new CommandError(
          "fatal: ambiguous argument '" + arg + "': unknown revision (no commits yet)",
          128,
        )
      ctx.stdout.write((args.includes('--short') ? full.slice(0, 7) : full) + '\n')
    }
  }
  return 0
}

async function gitLsFiles(ctx: CommandContext): Promise<number> {
  const repo = await open(ctx)
  const tree = indexTree(repo, treeAt(repo, repo.local.head))
  const base =
    ctx.cwd === repo.root
      ? ''
      : ctx.cwd.startsWith(repo.root + '/')
        ? ctx.cwd.slice(repo.root.length + 1) + '/'
        : null
  for (const path of [...tree.keys()].sort())
    if (base === null || path.startsWith(base))
      ctx.stdout.write(relativeTo(ctx, repo.root, path) + '\n')
  return 0
}

async function gitConfig(ctx: CommandContext, args: string[]): Promise<number> {
  const operands = args.filter((arg) => !arg.startsWith('-'))
  const repo = await open(ctx).catch(() => null)
  const config = repo?.local.config ?? {}
  if (operands.length >= 2) {
    if (!repo) return 0
    repo.local.config = { ...config, [operands[0]!]: operands.slice(1).join(' ') }
    await save(ctx, repo)
    return 0
  }
  const value =
    operands[0] === undefined
      ? undefined
      : (config[operands[0]] ??
        (operands[0] === 'user.name'
          ? 'nanocode'
          : operands[0] === 'user.email'
            ? 'nanocode@localhost'
            : operands[0] === 'remote.origin.url'
              ? repo?.snapshot.url
              : undefined))
  if (args.includes('--list') || args.includes('-l')) {
    for (const [key, entry] of Object.entries(config)) ctx.stdout.write(key + '=' + entry + '\n')
    return 0
  }
  if (value === undefined) return 1
  ctx.stdout.write(value + '\n')
  return 0
}

async function gitMv(ctx: CommandContext, args: string[]): Promise<number> {
  const operands = args.filter((arg) => !arg.startsWith('-'))
  if (operands.length !== 2) throw new CommandError('usage: git mv <source> <destination>', 129)
  const status = await ctx.run(['mv', operands[0]!, operands[1]!])
  if (status) return status
  return gitAdd(ctx, ['-A', '--', operands[0]!, operands[1]!])
}

async function git(ctx: CommandContext, github: GitHub.Options, args: string[]): Promise<number> {
  let i = 0
  while (
    i < args.length &&
    args[i].startsWith('-') &&
    args[i] !== '--version' &&
    args[i] !== '--help'
  ) {
    if (args[i] === '-C') {
      const dir = args[i + 1]
      if (dir === undefined) throw new CommandError("fatal: option '-C' requires a value", 129)
      const cwd = ctx.resolve(dir)
      ctx = {
        ...ctx,
        cwd,
        resolve: (path) => normalize(path.startsWith('/') ? path : cwd + '/' + path),
      }
      i += 2
    } else if (args[i] === '-c') i += 2
    else i++
  }
  const command = args[i]
  const rest = args.slice(i + 1)
  switch (command) {
    case '--version':
    case 'version':
      ctx.stdout.write('git version 2.47.0 (nanocode snapshot git)\n')
      return 0
    case 'clone':
      return clone(ctx, github, rest)
    case 'init':
      return gitInit(ctx, rest)
    case 'status':
      return gitStatus(ctx, rest)
    case 'add':
      return gitAdd(ctx, rest)
    case 'rm':
      return gitRm(ctx, rest)
    case 'mv':
      return gitMv(ctx, rest)
    case 'commit':
      return gitCommit(ctx, rest)
    case 'apply':
      return gitApply(ctx, rest)
    case 'diff':
      return gitDiff(ctx, rest)
    case 'log':
      return gitLog(ctx, rest, false)
    case 'show':
      return gitLog(ctx, rest, true)
    case 'checkout':
    case 'switch':
    case 'restore':
      return gitCheckout(ctx, rest, command)
    case 'reset':
      return gitReset(ctx, rest)
    case 'branch':
      return gitBranch(ctx, rest)
    case 'rev-parse':
      return gitRevParse(ctx, rest)
    case 'config':
      return gitConfig(ctx, rest)
    case 'remote': {
      const { snapshot } = await locate(ctx)
      if (rest[0] === 'get-url') ctx.stdout.write(snapshot.url + '\n')
      else if (rest.includes('-v'))
        ctx.stdout.write(
          'origin\t' + snapshot.url + ' (fetch)\norigin\t' + snapshot.url + ' (push)\n',
        )
      else ctx.stdout.write('origin\n')
      return 0
    }
    case 'describe': {
      const { snapshot } = await locate(ctx)
      if (!snapshot.commit)
        throw new CommandError('fatal: No names found, cannot describe anything.', 128)
      ctx.stdout.write(snapshot.commit.slice(0, 7) + '\n')
      return 0
    }
    case 'ls-files':
      return gitLsFiles(ctx)
    case undefined:
    case 'help':
    case '--help':
      ctx.stdout.write(
        'usage: git <command> [<args>]\n\nThis git downloads GitHub source snapshots (no earlier history) and records local commits, branches and diffs on top of them.\nSupported: ' +
          SUPPORTED +
          '.\n  git clone [-b REF] [-q] https://github.com/OWNER/REPO [DIR]\n',
      )
      return command === undefined ? 1 : 0
    default:
      ctx.stderr.write(
        "git: '" +
          command +
          "' is not supported by this shell's git, which clones GitHub source snapshots without earlier history and keeps local commits.\nSupported: " +
          SUPPORTED +
          ".\nThere is no fetch, pull, push, merge, rebase or stash; to publish, use the host's tools.\n",
      )
      return 1
  }
}

async function gh(ctx: CommandContext, github: GitHub.Options, args: string[]): Promise<number> {
  if (args[0] === 'repo' && args[1] === 'clone') {
    const rest = args.slice(2)
    const separator = rest.indexOf('--')
    const own = separator < 0 ? rest : rest.slice(0, separator)
    const flags = separator < 0 ? [] : rest.slice(separator + 1)
    const operands = own.filter((arg) => !arg.startsWith('-'))
    if (!operands.length || operands.length > 2)
      throw new CommandError('usage: gh repo clone OWNER/REPO [DIRECTORY] [-- GITFLAGS...]', 1)
    const repository = repositoryOf(operands[0])
    if (!repository)
      throw new CommandError('expected OWNER/REPO or a GitHub URL, got ' + operands[0], 1)
    return clone(ctx, github, [
      ...flags,
      'https://github.com/' + repository + '.git',
      ...operands.slice(1),
    ])
  }
  ctx.stderr.write(
    "gh: only 'gh repo clone OWNER/REPO [DIRECTORY] [-- GITFLAGS...]' is available in this shell; it downloads a source snapshot without history.\n",
  )
  return 1
}

export function gitCommands(github: GitHub.Options = {}): Record<string, CommandHandler> {
  const plain =
    (run: (ctx: CommandContext) => Promise<number>): CommandHandler =>
    async (ctx) => {
      try {
        return await run(ctx)
      } catch (error) {
        if (!(error instanceof CommandError) || !/^(fatal|error|usage): /.test(error.message))
          throw error
        ctx.stderr.write(error.message + '\n')
        return error.status
      }
    }
  return {
    gh: plain((ctx) => gh(ctx, github, ctx.args)),
    git: plain((ctx) => git(ctx, github, ctx.args)),
  }
}

async function gitApply(ctx: CommandContext, args: string[]): Promise<number> {
  const flags: string[] = ['-s', '-f', '-d', ctx.cwd]
  const files: string[] = []
  let strip: string | undefined
  let check = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-R' || arg === '--reverse') flags.push('-R')
    else if (arg === '--check') check = true
    else if (arg === '-p') strip = args[++i] ?? '1'
    else if (/^-p\d+$/.test(arg)) strip = arg.slice(2)
    else if (arg === '-v' || arg === '--verbose') flags.splice(flags.indexOf('-s'), 1)
    else if (arg.startsWith('-') && arg !== '-') continue
    else files.push(arg)
  }
  const patches =
    !files.length || files.includes('-')
      ? [await ctx.stdin.text()]
      : await Promise.all(
          files.map(async (file) => new TextDecoder().decode(await ctx.fs.read(ctx.resolve(file)))),
        )
  for (const patch of patches) {
    const level =
      strip ??
      (/^\+\+\+ (?!\/dev\/null)[^\s/]+(?:\s|$)/m.test(patch) && !/^\+\+\+ [ab]\//m.test(patch)
        ? '0'
        : '1')
    const status = await ctx.run(
      ['patch', '-p' + level, ...flags, ...(check ? ['--dry-run'] : [])],
      patch,
    )
    if (status !== 0) return status
  }
  return 0
}

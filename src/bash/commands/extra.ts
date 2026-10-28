import {
  CommandError,
  LimitError,
  PipeError,
  budget,
  type CommandContext,
  type CommandHandler,
} from '../shell.ts'
import { baseOf, byte, decode, encode, FsError, parentOf } from '../fs.ts'
import { escapeRegExp, format, globRegExp, globSource, lines, posixRegExp } from '../text.ts'
import { checksum, perlSource, scan } from './text.ts'
import {
  allInput,
  device,
  eachInput,
  last,
  linked,
  linkOf,
  lstatOf,
  options,
  pause,
  put,
  readInput,
} from './util.ts'
import { mkdirs } from './files.ts'
import {
  ahead,
  exactLiterals,
  literals,
  pruned,
  prunedList,
  prunedStat,
  type Pruned,
} from '../mount.ts'
import { make } from './make.ts'
import { yq } from './yaml.ts'
import { gunzip, gzip, pack, unpack, untar, type TarEntry } from './archive.ts'

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

async function bytesOf(ctx: CommandContext, operand: string): Promise<Uint8Array> {
  if (operand === '-') return encode(ctx.stdin.read())
  const stat = await ctx.fs.stat(ctx.resolve(operand))
  if (stat) budget(ctx.limits, 2 * stat.size, ctx.name + ': ' + operand)
  return ctx.fs.read(ctx.resolve(operand))
}

function compressor(mode: 'gzip' | 'gunzip' | 'zcat'): CommandHandler {
  return async (ctx) => {
    const parsed = options(ctx.args, {
      flags: 'cdfklnqrtv123456789',
      long: {
        stdout: 'c',
        decompress: 'd',
        force: 'f',
        keep: 'k',
        list: 'l',
        test: 't',
        best: '9',
        fast: '1',
        quiet: 'q',
        'no-name': 'n',
        recursive: 'r',
        verbose: 'v',
      },
    })
    const decompress = mode !== 'gzip' || parsed.flags.has('d')
    const stdout = mode === 'zcat' || parsed.flags.has('c')
    let status = 0
    if (parsed.flags.has('l') || parsed.flags.has('t')) {
      let header = false
      for (const operand of parsed.operands.length ? parsed.operands : ['-']) {
        try {
          const input = await bytesOf(ctx, operand)
          const output = await gunzip(input)
          if (parsed.flags.has('t')) continue
          if (!header)
            ctx.stdout.write('         compressed        uncompressed  ratio uncompressed_name\n')
          header = true
          const ratio = output.length ? ((output.length - input.length) / output.length) * 100 : 0
          ctx.stdout.write(
            String(input.length).padStart(19) +
              ' ' +
              String(output.length).padStart(19) +
              ' ' +
              (ratio.toFixed(1) + '%').padStart(6) +
              ' ' +
              (operand === '-' ? '' : operand.replace(/\.gz$/, '')) +
              '\n',
          )
        } catch (error) {
          ctx.stderr.write(
            'gzip: ' +
              operand +
              ': ' +
              (error instanceof FsError && error.code === 'ENOENT'
                ? 'No such file or directory'
                : 'not in gzip format') +
              '\n',
          )
          status = 1
        }
      }
      return status
    }
    for (const operand of parsed.operands.length ? parsed.operands : ['-']) {
      try {
        const input = await bytesOf(ctx, operand)
        const output = decompress ? await gunzip(input) : await gzip(input)
        if (stdout || operand === '-') {
          ctx.stdout.write(decode(output))
          continue
        }
        const path = ctx.resolve(operand)
        if (decompress && !path.endsWith('.gz'))
          throw new CommandError(operand + ': unknown suffix -- ignored')
        await ctx.fs.write(decompress ? path.slice(0, -3) : path + '.gz', output)
        if (!parsed.flags.has('k')) await ctx.fs.remove(path)
      } catch (error) {
        if (error instanceof CommandError || error instanceof LimitError) throw error
        ctx.stderr.write(
          ctx.name +
            ': ' +
            operand +
            ': ' +
            (error instanceof FsError && error.code === 'ENOENT'
              ? 'No such file or directory'
              : 'not in gzip format') +
            '\n',
        )
        status = 1
      }
    }
    return status
  }
}

const collected = new WeakMap<TarEntry[], number>()

async function collect(
  ctx: CommandContext,
  root: string,
  operand: string,
  entries: TarEntry[],
): Promise<void> {
  const path = ctx.resolve(root === '.' ? operand : root + '/' + operand)
  const stat = await lstatOf(ctx, path)
  if (!stat) throw new CommandError(operand + ': Cannot stat: No such file or directory')
  const name = operand.replace(/(.)\/+$/, '$1')
  if (stat.kind === 'symlink') {
    entries.push({
      name,
      type: 'symlink',
      data: new Uint8Array(),
      mode: 0o777,
      mtime: stat.mtime,
      linkname: stat.target ?? '',
    })
    return
  }
  if (stat.kind === 'file') {
    const total = (collected.get(entries) ?? 0) + stat.size + 512
    collected.set(entries, total)
    budget(ctx.limits, 3 * total, 'tar: ' + entries.length + ' files')
    entries.push({
      name,
      type: 'file',
      data: await ctx.fs.read(path),
      mode: stat.mode,
      mtime: stat.mtime,
      linkname: '',
    })
    return
  }
  entries.push({
    name,
    type: 'directory',
    data: new Uint8Array(),
    mode: stat.mode,
    mtime: stat.mtime,
    linkname: '',
  })
  for (const child of await ctx.fs.list(path))
    await collect(ctx, root, (name === '/' ? '' : name) + '/' + child, entries)
}

const cmp: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'bls',
    long: { 'print-bytes': 'b', quiet: 's', silent: 's', verbose: 'l' },
  })
  const [left, right = '-'] = parsed.operands
  if (left === undefined) throw new CommandError("missing operand after 'cmp'", 2)
  const read = async (operand: string) => {
    try {
      return await bytesOf(ctx, operand)
    } catch (error) {
      if (error instanceof FsError)
        throw new CommandError(
          operand + ': ' + (error.code === 'ENOENT' ? 'No such file or directory' : error.message),
          2,
        )
      throw error
    }
  }
  const a = await read(left)
  const b = await read(right)
  const length = Math.min(a.length, b.length)
  const quiet = parsed.flags.has('s')
  let line = 1
  let differ = false
  for (let i = 0; i < length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x !== y) {
      differ = true
      if (parsed.flags.has('l')) {
        ctx.stdout.write(
          String(i + 1).padStart(String(length).length) +
            ' ' +
            x.toString(8).padStart(3) +
            ' ' +
            y.toString(8).padStart(3) +
            '\n',
        )
        continue
      }
      if (!quiet)
        ctx.stdout.write(left + ' ' + right + ' differ: byte ' + (i + 1) + ', line ' + line + '\n')
      return 1
    }
    if (x === 10) line++
  }
  if (a.length !== b.length) {
    const shorter = a.length < b.length ? left : right
    if (!quiet)
      ctx.stderr.write(
        'cmp: EOF on ' +
          shorter +
          (length ? ' after byte ' + length + ', line ' + line : ' which is empty') +
          '\n',
      )
    return 1
  }
  return differ ? 1 : 0
}

const TAR_VALUES = new Set(['f', 'C', 'T', 'X'])

const TAR_LONG: Record<string, string> = {
  create: 'c',
  extract: 'x',
  get: 'x',
  list: 't',
  append: 'r',
  update: 'u',
  gzip: 'z',
  gunzip: 'z',
  ungzip: 'z',
  bzip2: 'j',
  xz: 'J',
  zstd: 'zstd',
  'auto-compress': 'a',
  verbose: 'v',
  file: 'f',
  directory: 'C',
  'to-stdout': 'O',
  'keep-old-files': 'k',
  'skip-old-files': 'k',
  'preserve-permissions': 'p',
  'same-permissions': 'p',
  dereference: 'h',
  touch: 'm',
  'files-from': 'T',
  'exclude-from': 'X',
  'absolute-names': 'P',
}

const TAR_IGNORED = new Set([
  'no-same-owner',
  'same-owner',
  'no-same-permissions',
  'numeric-owner',
  'overwrite',
  'recursive-unlink',
  'unlink-first',
  'no-recursion',
  'recursion',
  'warning',
  'owner',
  'group',
  'mtime',
  'sort',
  'mode',
  'format',
  'blocking-factor',
  'record-size',
  'checkpoint',
  'checkpoint-action',
  'totals',
  'show-transformed-names',
  'delay-directory-restore',
  'no-overwrite-dir',
  'ignore-zeros',
  'ignore-failed-read',
  'preserve-order',
  'same-order',
  'atime-preserve',
  'no-xattrs',
  'xattrs',
  'no-acls',
  'acls',
  'no-selinux',
  'selinux',
  'full-time',
  'utc',
  'force-local',
  'no-auto-compress',
  'pax-option',
  'label',
  'anchored',
  'no-anchored',
  'no-wildcards-match-slash',
  'wildcards-match-slash',
  'no-ignore-case',
  'quoting-style',
  'hard-dereference',
  'one-file-system',
  'sparse',
  'verify',
  'index-file',
  'null',
  'no-null',
  'exclude-vcs',
  'exclude-vcs-ignores',
  'exclude-backups',
  'exclude-caches',
  'level',
  'occurrence',
  'interactive',
  'confirmation',
  'show-omitted-dirs',
  'remove-files',
  'keep-newer-files',
  'keep-directory-symlink',
])

const tar: CommandHandler = async (ctx) => {
  const flags = new Set<string>()
  const values = new Map<string, string[]>()
  const operands: string[] = []
  const add = (key: string, value: string) => values.set(key, [...(values.get(key) ?? []), value])
  const args = ctx.args.slice()
  let strip = 0
  let wildcards = false
  let ignoreCase = false
  const excludes: string[] = []
  const transforms: [RegExp, string][] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (i === 0 && !arg.startsWith('-') && /^[A-Za-z]+$/.test(arg) && /[ctxru]/.test(arg)) {
      for (const c of arg) {
        if (TAR_VALUES.has(c)) {
          const value = args[++i]
          if (value === undefined)
            throw new CommandError("option requires an argument -- '" + c + "'", 2)
          add(c, value)
        } else flags.add(c)
      }
      continue
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=')
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2)
      const inline = eq > 0 ? arg.slice(eq + 1) : undefined
      const value = () => {
        const found = inline ?? args[++i]
        if (found === undefined)
          throw new CommandError("option '--" + name + "' requires an argument", 2)
        return found
      }
      if (name === 'strip-components' || name === 'strip-path') strip = Number(value())
      else if (name === 'exclude') excludes.push(value())
      else if (name === 'wildcards') wildcards = true
      else if (name === 'no-wildcards') wildcards = false
      else if (name === 'ignore-case') ignoreCase = true
      else if (name === 'version') {
        ctx.stdout.write('tar (GNU tar) 1.35\n')
        return 0
      } else if (name === 'help') {
        ctx.stdout.write(
          'Usage: tar [OPTION...] [FILE]...\n  -c, --create  -x, --extract  -t, --list  -f, --file=ARCHIVE  -C, --directory=DIR\n  -z, --gzip  -a, --auto-compress  -v, --verbose  -O, --to-stdout  -k, --keep-old-files\n      --strip-components=NUMBER  --exclude=PATTERN  --wildcards  -T, --files-from=FILE\n',
        )
        return 0
      } else if (name === 'transform' || name === 'xform') {
        const expression = value()
        const match = /^s(.)(.*?)\1(.*?)\1([gi]*)$/.exec(expression)
        if (!match) throw new CommandError('Invalid transform expression', 2)
        transforms.push([
          new RegExp(match[2], match[4].includes('g') ? 'g' : ''),
          match[3].replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&'),
        ])
      } else if (name in TAR_LONG) {
        const key = TAR_LONG[name]
        if (TAR_VALUES.has(key)) add(key, value())
        else flags.add(key)
      } else if (TAR_IGNORED.has(name)) {
        if (
          inline === undefined &&
          [
            'owner',
            'group',
            'mtime',
            'sort',
            'mode',
            'format',
            'blocking-factor',
            'record-size',
            'checkpoint-action',
            'quoting-style',
            'pax-option',
            'label',
            'level',
            'occurrence',
            'index-file',
          ].includes(name)
        )
          i++
      } else
        throw new CommandError(
          "unrecognized option '--" + name + "'\nTry 'tar --help' for more information.",
          2,
        )
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j]
        if (TAR_VALUES.has(c)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i]
          if (value === undefined)
            throw new CommandError("option requires an argument -- '" + c + "'", 2)
          add(c, value)
          break
        }
        if (!'ctxruzjJavOkphmPwWS'.includes(c))
          throw new CommandError(
            "invalid option -- '" + c + "'\nTry 'tar --help' for more information.",
            2,
          )
        flags.add(c)
      }
      continue
    }
    operands.push(arg)
  }
  for (const list of values.get('T') ?? []) {
    const text = list === '-' ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(list)))
    operands.push(...text.split(/\n|\0/).filter(Boolean))
  }
  for (const list of values.get('X') ?? [])
    excludes.push(
      ...decode(await ctx.fs.read(ctx.resolve(list)))
        .split('\n')
        .filter(Boolean),
    )
  const mode = ['c', 'x', 't', 'r', 'u'].filter((flag) => flags.has(flag))
  if (mode.length !== 1)
    throw new CommandError(
      mode.length
        ? "You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option"
        : "You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' for more information.",
      2,
    )
  const file = values.get('f')?.at(-1)
  const roots = values.get('C') ?? []
  const root = roots.at(-1) ?? '.'
  const auto =
    flags.has('a') && file !== undefined
      ? /\.(tgz|taz|tar\.gz)$/.test(file)
        ? 'z'
        : /\.(tbz2?|tar\.bz2)$/.test(file)
          ? 'j'
          : /\.(txz|tar\.xz)$/.test(file)
            ? 'J'
            : /\.(tzst|tar\.zst)$/.test(file)
              ? 'zstd'
              : ''
      : ''
  const compression =
    flags.has('J') || auto === 'J'
      ? 'xz'
      : flags.has('j') || auto === 'j'
        ? 'bzip2'
        : flags.has('zstd') || auto === 'zstd'
          ? 'zstd'
          : flags.has('z') || auto === 'z'
            ? 'gzip'
            : ''
  const unsupported = (name: string) =>
    new CommandError(
      name + ' compression is not available in this shell; use gzip (-z) or zip instead',
      2,
    )
  const excludedBy = (name: string) => {
    const base = name.replace(/\/+$/, '')
    return excludes.some((pattern) => {
      const regex = globRegExp(pattern.replace(/\/+$/, ''), ignoreCase ? 'i' : '')
      return (
        regex.test(base) ||
        base.split('/').some((part) => regex.test(part)) ||
        regex.test(base.split('/').pop() ?? '')
      )
    })
  }
  if (mode[0] === 'c' || mode[0] === 'r' || mode[0] === 'u') {
    if (compression && compression !== 'gzip') throw unsupported(compression)
    if (!file)
      throw new CommandError(
        'Refusing to write archive contents to terminal (missing -f option?)',
        2,
      )
    if (!operands.length) throw new CommandError('Cowardly refusing to create an empty archive', 2)
    let entries: TarEntry[] = []
    if (mode[0] !== 'c' && file !== '-') {
      const old = await ctx.fs.read(ctx.resolve(file)).catch(() => undefined)
      if (old) entries = unpack(old[0] === 0x1f && old[1] === 0x8b ? await gunzip(old) : old)
    }
    const added: TarEntry[] = []
    let missing = false
    let current = root
    let index = 0
    for (let i = 0; i < args.length && index < operands.length; i++) {
      const arg = args[i]
      if (arg === '-C' || arg === '--directory') current = args[i + 1] ?? current
      else if (arg.startsWith('--directory=')) current = arg.slice(12)
      else if (arg === operands[index]) {
        try {
          await collect(ctx, current, operands[index], added)
        } catch (error) {
          if (!(error instanceof CommandError)) throw error
          ctx.stderr.write('tar: ' + error.message + '\n')
          missing = true
        }
        index++
      }
    }
    for (; index < operands.length; index++) {
      try {
        await collect(ctx, root, operands[index], added)
      } catch (error) {
        if (!(error instanceof CommandError)) throw error
        ctx.stderr.write('tar: ' + error.message + '\n')
        missing = true
      }
    }
    const kept = added
      .filter((entry) => !excludedBy(entry.name))
      .map((entry) => {
        let name = entry.name.replace(/^\/+/, '')
        for (const [pattern, replacement] of transforms) name = name.replace(pattern, replacement)
        return { ...entry, name }
      })
    if (added.some((entry) => entry.name.startsWith('/')) && !flags.has('P'))
      ctx.stderr.write("tar: Removing leading '/' from member names\n")
    if (flags.has('v'))
      for (const entry of kept)
        (file === '-' ? ctx.stderr : ctx.stdout).write(
          entry.name + (entry.type === 'directory' ? '/' : '') + '\n',
        )
    entries.push(...kept)
    const archive = compression === 'gzip' ? await gzip(pack(entries)) : pack(entries)
    if (file === '-') await put(ctx, decode(archive))
    else await ctx.fs.write(ctx.resolve(file), archive)
    if (missing) {
      ctx.stderr.write('tar: Exiting with failure status due to previous errors\n')
      return 2
    }
    return 0
  }
  let raw: Uint8Array
  try {
    raw = file && file !== '-' ? await ctx.fs.read(ctx.resolve(file)) : encode(ctx.stdin.read())
  } catch (error) {
    if (!(error instanceof FsError)) throw error
    throw new CommandError(
      file + ': Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now',
      2,
    )
  }
  if (raw[0] === 0x42 && raw[1] === 0x5a && raw[2] === 0x68) throw unsupported('bzip2')
  if (raw[0] === 0xfd && raw[1] === 0x37 && raw[2] === 0x7a && raw[3] === 0x58)
    throw unsupported('xz')
  if (raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd)
    throw unsupported('zstd')
  const wanted = operands.map((operand) => operand.replace(/\/+$/, ''))
  const globbing =
    wildcards || (mode[0] !== 'c' && wanted.some((name) => /[*?[]/.test(name)) && wildcards)
  const matched = new Set<string>()
  const select = (entry: TarEntry) => {
    if (
      !(
        entry.type === 'file' ||
        entry.type === 'directory' ||
        entry.type === 'symlink' ||
        entry.type === 'link'
      )
    )
      return false
    if (excludedBy(entry.name)) return false
    if (!wanted.length) return true
    const name = entry.name.replace(/\/+$/, '')
    const hit = wanted.find((want) =>
      globbing
        ? globRegExp(want, ignoreCase ? 'i' : '').test(name) || name.startsWith(want + '/')
        : name === want || name.startsWith(want + '/'),
    )
    if (hit !== undefined) matched.add(hit)
    return hit !== undefined
  }
  const notTar = () =>
    new CommandError(
      'This does not look like a tar archive\ntar: Exiting with failure status due to previous errors',
      2,
    )
  const archive = untar(raw)[Symbol.asyncIterator]()
  let count = 0
  let status = 0
  for (;;) {
    let next: IteratorResult<TarEntry>
    try {
      next = await archive.next()
    } catch (error) {
      if (error instanceof CommandError || error instanceof LimitError) throw error
      if (!count) throw notTar()
      ctx.stderr.write(
        'tar: Unexpected EOF in archive\ntar: Error is not recoverable: exiting now\n',
      )
      return 2
    }
    if (next.done) break
    count++
    const entry = next.value
    if (!select(entry)) continue
    let name = entry.name
    for (const [pattern, replacement] of transforms) name = name.replace(pattern, replacement)
    if (strip) {
      const parts = name.split('/')
      const trailing = name.endsWith('/')
      const rest = parts
        .filter((part, index) => index < parts.length - (trailing ? 1 : 0) || part)
        .slice(strip)
      if (!rest.length || (rest.length === 1 && rest[0] === '')) continue
      name = rest.join('/') + (trailing && !rest.join('/').endsWith('/') ? '/' : '')
      if (name === '/') continue
    }
    if (mode[0] === 't' && flags.has('v')) {
      const date = new Date(entry.mtime)
      const pad = (n: number) => String(n).padStart(2, '0')
      const bits = entry.type === 'symlink' ? 0o777 : entry.mode
      let text =
        entry.type === 'directory'
          ? 'd'
          : entry.type === 'symlink'
            ? 'l'
            : entry.type === 'link'
              ? 'h'
              : '-'
      for (const shift of [6, 3, 0])
        text +=
          ((bits >> shift) & 4 ? 'r' : '-') +
          ((bits >> shift) & 2 ? 'w' : '-') +
          ((bits >> shift) & 1 ? 'x' : '-')
      ctx.stdout.write(
        text +
          ' user/user ' +
          String(entry.type === 'file' ? entry.data.length : 0).padStart(9) +
          ' ' +
          date.getUTCFullYear() +
          '-' +
          pad(date.getUTCMonth() + 1) +
          '-' +
          pad(date.getUTCDate()) +
          ' ' +
          pad(date.getUTCHours()) +
          ':' +
          pad(date.getUTCMinutes()) +
          ' ' +
          name.replace(/\/?$/, entry.type === 'directory' ? '/' : '') +
          (entry.type === 'symlink'
            ? ' -> ' + entry.linkname
            : entry.type === 'link'
              ? ' link to ' + entry.linkname
              : '') +
          '\n',
      )
      await pause(ctx)
    } else if (mode[0] === 't' || (flags.has('v') && !flags.has('O'))) {
      ctx.stdout.write(name.replace(/\/?$/, entry.type === 'directory' ? '/' : '') + '\n')
      await pause(ctx)
    } else if (flags.has('v') && flags.has('O')) ctx.stderr.write(name + '\n')
    if (mode[0] !== 'x') continue
    if (flags.has('O')) {
      if (entry.type === 'file') await put(ctx, decode(entry.data))
      continue
    }
    if (!flags.has('P') && (name.startsWith('/') || name.split('/').includes('..'))) {
      ctx.stderr.write('tar: ' + name + ": Member name contains '..'\n")
      status = 2
      continue
    }
    const target = ctx.resolve((root === '.' ? '' : root + '/') + name.replace(/^\/+/, ''))
    const fs = linked(ctx)
    if (flags.has('k') && entry.type !== 'directory' && (await lstatOf(ctx, target))) continue
    if (entry.type === 'symlink') {
      if (!fs.symlink) continue
      await mkdirs(ctx.fs, parentOf(target))
      if (await lstatOf(ctx, target)) await ctx.fs.remove(target)
      await fs.symlink(entry.linkname, target)
      continue
    }
    if (entry.type === 'link') {
      let source = entry.linkname
      if (strip) source = source.split('/').slice(strip).join('/')
      const data = await ctx.fs
        .read(ctx.resolve((root === '.' ? '' : root + '/') + source))
        .catch(() => undefined)
      if (data === undefined) continue
      await mkdirs(ctx.fs, parentOf(target))
      await ctx.fs.write(target, data)
      continue
    }
    if (entry.type === 'directory') await mkdirs(ctx.fs, target)
    else {
      await mkdirs(ctx.fs, parentOf(target))
      const existing = await lstatOf(ctx, target)
      if (existing?.kind === 'directory') {
        ctx.stderr.write('tar: ' + name + ': Cannot open: Is a directory\n')
        status = 2
        continue
      }
      if (existing?.kind === 'symlink') await ctx.fs.remove(target)
      await ctx.fs.write(target, entry.data)
    }
    const bits = flags.has('p') ? entry.mode & 0o7777 : entry.mode & 0o777 & ~ctx.umask
    if (ctx.fs.chmod && (await ctx.fs.stat(target))?.mode !== bits) await ctx.fs.chmod(target, bits)
  }
  if (
    raw.length &&
    !count &&
    raw.length >= 512 &&
    raw.subarray(0, 512).some((byte) => byte !== 0) &&
    decode(raw.subarray(257, 262)) !== 'ustar'
  )
    throw notTar()
  for (const want of wanted) {
    if (!matched.has(want)) {
      ctx.stderr.write('tar: ' + want + ': Not found in archive\n')
      status = 2
    }
  }
  if (status && wanted.some((want) => !matched.has(want)))
    ctx.stderr.write('tar: Exiting with failure status due to previous errors\n')
  return status
}

function md5(data: Uint8Array): string {
  const k = Array.from(
    { length: 64 },
    (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
  )
  const r = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]
  const length = data.length
  const padded = new Uint8Array(((length + 72) >> 6) << 6)
  padded.set(data)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(length / 2 ** 29), true)
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
  for (let offset = 0; offset < padded.length; offset += 64) {
    let [a, b, c, d] = [a0, b0, c0, d0]
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const next = d
      d = c
      c = b
      const sum = (a + f + k[i] + view.getUint32(offset + g * 4, true)) >>> 0
      b = (b + ((sum << r[i]) | (sum >>> (32 - r[i])))) >>> 0
      a = next
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }
  return [a0, b0, c0, d0]
    .map((word) =>
      [0, 8, 16, 24]
        .map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, '0'))
        .join(''),
    )
    .join('')
}

const md5sum: CommandHandler = checksum(md5, 'MD5')

const tree: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'adfFsC',
    values: 'LIP',
    long: {
      noreport: 'R',
      dirsfirst: 'D',
      gitignore: '',
      charset: 'charset',
      filelimit: 'filelimit',
      prune: 'U',
    },
  })
  const f = parsed.flags
  const depth = Number(last(parsed, 'L') ?? Infinity)
  const ignore = (parsed.values.get('I') ?? [])
    .flatMap((spec) => spec.split('|'))
    .map((glob) => globRegExp(glob))
  const pattern = (parsed.values.get('P') ?? [])
    .flatMap((spec) => spec.split('|'))
    .map((glob) => globRegExp(glob))
  let directories = 0
  let files = 0
  let status = 0
  const walk = async (path: string, display: string, prefix: string, level: number) => {
    if (level > depth) return
    const names = (await ctx.fs.list(path)).filter(
      (name) => (f.has('a') || !name.startsWith('.')) && !ignore.some((glob) => glob.test(name)),
    )
    const children: { name: string; directory: boolean; size: number }[] = []
    for (const name of names) {
      const stat = await ctx.fs.stat(path === '/' ? '/' + name : path + '/' + name)
      if (!stat) continue
      const directory = stat.kind === 'directory'
      if (!directory && f.has('d')) continue
      if (!directory && pattern.length && !pattern.some((glob) => glob.test(name))) continue
      children.push({ name, directory, size: stat.size })
    }
    if (f.has('D')) children.sort((a, b) => Number(b.directory) - Number(a.directory))
    for (const [index, child] of children.entries()) {
      const end = index === children.length - 1
      const childDisplay = display.endsWith('/') ? display + child.name : display + '/' + child.name
      const label =
        (f.has('f') ? childDisplay : child.name) + (f.has('F') && child.directory ? '/' : '')
      ctx.stdout.write(
        prefix +
          (end ? '└── ' : '├── ') +
          (f.has('s')
            ? '[' + String(child.directory ? 4096 : child.size).padStart(11) + ']  '
            : '') +
          label +
          '\n',
      )
      if (child.directory) {
        directories++
        await walk(
          path === '/' ? '/' + child.name : path + '/' + child.name,
          childDisplay,
          prefix + (end ? '    ' : '│\u00a0\u00a0 '),
          level + 1,
        )
      } else files++
    }
  }
  for (const operand of parsed.operands.length ? parsed.operands : ['.']) {
    const path = ctx.resolve(operand)
    const stat = await ctx.fs.stat(path)
    if (!stat || stat.kind !== 'directory') {
      ctx.stdout.write(operand + (stat ? '  [error opening dir]' : '  [error opening dir]') + '\n')
      status = 2
      continue
    }
    directories++
    ctx.stdout.write(operand + (f.has('F') && !operand.endsWith('/') ? '/' : '') + '\n')
    await walk(path, operand, '', 1)
  }
  if (!f.has('R'))
    ctx.stdout.write(
      '\n' +
        directories +
        ' director' +
        (directories === 1 ? 'y' : 'ies') +
        (f.has('d') ? '' : ', ' + files + ' file' + (files === 1 ? '' : 's')) +
        '\n',
    )
  return status
}

const BINARIES = new Set([
  'echo',
  'printf',
  'test',
  '[',
  'pwd',
  'true',
  'false',
  'kill',
  'sleep',
  'env',
  'time',
  'timeout',
  'nice',
  'nohup',
  'stty',
  'tty',
  'sh',
  'bash',
  'dash',
])

const SHELL_ONLY = new Set([
  'cd',
  'pushd',
  'popd',
  'dirs',
  'export',
  'unset',
  'set',
  'shift',
  'exit',
  'return',
  'local',
  'declare',
  'typeset',
  'readonly',
  'eval',
  'source',
  '.',
  'alias',
  'unalias',
  'read',
  'type',
  'command',
  'hash',
  'history',
  'jobs',
  'fg',
  'bg',
  'wait',
  'ulimit',
  'umask',
  'trap',
  'let',
  'getopts',
  'mapfile',
  'readarray',
  'builtin',
  'enable',
  'help',
  'logout',
  'shopt',
  'times',
  'compgen',
  'complete',
  'disown',
  'suspend',
  'break',
  'continue',
  ':',
])

const which: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, { flags: 'as' })
  let status = 0
  for (const name of parsed.operands) {
    const found = await ctx.exec('type -t ' + quote(name))
    const kind = found.stdout.trim()
    if (found.status !== 0 || !kind || kind === 'function' || kind === 'alias') {
      status = 1
      continue
    }
    if ((kind === 'builtin' && !BINARIES.has(name)) || SHELL_ONLY.has(name)) {
      status = 1
      continue
    }
    if (!parsed.flags.has('s'))
      ctx.stdout.write((name.startsWith('/') ? name : '/usr/bin/' + name) + '\n')
  }
  return status
}

const env: CommandHandler = async (ctx) => {
  const args = ctx.args.slice()
  let clear = false
  const assignments: string[] = []
  while (args.length) {
    if (args[0] === '-i' || args[0] === '-') {
      clear = true
      args.shift()
    } else if (args[0] === '-u' && args[1]) {
      assignments.push('unset ' + quote(args[1]) + ';')
      args.splice(0, 2)
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]))
      assignments.push('export ' + quote(args.shift()!) + ';')
    else break
  }
  if (!args.length) {
    const vars = clear ? {} : { ...ctx.env }
    for (const assignment of assignments) {
      const match = /^export '([^=]*)=(.*)';$/s.exec(assignment)
      if (match) vars[match[1]] = match[2].replace(/'\\''/g, "'")
    }
    for (const [name, value] of Object.entries(vars).sort())
      ctx.stdout.write(name + '=' + value + '\n')
    return 0
  }
  const result = await ctx.exec(
    '(' + assignments.join(' ') + ' ' + args.map(quote).join(' ') + ')',
    ctx.stdin.read(),
  )
  ctx.stdout.write(result.stdout)
  return result.status
}

const time: CommandHandler = async (ctx) => {
  const started = performance.now()
  const status = ctx.args.length ? await ctx.run(ctx.args) : 0
  const seconds = (performance.now() - started) / 1000
  ctx.stderr.write('\nreal\t0m' + seconds.toFixed(3) + 's\nuser\t0m0.000s\nsys\t0m0.000s\n')
  return status
}

const timeout: CommandHandler = async (ctx) => {
  const args = ctx.args.filter((arg, index) => index > 0 || !arg.startsWith('-'))
  const [limit, ...command] = args.filter((arg) => !/^-(s|k|-signal|-kill-after)/.test(arg))
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(limit ?? '')
  if (!match || !command.length)
    throw new CommandError('usage: timeout DURATION COMMAND [ARG]...', 125)
  const ms = Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 's'] ?? 1) * 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(124), ms)
  })
  try {
    return await Promise.race([ctx.run(command), expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const yes: CommandHandler = async (ctx) => {
  const line = (ctx.args.length ? ctx.args.join(' ') : 'y') + '\n'
  if (!ctx.stdout.piped) {
    const count = Math.max(
      1,
      Math.min(10_000, Math.floor(ctx.limits.maxOutputLength / line.length) - 1),
    )
    ctx.stdout.write(line.repeat(count))
    return
  }
  const block = line.repeat(Math.max(1, Math.floor(8192 / line.length)))
  for (;;) await put(ctx, block)
}

const strings: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, { flags: 'a', values: 'n', numeric: true })
  const min = Number(last(parsed, 'n') ?? 4)
  let status = 0
  for (const operand of parsed.operands.length ? parsed.operands : ['-']) {
    try {
      const data = await bytesOf(ctx, operand)
      let run = ''
      for (const byte of data) {
        if ((byte >= 0x20 && byte < 0x7f) || byte === 0x09) run += String.fromCharCode(byte)
        else {
          if (run.length >= min) {
            ctx.stdout.write(run + '\n')
            if (ctx.stdout.backlog) await pause(ctx)
          }
          run = ''
        }
      }
      if (run.length >= min) ctx.stdout.write(run + '\n')
      await pause(ctx)
    } catch (error) {
      if (error instanceof LimitError) throw error
      ctx.stderr.write('strings: ' + operand + ': No such file\n')
      status = 1
    }
  }
  return status
}

const xxd: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'pr',
    values: 'lc',
    long: { plain: 'p', ps: 'p', postscript: 'p', revert: 'r' },
  })
  const data = await bytesOf(ctx, parsed.operands[0] ?? '-')
  if (parsed.flags.has('r')) {
    const text = decode(data)
    const chunks: { offset: number; hex: string }[] = []
    if (parsed.flags.has('p')) chunks.push({ offset: 0, hex: text.replace(/[^0-9a-fA-F]/g, '') })
    else
      for (const line of text.split('\n')) {
        const match = /^\s*([0-9a-fA-F]+):\s?(.*)$/.exec(line)
        if (!match) continue
        const end = match[2].indexOf('  ')
        chunks.push({
          offset: parseInt(match[1], 16),
          hex: (end < 0 ? match[2] : match[2].slice(0, end)).replace(/[^0-9a-fA-F]/g, ''),
        })
      }
    let size = 0
    for (const chunk of chunks) size = Math.max(size, chunk.offset + (chunk.hex.length >> 1))
    if (parsed.flags.has('p')) size = chunks[0]!.hex.length >> 1
    const out = new Uint8Array(size)
    for (const chunk of chunks)
      for (let i = 0; i + 1 < chunk.hex.length; i += 2)
        out[chunk.offset + (i >> 1)] = parseInt(chunk.hex.slice(i, i + 2), 16)
    const target = parsed.operands[1]
    if (target !== undefined) await ctx.fs.write(ctx.resolve(target), out)
    else ctx.stdout.write(decode(out))
    return
  }
  const limit = Math.min(data.length, Number(last(parsed, 'l') ?? data.length))
  if (parsed.flags.has('p')) {
    let hex = ''
    for (let i = 0; i < limit; i++) hex += data[i].toString(16).padStart(2, '0')
    ctx.stdout.write((hex.match(/.{1,60}/g) ?? []).join('\n') + (hex ? '\n' : ''))
    return
  }
  const columns = Number(last(parsed, 'c') ?? 16)
  for (let offset = 0; offset < limit; offset += columns) {
    const row = data.slice(offset, Math.min(offset + columns, limit))
    let hex = ''
    for (let i = 0; i < columns; i++)
      hex += (i < row.length ? row[i].toString(16).padStart(2, '0') : '  ') + (i % 2 ? ' ' : '')
    const ascii = Array.from(row, (byte) =>
      byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.',
    ).join('')
    ctx.stdout.write(offset.toString(16).padStart(8, '0') + ': ' + hex + ' ' + ascii + '\n')
    if (ctx.stdout.backlog) await pause(ctx)
  }
}

const od: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, { flags: 'cxbdos', values: 'AtNj' })
  let data = await bytesOf(ctx, parsed.operands[0] ?? '-')
  const skip = Number(last(parsed, 'j') ?? 0)
  const limit = last(parsed, 'N')
  data = data.slice(skip, limit === undefined ? undefined : skip + Number(limit))
  const f = parsed.flags
  const raw =
    last(parsed, 't') ??
    (f.has('c')
      ? 'c'
      : f.has('b')
        ? 'o1'
        : f.has('x')
          ? 'x2'
          : f.has('d')
            ? 'u2'
            : f.has('s')
              ? 'd2'
              : 'o2')
  const type = /^[doux]$/.test(raw)
    ? raw + '4'
    : raw.replace(/C$/, '1').replace(/S$/, '2').replace(/I$/, '4').replace(/L$/, '8')
  const address = last(parsed, 'A') ?? 'o'
  const width = type === 'c' || type === 'a' ? 1 : Number(type.slice(1)) || 2
  const cell = (offset: number) => {
    if (width !== 2 || type[0] === 'd') {
      if (type !== 'c' && type !== 'a') {
        let value = 0n
        for (let i = width - 1; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i] ?? 0)
        if (type[0] === 'd' && value >= 1n << BigInt(width * 8 - 1))
          value -= 1n << BigInt(width * 8)
        const base = type[0] === 'x' ? 16 : type[0] === 'o' ? 8 : 10
        const digits =
          {
            x: width * 2,
            o: Math.ceil((width * 8) / 3),
            u: String(2 ** (width * 8) - 1).length,
            d: String(2 ** (width * 8 - 1)).length + 1,
          }[type[0] as 'x'] ?? 3
        return ' ' + value.toString(base).padStart(digits, base === 10 ? ' ' : '0')
      }
    }
    if (type === 'c') {
      const byte = data[offset]
      const named: Record<number, string> = {
        0: '\\0',
        7: '\\a',
        8: '\\b',
        9: '\\t',
        10: '\\n',
        11: '\\v',
        12: '\\f',
        13: '\\r',
      }
      return (
        named[byte] ??
        (byte >= 0x20 && byte < 0x7f
          ? String.fromCharCode(byte)
          : byte.toString(8).padStart(3, '0'))
      ).padStart(4)
    }
    const value = width === 1 ? data[offset] : data[offset] | ((data[offset + 1] ?? 0) << 8)
    const base = type.startsWith('x') ? 16 : type.startsWith('d') || type.startsWith('u') ? 10 : 8
    return (
      ' ' +
      value
        .toString(base)
        .padStart(
          width === 1 ? (base === 16 ? 2 : 3) : base === 16 ? 4 : base === 10 ? 5 : 6,
          base === 10 ? ' ' : '0',
        )
    )
  }
  const label = (offset: number) =>
    address === 'n'
      ? ''
      : offset.toString(address === 'x' ? 16 : address === 'd' ? 10 : 8).padStart(7, '0')
  for (let offset = 0; offset < data.length; offset += 16) {
    let line = label(offset)
    for (let i = offset; i < Math.min(offset + 16, data.length); i += width) line += cell(i)
    ctx.stdout.write(line + '\n')
    if (ctx.stdout.backlog) await pause(ctx)
  }
  if (address !== 'n') ctx.stdout.write(label(data.length) + '\n')
}

const split: CommandHandler = async (ctx) => {
  const parsed = options(
    ctx.args.map((arg) => (/^-\d+$/.test(arg) ? '-l' + arg.slice(1) : arg)),
    {
      flags: 'dx',
      values: 'lban',
      long: {
        lines: 'l',
        bytes: 'b',
        'suffix-length': 'a',
        number: 'n',
        'numeric-suffixes': 'd',
        'hex-suffixes': 'x',
        'additional-suffix': 'additional-suffix',
      },
    },
  )
  const [input = '-', prefix = 'x'] = parsed.operands
  const lines = Number(last(parsed, 'l') ?? 1000)
  const size = last(parsed, 'b')
  const parts = last(parsed, 'n')
  const width = Number(last(parsed, 'a') ?? 2)
  const data = await bytesOf(ctx, input)
  const chunks: Uint8Array[] = []
  if (parts !== undefined) {
    const count = Number(parts.replace(/^[lr]\//, ''))
    if (!Number.isInteger(count) || count < 1)
      throw new CommandError("invalid number of chunks: '" + parts + "'")
    const base = Math.floor(data.length / count)
    const extra = data.length % count
    let offset = 0
    for (let i = 0; i < count; i++) {
      const length = base + (i < extra ? 1 : 0)
      chunks.push(data.slice(offset, offset + length))
      offset += length
    }
  } else if (size) {
    const bytes =
      Number(size.replace(/[kKmM]$/, '')) *
      (/[kK]$/.test(size) ? 1024 : /[mM]$/.test(size) ? 1024 * 1024 : 1)
    for (let offset = 0; offset < data.length; offset += bytes)
      chunks.push(data.slice(offset, offset + bytes))
  } else {
    const all = decode(data).split(/(?<=\n)/)
    for (let index = 0; index < all.length; index += lines)
      chunks.push(encode(all.slice(index, index + lines).join('')))
  }
  for (const [index, chunk] of chunks.entries()) {
    let suffix = ''
    if (parsed.flags.has('d')) suffix = String(index).padStart(width, '0')
    else
      for (let value = index, i = 0; i < width; i++, value = Math.floor(value / 26))
        suffix = String.fromCharCode(97 + (value % 26)) + suffix
    await ctx.fs.write(
      ctx.resolve(prefix + suffix + (last(parsed, 'additional-suffix') ?? '')),
      chunk,
    )
  }
}

const join: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'i',
    values: 't12aveoj',
    long: { 'ignore-case': 'i', nocheck: '', 'check-order': '', header: '' },
  })
  const [left, right] = parsed.operands
  if (!left || !right) throw new CommandError('missing operand', 1)
  const sep = last(parsed, 't')
  const split = (line: string) => (sep === undefined ? line.trim().split(/\s+/) : line.split(sep))
  const f1 = Number(last(parsed, '1') ?? 1) - 1
  const f2 = Number(last(parsed, '2') ?? 1) - 1
  const lines = async (operand: string) =>
    (await allInput(ctx, [operand])).text.split('\n').filter(Boolean).map(split)
  const a = await lines(left)
  const b = await lines(right)
  const key = (value: string | undefined) =>
    parsed.flags.has('i') ? (value ?? '').toLowerCase() : (value ?? '')
  const only = parsed.values.get('v') ?? []
  const unpaired = [...(parsed.values.get('a') ?? []), ...only]
  const out = sep ?? ' '
  const empty = last(parsed, 'e') ?? ''
  const spec = last(parsed, 'o')
  const fields =
    spec === undefined || spec === 'auto'
      ? undefined
      : spec
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((item) => (item === '0' ? [0, 0] : item.split('.').map(Number)) as [number, number])
  const render = (left: string[] | undefined, right: string[] | undefined) => {
    if (fields)
      return fields
        .map(
          ([file, field]) =>
            (file === 0
              ? left
                ? left[f1]
                : right?.[f2]
              : (file === 1 ? left : right)?.[field - 1]) ?? empty,
        )
        .join(out)
    if (left && right)
      return [
        left[f1],
        ...left.filter((_, i) => i !== f1),
        ...right.filter((_, i) => i !== f2),
      ].join(out)
    const row = (left ?? right)!
    const index = left ? f1 : f2
    return [row[index], ...row.filter((_, i) => i !== index)].join(out)
  }
  const matched = new Set<number>()
  for (const row of a) {
    const hits = b
      .map((other, index) => [other, index] as const)
      .filter(([other]) => key(other[f2]) === key(row[f1]))
    if (!hits.length && unpaired.includes('1')) ctx.stdout.write(render(row, undefined) + '\n')
    for (const [other, index] of hits) {
      matched.add(index)
      if (!only.length) ctx.stdout.write(render(row, other) + '\n')
    }
  }
  if (unpaired.includes('2'))
    for (const [index, other] of b.entries())
      if (!matched.has(index)) ctx.stdout.write(render(undefined, other) + '\n')
}

const expand: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, { flags: 'i', values: 't' })
  const tab = Number(last(parsed, 't') ?? 8)
  return eachInput(ctx, parsed.operands, (text) => {
    ctx.stdout.write(
      text
        .split('\n')
        .map((line) => {
          let out = ''
          let leading = true
          for (const char of line) {
            if (char === '\t' && (leading || !parsed.flags.has('i')))
              out += ' '.repeat(tab - (out.length % tab))
            else {
              if (char !== ' ') leading = false
              out += char
            }
          }
          return out
        })
        .join('\n'),
    )
  })
}

const file: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'biLz',
    long: { brief: 'b', mime: 'i', 'mime-type': 'M', dereference: 'L' },
  })
  const width = Math.max(0, ...parsed.operands.map((operand) => operand.length + 1))
  for (const operand of parsed.operands) {
    const path = ctx.resolve(operand)
    const stat = await ctx.fs.stat(path)
    let kind: string
    const mime = parsed.flags.has('i') || parsed.flags.has('M')
    const link = parsed.flags.has('L') ? null : await linkOf(ctx, path)
    if (link !== null) kind = mime ? 'inode/symlink' : 'symbolic link to ' + link
    else if (!stat) kind = 'cannot open \x60' + operand + "' (No such file or directory)"
    else if (stat.kind === 'directory') kind = mime ? 'inode/directory' : 'directory'
    else {
      const data = await ctx.fs.read(path)
      const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte)
      const text = decode(data.slice(0, 65536))
      const textLines = lines(text)
      const csv =
        textLines.length > 1 &&
        (() => {
          const counts = textLines.slice(0, 50).map((line) => (line.match(/,/g) ?? []).length)
          return counts[0]! > 0 && counts.every((count) => count === counts[0])
        })()
      const ascii = !/[^\x00-\x7f]/.test(text)
      const bom = starts(0xef, 0xbb, 0xbf)
      const longest = textLines.reduce(
        (max, line) => Math.max(max, line.replace(/\r$/, '').length),
        0,
      )
      const terminators = [
        longest > 300 ? 'with very long lines (' + longest + ')' : '',
        !/[\r\n]/.test(text)
          ? 'with no line terminators'
          : /\r\n/.test(text)
            ? 'with CRLF line terminators'
            : /\r/.test(text)
              ? 'with CR line terminators'
              : '',
      ].filter(Boolean)
      const encoding =
        (ascii
          ? 'ASCII text'
          : bom
            ? 'Unicode text, UTF-8 (with BOM) text'
            : 'Unicode text, UTF-8 text') + terminators.map((item) => ', ' + item).join('')
      const word = (offset: number) => data[offset]! | (data[offset + 1]! << 8)
      const long = (offset: number) =>
        ((data[offset]! << 24) |
          (data[offset + 1]! << 16) |
          (data[offset + 2]! << 8) |
          data[offset + 3]!) >>>
        0
      if (!data.length) kind = mime ? 'inode/x-empty' : 'empty'
      else if (starts(0x1f, 0x8b)) kind = mime ? 'application/gzip' : 'gzip compressed data'
      else if (
        starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) &&
        data.length >= 29 &&
        decode(data.slice(12, 16)) === 'IHDR'
      ) {
        const color =
          (
            {
              0: 'grayscale',
              2: '/color RGB',
              3: ' colormap',
              4: ' gray+alpha',
              6: '/color RGBA',
            } as Record<number, string>
          )[data[25]!] ?? ''
        kind = mime
          ? 'image/png'
          : 'PNG image data, ' +
            long(16) +
            ' x ' +
            long(20) +
            ', ' +
            data[24] +
            '-bit' +
            (color === 'grayscale' ? ' grayscale' : color) +
            ', ' +
            (data[28] ? 'interlaced' : 'non-interlaced')
      } else if (starts(0xff, 0xd8, 0xff)) kind = mime ? 'image/jpeg' : 'JPEG image data'
      else if (
        starts(0x47, 0x49, 0x46, 0x38) &&
        (data[4] === 0x37 || data[4] === 0x39) &&
        data[5] === 0x61
      )
        kind = mime
          ? 'image/gif'
          : 'GIF image data, version 8' +
            String.fromCharCode(data[4]!) +
            'a,' +
            (data.length >= 10 ? ' ' + word(6) + ' x ' + word(8) : '')
      else if (starts(0x25, 0x50, 0x44, 0x46, 0x2d))
        kind = mime
          ? 'application/pdf'
          : 'PDF document' +
            (/^%PDF-(\d+\.\d+)/.test(text) ? ', version ' + text.match(/^%PDF-(\d+\.\d+)/)![1] : '')
      else if (starts(0x50, 0x4b, 0x03, 0x04) && data.length >= 30)
        kind = mime
          ? 'application/zip'
          : 'Zip archive data, at least v' +
            (word(4) / 10).toFixed(1) +
            ' to extract, compression method=' +
            ({ 0: 'store', 8: 'deflate' } as Record<number, string>)[word(8)]!
      else if (starts(0x7f, 0x45, 0x4c, 0x46) && data.length >= 7) {
        const types: Record<number, string> = {
          1: 'relocatable',
          2: 'executable',
          3: 'pie executable',
          4: 'core file',
        }
        const machines: Record<number, string> = {
          3: 'Intel 80386',
          0x28: 'ARM',
          0x3e: 'x86-64',
          0xb7: 'ARM aarch64',
          0xf3: 'UCB RISC-V',
        }
        kind = mime
          ? 'application/x-executable'
          : 'ELF ' +
            (data[4] === 2 ? '64' : '32') +
            '-bit ' +
            (data[5] === 2 ? 'MSB' : 'LSB') +
            (data.length >= 20
              ? ' ' + (types[word(16)] ?? 'unknown') + ', ' + (machines[word(18)] ?? 'unknown arch')
              : '')
      } else if (starts(0x00, 0x61, 0x73, 0x6d))
        kind = mime
          ? 'application/wasm'
          : 'WebAssembly (wasm) binary module' +
            (data.length >= 8
              ? ' version 0x' +
                (data[4]! | (data[5]! << 8)).toString(16) +
                (data[4] === 1 ? ' (MVP)' : '')
              : '')
      else if (data.length > 262 && decode(data.slice(257, 262)) === 'ustar')
        kind = mime ? 'application/x-tar' : 'POSIX tar archive'
      else if (data.includes(0) || /[\uDC80-\uDCFF\x01-\x06\x0e-\x1a\x1c-\x1f]/.test(text))
        kind = mime ? 'application/octet-stream' : 'data'
      else if (
        /^\s*[[{]/.test(text) &&
        (() => {
          try {
            JSON.parse(decode(data))
            return true
          } catch {
            return false
          }
        })()
      )
        kind = mime ? 'application/json' : 'JSON text data'
      else if (/^#!.*\bbash\b/.test(text))
        kind = mime
          ? 'text/x-shellscript'
          : 'Bourne-Again shell script, ' + encoding + ' executable'
      else if (/^#!.*\b(sh|dash)\b/.test(text))
        kind = mime ? 'text/x-shellscript' : 'POSIX shell script, ' + encoding + ' executable'
      else if (/^#!.*\bpython/.test(text))
        kind = mime ? 'text/x-script.python' : 'Python script, ' + encoding + ' executable'
      else if (/^#!.*\bnode/.test(text))
        kind = mime ? 'application/javascript' : 'Node.js script executable, ' + encoding
      else if (/^\s*<svg[\s>]/.test(text) || /^\s*<\?xml[^>]*>\s*<svg[\s>]/.test(text))
        kind = mime ? 'image/svg+xml' : 'SVG Scalable Vector Graphics image'
      else if (/^diff --git |^--- \S.*\n\+\+\+ /m.test(text))
        kind = mime ? 'text/x-diff' : 'diff output, ' + encoding
      else if (/^(import|export)\s|^module\.exports\b/m.test(text))
        kind = mime ? 'application/javascript' : 'JavaScript source, ' + encoding
      else if (/^#include\s*[<"]|\bmain\s*\(\s*\)\s*\{/m.test(text))
        kind = mime ? 'text/x-c' : 'C source, ' + encoding
      else if (/^\s*<\?xml/.test(text)) kind = mime ? 'text/xml' : 'XML 1.0 document, ' + encoding
      else if (/^\s*<!doctype html|^\s*<html/i.test(text))
        kind = mime ? 'text/html' : 'HTML document, ' + encoding
      else if (csv) kind = mime ? 'text/csv' : 'CSV ' + encoding
      else kind = mime ? 'text/plain' : encoding
      if (parsed.flags.has('i') && !parsed.flags.has('M'))
        kind +=
          '; charset=' +
          (kind.startsWith('text/') ||
          kind === 'application/json' ||
          kind === 'application/javascript'
            ? ascii
              ? 'us-ascii'
              : 'utf-8'
            : 'binary')
    }
    if (stat?.kind === 'directory' && parsed.flags.has('i') && !parsed.flags.has('M'))
      kind += '; charset=binary'
    ctx.stdout.write(
      (parsed.flags.has('b') ? '' : (operand + ':').padEnd(width) + ' ') + kind + '\n',
    )
  }
}

type IgnoreRule = { base: string; negate: boolean; directory: boolean; regex: RegExp }

function ignoreRegExp(pattern: string): { regex: RegExp; anchored: boolean } {
  const anchored = pattern.includes('/')
  const groups: string[][] = []
  const braced = pattern.replace(/\{([^{}]*,[^{}]*)\}/g, (_, inner: string) =>
    String.fromCharCode(0xe000 + groups.push(inner.split(',')) - 1),
  )
  const body = braced
    .replace(/^\//, '')
    .replace(/(^|\/)\*\*\//g, '$1\u0001')
    .replace(/\/\*\*$/, '\u0002')
    .replace(/\*\*/g, '\u0003')
  const source = globSource(body, true)
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '/.*')
    .replace(/\u0003/g, '.*')
    .replace(
      /[\ue000-\ue0ff]/g,
      (c) =>
        '(?:' +
        groups[c.charCodeAt(0) - 0xe000]!.map((item) => globSource(item, true)).join('|') +
        ')',
    )
  return { regex: new RegExp('^' + source + '$'), anchored }
}

function ignoreRules(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/, '').replace(/(?<!\\)\s+$/, '')
    if (!line || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    if (line.startsWith('\\')) line = line.slice(1)
    const directory = line.endsWith('/')
    if (directory) line = line.slice(0, -1)
    if (!line) continue
    const { regex, anchored } = ignoreRegExp(line)
    rules.push({
      base,
      negate,
      directory,
      regex: anchored ? regex : new RegExp('(?:^|/)' + regex.source.slice(1)),
    })
  }
  return rules
}

function ignoredBy(rules: IgnoreRule[], path: string, directory: boolean): boolean | undefined {
  let result: boolean | undefined
  for (const rule of rules) {
    if (rule.directory && !directory) continue
    if (!path.startsWith(rule.base === '/' ? '/' : rule.base + '/')) continue
    const relative = path.slice(rule.base === '/' ? 1 : rule.base.length + 1)
    if (rule.regex.test(relative)) result = !rule.negate
  }
  return result
}

const RG_TYPES: Record<string, string[]> = {
  c: ['*.c', '*.h', '*.H'],
  cpp: ['*.C', '*.cc', '*.cpp', '*.cxx', '*.h', '*.H', '*.hh', '*.hpp', '*.hxx', '*.inl'],
  cs: ['*.cs'],
  css: ['*.css', '*.scss'],
  go: ['*.go'],
  html: ['*.ejs', '*.htm', '*.html'],
  java: ['*.java', '*.jsp', '*.jspx', '*.properties'],
  js: ['*.cjs', '*.js', '*.jsx', '*.mjs', '*.vue'],
  json: ['*.json', '*.jsonl', '*.sarif', 'composer.lock'],
  kotlin: ['*.kt', '*.kts'],
  lua: ['*.lua'],
  make: ['*.mak', '*.mk', 'GNUmakefile', 'Makefile', 'makefile'],
  markdown: ['*.markdown', '*.md', '*.mdown', '*.mdwn', '*.mdx', '*.mkd', '*.mkdn'],
  md: ['*.markdown', '*.md', '*.mdown', '*.mdwn', '*.mdx', '*.mkd', '*.mkdn'],
  php: ['*.php', '*.php3', '*.php4', '*.php5', '*.phtml'],
  py: ['*.py', '*.pyi'],
  python: ['*.py', '*.pyi'],
  rb: ['*.gemspec', '*.rb', '.irbrc', 'Gemfile', 'Rakefile'],
  ruby: ['*.gemspec', '*.rb', '.irbrc', 'Gemfile', 'Rakefile'],
  rust: ['*.rs'],
  sh: [
    '*.bash',
    '*.bashrc',
    '*.csh',
    '*.ksh',
    '*.sh',
    '*.tcsh',
    '*.zsh',
    '.bash_login',
    '.bash_logout',
    '.bash_profile',
    '.bashrc',
    '.profile',
    '.zshrc',
  ],
  sol: ['*.sol'],
  sql: ['*.psql', '*.sql'],
  svelte: ['*.svelte'],
  swift: ['*.swift'],
  toml: ['*.toml', 'Cargo.lock'],
  ts: ['*.cts', '*.mts', '*.ts', '*.tsx'],
  tsx: ['*.tsx'],
  txt: ['*.txt'],
  typescript: ['*.cts', '*.mts', '*.ts', '*.tsx'],
  xml: ['*.dtd', '*.xml', '*.xsd', '*.xsl', '*.xslt'],
  yaml: ['*.yaml', '*.yml'],
  zig: ['*.zig'],
}

const rg: CommandHandler = async (ctx) => {
  const args: string[] = []
  let unrestricted = 0
  for (const arg of ctx.args) {
    if (/^-u+$/.test(arg)) unrestricted += arg.length - 1
    else if (arg === '--unrestricted') unrestricted++
    else if (/^-[ilcwFvnNHIUSsoqxaLp0.zP]*r[ilcwFvnNHIUSsoqxaLp0.zP]+$/.test(arg))
      args.push(arg.replace('r', ''))
    else args.push(arg)
  }
  const replaceAt = args.indexOf('-r')
  if (
    replaceAt >= 0 &&
    replaceAt + 1 < args.length &&
    !args.includes('-e') &&
    args.some(
      (arg) =>
        /^-[a-zA-Z.0]*[lcq]/.test(arg) ||
        [
          '--files-with-matches',
          '--count',
          '--count-matches',
          '--quiet',
          '--files-without-match',
        ].includes(arg),
    )
  )
    args.splice(replaceAt, 1)
  const parsed = options(args, {
    flags: 'ilcwFvnNHIUSsoqxaLp0.zP',
    values: 'eAgCBtTmfrdjM',
    long: {
      include: 'g',
      'ignore-case': 'i',
      'files-with-matches': 'l',
      'files-without-match': '9',
      count: 'c',
      'count-matches': '8',
      'word-regexp': 'w',
      'fixed-strings': 'F',
      'invert-match': 'v',
      'line-number': 'n',
      'no-line-number': 'N',
      'with-filename': 'H',
      'no-filename': 'I',
      'only-matching': 'o',
      glob: 'g',
      iglob: 'iglob',
      context: 'C',
      'after-context': 'A',
      'before-context': 'B',
      'max-count': 'm',
      type: 't',
      'type-not': 'T',
      hidden: '.',
      'no-heading': '',
      heading: '2',
      'smart-case': 'S',
      'case-sensitive': 's',
      quiet: 'q',
      'line-regexp': 'x',
      text: 'a',
      follow: 'L',
      regexp: 'e',
      file: 'f',
      replace: 'r',
      'max-depth': 'd',
      maxdepth: 'd',
      'no-ignore': '3',
      'no-ignore-vcs': '4',
      'no-ignore-dot': '',
      'no-ignore-parent': '',
      'no-require-git': '5',
      files: '1',
      sort: 'sort',
      sortr: 'sort',
      color: '',
      colour: '',
      colors: '',
      'no-messages': '',
      column: '6',
      vimgrep: '7',
      pcre2: 'P',
      'no-config': '',
      'line-buffered': '',
      'block-buffered': '',
      null: '0',
      pretty: 'p',
      trim: '',
      threads: 'j',
      'max-columns': 'M',
      'max-filesize': '',
      'one-file-system': '',
      binary: '',
      'search-zip': 'z',
      'no-unicode': '',
      multiline: 'U',
      crlf: '',
      engine: 'engine',
    },
  })
  const f = parsed.flags
  const longFlags: Record<string, string> = {
    'count-matches': '8',
    'files-without-match': '9',
    'no-ignore': '3',
    'no-ignore-vcs': '4',
    column: '6',
    files: '1',
    heading: '2',
    vimgrep: '7',
  }
  const has = (key: string) => f.has(longFlags[key] ?? key)
  const listFiles = has('files')
  const patterns = [...(parsed.values.get('e') ?? [])]
  for (const file of parsed.values.get('f') ?? []) {
    try {
      const text = await readInput(ctx, file)
      if (text !== '')
        patterns.push(
          ...text.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1),
        )
    } catch {
      throw new CommandError(file + ': No such file or directory (os error 2)', 2)
    }
  }
  const operands = parsed.operands.slice()
  if (!listFiles && !parsed.values.has('e') && !parsed.values.has('f')) {
    const pattern = operands.shift()
    if (pattern === undefined)
      throw new CommandError('ripgrep requires at least one pattern to execute a search', 2)
    patterns.push(pattern)
  }
  const hidden = f.has('.') || unrestricted >= 2
  const noIgnore = has('no-ignore') || unrestricted >= 1
  const noVcs = noIgnore || has('no-ignore-vcs')
  const binaryText = f.has('a') || unrestricted >= 3
  const smart = f.has('S') && !f.has('s') && !f.has('i')
  const insensitive =
    (f.has('i') && !f.has('s')) ||
    (smart && !patterns.some((pattern) => /[A-Z]/.test(pattern.replace(/\\[a-zA-Z]/g, ''))))
  let extraFlags = ''
  const sources = patterns.map((pattern) => {
    let source: string
    if (f.has('F')) source = escapeRegExp(pattern)
    else {
      const perl = perlSource(
        pattern.includes('\\|') && !/(^|[^\\])\|/.test(pattern.replace(/\\\\/g, ''))
          ? pattern.replace(/\\\|/g, '|')
          : pattern,
      )
      source = perl.source
      extraFlags += perl.flags
    }
    if (f.has('w')) source = '(?<![\\w])(?:' + source + ')(?![\\w])'
    if (f.has('x')) source = '^(?:' + source + ')$'
    return source
  })
  let regex: RegExp
  try {
    const flags = new Set(('g' + (insensitive ? 'i' : '') + extraFlags).split(''))
    regex = new RegExp(
      sources.length ? sources.map((source) => '(?:' + source + ')').join('|') : '(?!)',
      [...flags].join(''),
    )
  } catch (error) {
    throw new CommandError(
      'regex parse error:\n    ' + patterns.join('|') + '\nerror: ' + (error as Error).message,
      2,
    )
  }
  const types = parsed.values.get('t') ?? []
  const notTypes = parsed.values.get('T') ?? []
  for (const type of [...types, ...notTypes])
    if (!(type in RG_TYPES) && type !== 'all')
      throw new CommandError('unrecognized file type: ' + type, 2)
  const typeMatch = (list: string[], name: string) =>
    list.some((type) => (RG_TYPES[type] ?? []).some((glob) => globRegExp(glob).test(name)))
  const globs = [
    ...(parsed.values.get('g') ?? []).map((glob) => ({ glob, insensitive: false })),
    ...(parsed.values.get('iglob') ?? []).map((glob) => ({ glob, insensitive: true })),
  ].map((item) => {
    const negate = item.glob.startsWith('!')
    const body = negate ? item.glob.slice(1) : item.glob
    const directory = body.endsWith('/')
    const { regex: match, anchored } = ignoreRegExp(directory ? body.slice(0, -1) : body)
    return {
      negate,
      directory,
      regex: new RegExp(
        anchored ? match.source : '(?:^|/)' + match.source.slice(1),
        item.insensitive ? 'i' : '',
      ),
    }
  })
  const positive = globs.some((glob) => !glob.negate)
  const override = (relative: string, directory: boolean): 'include' | 'exclude' | undefined => {
    let result: 'include' | 'exclude' | undefined
    for (const glob of globs) {
      if (glob.directory && !directory) continue
      if (glob.regex.test(relative)) result = glob.negate ? 'exclude' : 'include'
    }
    if (result === undefined && positive && !directory) return 'exclude'
    return result
  }
  const maxDepth = last(parsed, 'd') === undefined ? Infinity : Number(last(parsed, 'd'))
  const stdinText = !listFiles && !operands.length ? ctx.stdin.read() : ''
  const useStdin = stdinText !== ''
  const roots = operands.length ? operands : useStdin ? [] : ['.']
  const implicit = !operands.length
  let errors = false
  let directories = false
  const targets: {
    path: string
    display: string
    explicit: boolean
    pruned?: boolean
    matched?: boolean
  }[] = []
  const gitRoot = async (path: string): Promise<boolean> => {
    for (let dir = path; ; dir = parentOf(dir)) {
      if (await ctx.fs.stat((dir === '/' ? '' : dir) + '/.git')) return true
      if (dir === '/') return false
    }
  }
  const loadRules = async (dir: string, git: boolean): Promise<IgnoreRule[]> => {
    const rules: IgnoreRule[] = []
    const names = [
      ...(git && !noVcs ? ['.gitignore'] : []),
      ...(noIgnore ? [] : ['.ignore', '.rgignore']),
    ]
    for (const name of names) {
      const path = (dir === '/' ? '' : dir) + '/' + name
      const stat = await ctx.fs.stat(path)
      if (stat?.kind === 'file') rules.push(...ignoreRules(decode(await ctx.fs.read(path)), dir))
    }
    return rules
  }
  const prunable =
    !listFiles && !f.has('v') && !has('files-without-match')
      ? literals(patterns, f.has('F') ? 'fixed' : 'perl')
      : null
  const exactTerms =
    (f.has('l') || f.has('q')) &&
    !listFiles &&
    !f.has('v') &&
    !f.has('w') &&
    !f.has('x') &&
    !f.has('c') &&
    !has('count-matches') &&
    !has('files-without-match')
      ? exactLiterals(patterns, f.has('F') ? 'fixed' : 'perl')
      : null
  let narrowed = false
  const walk = async (
    path: string,
    display: string,
    depth: number,
    rules: IgnoreRule[],
    git: boolean,
    root: string,
    tree: Pruned | null,
  ) => {
    if (depth > maxDepth) return
    const local = rules.concat(await loadRules(path, git))
    for (const name of tree ? prunedList(tree, path) : await ctx.fs.list(path)) {
      const child = (path === '/' ? '' : path) + '/' + name
      const stat = tree ? prunedStat(tree, child) : await ctx.fs.stat(child)
      if (!stat) continue
      const directory = stat.kind === 'directory'
      if (depth + 1 > maxDepth) continue
      const relative = child.slice(root === '/' ? 1 : root.length + 1)
      const decision = override(relative, directory)
      if (decision === 'exclude') continue
      if (decision !== 'include') {
        if (!hidden && name.startsWith('.')) continue
        if (name === '.git' && directory && !hidden) continue
        if (ignoredBy(local, child, directory)) continue
      }
      const shown =
        display === '' ? name : display.endsWith('/') ? display + name : display + '/' + name
      if (directory) {
        await walk(child, shown, depth + 1, local, git, root, tree)
        continue
      }
      if (types.length && !types.includes('all') && !typeMatch(types, name)) continue
      if (notTypes.length && typeMatch(notTypes, name)) continue
      targets.push({
        path: child,
        display: shown,
        explicit: false,
        pruned: !!tree,
        matched: !!tree?.exact,
      })
    }
  }
  for (const root of roots) {
    const path = ctx.resolve(root)
    const stat = await ctx.fs.stat(path)
    if (!stat) {
      ctx.stderr.write('rg: ' + root + ': No such file or directory (os error 2)\n')
      errors = true
      continue
    }
    if (stat.kind === 'file') {
      targets.push({ path, display: root, explicit: true, pruned: !!prunable })
      continue
    }
    directories = true
    const git = await gitRoot(path)
    const inherited: IgnoreRule[] = []
    const ancestors: string[] = []
    for (let dir = parentOf(path); ; dir = parentOf(dir)) {
      ancestors.unshift(dir)
      if (dir === '/') break
    }
    for (const dir of ancestors) inherited.push(...(await loadRules(dir, git)))
    const tree = await pruned(
      ctx.fs,
      path,
      prunable,
      exactTerms && { literals: exactTerms, ignoreCase: insensitive },
    )
    if (tree && !types.length && !notTypes.length) narrowed = true
    await walk(path, implicit ? '' : root, 0, inherited, git, path, tree)
  }
  if (listFiles) {
    for (const target of targets) ctx.stdout.write(target.display + (f.has('0') ? '\0' : '\n'))
    return errors ? 2 : targets.length ? 0 : 1
  }
  const named = f.has('H') || has('vimgrep') || (!f.has('I') && (roots.length > 1 || directories))
  const heading = has('heading') && !has('vimgrep')
  const numbers = (f.has('n') || has('vimgrep') || has('column')) && !f.has('N')
  const context = Number(last(parsed, 'C') ?? 0)
  const after = Number(last(parsed, 'A') ?? context)
  const before = Number(last(parsed, 'B') ?? context)
  const max = last(parsed, 'm') === undefined ? Infinity : Number(last(parsed, 'm'))
  const replace = last(parsed, 'r')
    ?.replace(/\$\{(\d+)\}/g, '$$$1')
    .replace(/\$\{(\w+)\}/g, '$$<$1>')
    .replace(/\$([A-Za-z_]\w*)/g, '$$<$1>')
  const state = { printed: false }
  let found = false
  let firstHeading = true
  const search = (text: string, display: string | undefined, explicit: boolean) => {
    if (!binaryText && text.includes('\0')) {
      if (!explicit) return
      const offset = text.indexOf('\0')
      const head = text.slice(0, offset)
      regex.lastIndex = 0
      const hits = scan(head, {
        regex,
        invert: f.has('v'),
        max,
        before: 0,
        after: 0,
        only: false,
        numbers: false,
        terminator: '\n',
        silent: true,
        state,
        write: () => {},
      })
      if (!hits) return
      found = true
      if (f.has('q')) return
      if (f.has('l')) ctx.stdout.write((display ?? '<stdin>') + '\n')
      else if (f.has('c'))
        ctx.stdout.write((named && display !== undefined ? display + ':' : '') + hits + '\n')
      else
        ctx.stdout.write(
          (display !== undefined && named ? display + ': ' : '') +
            'binary file matches (found "\\0" byte around offset ' +
            offset +
            ')\n',
        )
      return
    }
    const counting = f.has('c') || has('count-matches')
    const silent = f.has('q') || f.has('l') || has('files-without-match') || counting
    let output = ''
    const prefix = named && !heading ? (display ?? '<stdin>') : undefined
    const matches = scan(text, {
      regex,
      invert: f.has('v'),
      max,
      before,
      after,
      only: f.has('o'),
      numbers,
      column: has('column') || has('vimgrep'),
      name: prefix,
      terminator: '\n',
      replace,
      silent,
      state,
      write: (chunk) => void (output += chunk),
    })
    if (matches) found = true
    if (f.has('q')) return
    if (f.has('l') && matches) ctx.stdout.write((display ?? '<stdin>') + (f.has('0') ? '\0' : '\n'))
    if (has('files-without-match') && !matches) ctx.stdout.write((display ?? '<stdin>') + '\n')
    if (counting && matches) {
      let total = matches
      if (has('count-matches')) {
        total = 0
        for (const line of text.split('\n')) {
          regex.lastIndex = 0
          total += [...line.matchAll(regex)].length
        }
      }
      ctx.stdout.write((named ? (display ?? '<stdin>') + ':' : '') + total + '\n')
    }
    if (!silent && output) {
      if (heading && named) {
        ctx.stdout.write((firstHeading ? '' : '\n') + (display ?? '<stdin>') + '\n')
        firstHeading = false
      }
      ctx.stdout.write(output)
    }
  }
  if (!useStdin && !targets.length && !errors && !narrowed) {
    ctx.stderr.write(
      "rg: No files were searched, which means ripgrep probably applied a filter you didn't expect.\nRunning with --debug will show why files are being skipped.\n",
    )
    return 2
  }
  if (useStdin) search(stdinText, f.has('H') ? '<stdin>' : undefined, true)
  const partial =
    prunable && !before && !after && !has('column') && !has('vimgrep') && !f.has('U')
      ? prunable
      : null
  const take = ahead(targets, (target) =>
    target.matched
      ? null
      : partial && target.pruned
        ? (ctx.fs
            .excerpt?.(target.path, partial)
            .then((bytes) => bytes ?? ctx.fs.read(target.path)) ?? ctx.fs.read(target.path))
        : ctx.fs.read(target.path),
  )
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]
    const pending = take(index)!
    if (ctx.stdout.closed) throw new PipeError()
    if (target.matched) {
      found = true
      if (f.has('q')) return 0
      ctx.stdout.write(target.display + (f.has('0') ? '\0' : '\n'))
      continue
    }
    let text: string
    try {
      text = decode(await pending)
    } catch {
      ctx.stderr.write('rg: ' + target.display + ': failed to read\n')
      errors = true
      continue
    }
    search(text, target.display, target.explicit)
    if (found && f.has('q')) return 0
  }
  if (errors) return 2
  return found ? 0 : 1
}

const ln: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'sfnvrTiL',
    values: 't',
    long: {
      symbolic: 's',
      force: 'f',
      'no-dereference': 'n',
      verbose: 'v',
      relative: 'r',
      'target-directory': 't',
      'no-target-directory': 'T',
    },
  })
  const fs = linked(ctx)
  const f = parsed.flags
  const operands = [...parsed.operands]
  if (!operands.length) throw new CommandError('missing file operand', 1)
  let directory = last(parsed, 't')
  if (directory === undefined && operands.length > 1) {
    const candidate = operands[operands.length - 1]!
    const stat =
      f.has('n') || f.has('T')
        ? (await linkOf(ctx, ctx.resolve(candidate))) === null
          ? await fs.stat(ctx.resolve(candidate))
          : null
        : await fs.stat(ctx.resolve(candidate))
    if (stat?.kind === 'directory' || operands.length > 2) directory = operands.pop()
  }
  const pairs: [string, string][] =
    directory !== undefined
      ? operands.map((source) => [
          source,
          directory.replace(/\/+$/, '') + '/' + baseOf(source.replace(/\/+$/, '')),
        ])
      : operands.length === 1
        ? [[operands[0]!, baseOf(operands[0]!.replace(/\/+$/, ''))]]
        : [[operands[0]!, operands[1]!]]
  let status = 0
  for (const [source, destination] of pairs) {
    const target = ctx.resolve(destination)
    const fail = (message: string) => {
      ctx.stderr.write('ln: ' + message + '\n')
      status = 1
    }
    const exists = (await fs.stat(target)) !== null || (await linkOf(ctx, target)) !== null
    if (exists && !f.has('f')) {
      fail(
        'failed to create ' +
          (f.has('s') ? 'symbolic ' : 'hard ') +
          "link '" +
          destination +
          "': File exists",
      )
      continue
    }
    if (f.has('s') && fs.symlink) {
      if (exists) await fs.remove(target)
      await fs.symlink(source, target)
      if (f.has('v')) ctx.stdout.write("'" + destination + "' -> '" + source + "'\n")
      continue
    }
    const from = ctx.resolve(
      f.has('s') && !source.startsWith('/') ? parentOf(target) + '/' + source : source,
    )
    const stat = await fs.stat(from)
    if (!stat) {
      fail(
        (f.has('s') ? "failed to access '" : "failed to access '") +
          source +
          "': No such file or directory",
      )
      continue
    }
    if (stat.kind === 'directory') {
      fail(source + ': hard link not allowed for directory')
      continue
    }
    if (exists) await fs.remove(target)
    await fs.write(target, await fs.read(from))
    if (fs.chmod) await fs.chmod(target, stat.mode)
    if (f.has('s'))
      ctx.stderr.write(
        "ln: this filesystem has no symbolic links; copied '" + source + "' instead\n",
      )
    if (f.has('v')) ctx.stdout.write("'" + destination + "' => '" + source + "'\n")
  }
  return status
}

const truncate: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'co',
    values: 'sr',
    long: { 'no-create': 'c', 'io-blocks': 'o', size: 's', reference: 'r' },
  })
  const spec = last(parsed, 's')
  const reference = last(parsed, 'r')
  if (spec === undefined && reference === undefined)
    throw new CommandError("you must specify either '--size' or '--reference'")
  if (!parsed.operands.length) throw new CommandError('missing file operand')
  const match = spec?.match(/^([-+<>\/%]?)(\d+)([KMGT]?)(i?B?)$/i)
  if (spec !== undefined && !match) throw new CommandError("Invalid number: '" + spec + "'")
  const unit = match
    ? (match[4]?.toUpperCase() === 'B' && !match[4].toLowerCase().startsWith('i') ? 1000 : 1024) **
      ' KMGT'.indexOf((match[3] || ' ').toUpperCase())
    : 1
  const amount = match ? Number(match[2]) * unit : 0
  const refSize = reference === undefined ? 0 : (await ctx.fs.stat(ctx.resolve(reference)))?.size
  if (refSize === undefined)
    throw new CommandError("cannot stat '" + reference + "': No such file or directory")
  let status = 0
  for (const operand of parsed.operands) {
    const path = ctx.resolve(operand)
    const stat = await ctx.fs.stat(path)
    if (!stat && parsed.flags.has('c')) continue
    if (stat?.kind === 'directory') {
      ctx.stderr.write("truncate: cannot open '" + operand + "' for writing: Is a directory\n")
      status = 1
      continue
    }
    const data = stat ? await ctx.fs.read(path) : new Uint8Array(0)
    const current = data.length
    const op = match?.[1] ?? ''
    let size = spec === undefined ? refSize : amount
    if (op === '+') size = current + amount
    else if (op === '-') size = Math.max(0, current - amount)
    else if (op === '<') size = Math.min(current, amount)
    else if (op === '>') size = Math.max(current, amount)
    else if (op === '/') size = amount ? Math.floor(current / amount) * amount : current
    else if (op === '%') size = amount ? Math.ceil(current / amount) * amount : current
    const out = new Uint8Array(size)
    out.set(data.subarray(0, Math.min(size, current)))
    try {
      await ctx.fs.write(path, out)
    } catch (error) {
      ctx.stderr.write(
        "truncate: cannot open '" +
          operand +
          "' for writing: " +
          (error instanceof FsError && error.code === 'ENOENT'
            ? 'No such file or directory'
            : (error as Error).message) +
          '\n',
      )
      status = 1
    }
  }
  return status
}

const shuf: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'erz',
    values: 'nio',
    long: {
      echo: 'e',
      repeat: 'r',
      'zero-terminated': 'z',
      'head-count': 'n',
      'input-range': 'i',
      output: 'o',
      'random-source': 'random-source',
    },
  })
  const separator = parsed.flags.has('z') ? '\0' : '\n'
  let size: number
  let item: (index: number) => string
  let status = 0
  let bytes = 0
  const range = last(parsed, 'i')
  if (range !== undefined) {
    const match = range.match(/^(\d+)-(\d+)$/)
    if (!match || Number(match[1]) > Number(match[2]) + 1)
      throw new CommandError("invalid input range: '" + range + "'")
    const from = Number(match[1])
    const to = Number(match[2])
    if (to - from > 10_000_000) throw new CommandError('input range too large')
    size = to - from + 1
    item = (index) => String(from + index)
  } else if (parsed.flags.has('e')) {
    const operands = parsed.operands
    size = operands.length
    item = (index) => operands[index]!
  } else {
    const result = await allInput(ctx, parsed.operands.slice(0, 1))
    const text = result.text
    status = result.status
    bytes = text.length
    let count = 0
    for (let at = text.indexOf(separator); at >= 0; at = text.indexOf(separator, at + 1)) count++
    if (text && !text.endsWith(separator)) count++
    budget(ctx.limits, bytes + 8 * count, 'shuf: ' + count + ' lines')
    const starts = new Uint32Array(count)
    for (let index = 0, start = 0; index < count; index++) {
      starts[index] = start
      const end = text.indexOf(separator, start)
      start = end < 0 ? text.length : end + 1
    }
    size = count
    item = (index) => {
      const start = starts[index]!
      const end = text.indexOf(separator, start)
      return text.slice(start, end < 0 ? text.length : end)
    }
  }
  const count = last(parsed, 'n') === undefined ? undefined : Number(last(parsed, 'n'))
  if (count !== undefined && (!Number.isInteger(count) || count < 0))
    throw new CommandError("invalid line count: '" + last(parsed, 'n') + "'")
  const target = last(parsed, 'o')
  const parts: string[] = []
  let out = ''
  const emit = async (text: string) => {
    out += text + separator
    if (out.length < 1 << 16) return
    if (target === undefined) await put(ctx, out)
    else parts.push(out)
    out = ''
  }
  if (parsed.flags.has('r')) {
    if (size)
      for (let i = 0; i < (count ?? 1000); i++) await emit(item(Math.floor(Math.random() * size)))
    else if (count) throw new CommandError('no lines to repeat')
  } else {
    budget(ctx.limits, bytes + 12 * size, 'shuf: ' + size + ' lines')
    const pool = new Uint32Array(size)
    for (let i = 0; i < size; i++) pool[i] = i
    for (let i = size - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const swap = pool[i]!
      pool[i] = pool[j]!
      pool[j] = swap
    }
    const total = count === undefined ? size : Math.min(size, count)
    for (let i = 0; i < total; i++) await emit(item(pool[i]!))
  }
  if (target === undefined) await put(ctx, out)
  else {
    parts.push(out)
    await ctx.fs.write(ctx.resolve(target), encode(parts.join('')))
  }
  return status
}

type FmtWord = {
  text: string
  length: number
  space: number
  gap: string
  period: boolean
  punct: boolean
  final: boolean
  paren: boolean
}

function fmtWidth(indent: string): number {
  let width = 0
  for (const c of indent) width = c === '\t' ? (Math.floor(width / 8) + 1) * 8 : width + 1
  return width
}

function fmtParagraph(
  words: FmtWord[],
  indent: number,
  maxWidth: number,
  goal: number,
  lastLength: number,
): { next: number[]; best: number[]; lineLength: number[] } {
  const n = words.length
  const best = new Array<number>(n + 1).fill(0)
  const next = new Array<number>(n + 1).fill(n)
  const lineLength = new Array<number>(n + 1).fill(0)
  const square = (x: number) => x * x
  const short = (x: number) => square(x * 10)
  const ragged = (x: number) => short(x) / 2
  const lineCost = (w: number, len: number) => {
    if (w === n) return 0
    let cost = short(goal - len)
    if (next[w] !== n) cost += ragged(len - lineLength[w]!)
    return cost
  }
  const baseCost = (index: number) => {
    let cost = square(70)
    const word = words[index]!
    if (index > 0) {
      const previous = words[index - 1]!
      if (previous.period) cost += previous.final ? -square(50) : square(600)
      else if (previous.punct) cost -= square(40)
      else if (index > 1 && words[index - 2]!.final) cost += square(200) / (previous.length + 2)
    }
    if (word.paren) cost -= square(40)
    else if (word.final) cost += square(150) / (word.length + 2)
    return cost
  }
  for (let start = n - 1; start >= 0; start--) {
    let bestCost = Infinity
    let len = indent + words[start]!.length
    let w = start
    for (;;) {
      w++
      const cost =
        lineCost(w, len) + best[w]! + (start === 0 && lastLength > 0 ? ragged(len - lastLength) : 0)
      if (cost < bestCost) {
        bestCost = cost
        next[start] = w
        lineLength[start] = len
      }
      if (w === n) break
      len += words[w - 1]!.space + words[w]!.length
      if (len >= maxWidth) break
    }
    best[start] = bestCost + baseCost(start)
  }
  return { next, best, lineLength }
}

const fmt: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'cstu',
    values: 'wgp',
    numeric: true,
    long: {
      width: 'w',
      goal: 'g',
      'split-only': 's',
      'uniform-spacing': 'u',
      'crown-margin': 'c',
      'tagged-paragraph': 't',
      prefix: 'p',
    },
  })
  const width = Number(last(parsed, 'w') ?? last(parsed, 'n') ?? 75)
  const goal = Number(last(parsed, 'g') ?? Math.floor((width * 187) / 200))
  const splitOnly = parsed.flags.has('s')
  const { text, status } = await allInput(ctx, parsed.operands)
  const out: string[] = []
  const all = text.split('\n')
  if (all[all.length - 1] === '') all.pop()
  const wordsOf = (line: string): FmtWord[] => {
    const words: FmtWord[] = []
    const pattern = /(\S+)(\s*)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(line))) {
      const text = match[1]!
      const gap = match[2]!
      const end = match.index + text.length
      const atEnd = end + gap.length >= line.length
      const space = atEnd
        ? 1
        : fmtWidth(line.slice(0, end + gap.length)) - fmtWidth(line.slice(0, end))
      const period = /[.?!][)\]'"]*$/.test(text)
      const final = period && (atEnd || space > 1)
      words.push({
        text,
        length: encode(text).length,
        space: atEnd || parsed.flags.has('u') ? (final ? 2 : 1) : space,
        gap: atEnd || parsed.flags.has('u') ? (final ? '  ' : ' ') : gap,
        period,
        punct: /[!-\/:-@\[-\x60{-~]$/.test(text),
        final,
        paren: /^[(\['\x60"]/.test(text),
      })
    }
    return words
  }
  let i = 0
  const emit = (indent: string, words: FmtWord[], next: number[], end: number) => {
    for (let start = 0; start < end; start = next[start]!) {
      let text = indent
      for (let k = start; k < next[start]!; k++)
        text += words[k]!.text + (k < next[start]! - 1 ? words[k]!.gap : '')
      out.push(text)
    }
  }
  while (i < all.length) {
    const line = all[i]!
    if (line.trim() === '') {
      out.push('')
      i++
      continue
    }
    const indent = line.match(/^\s*/)![0]
    const indentWidth = fmtWidth(indent)
    let words: FmtWord[] = []
    let chars = 0
    let lastLength = 0
    const add = (word: FmtWord) => {
      if (words.length >= 1000 || chars + word.length > 5000) {
        const result = fmtParagraph(words, indentWidth, width, goal, lastLength)
        let split = words.length
        let bestBreak = Infinity
        for (let w = result.next[0]!; w !== words.length; w = result.next[w]!) {
          const cost = result.best[w]! - result.best[result.next[w]!]!
          if (cost < bestBreak) {
            split = w
            bestBreak = cost
          }
          bestBreak += 4900
        }
        emit(indent, words, result.next, split)
        for (let start = 0; start < split; start = result.next[start]!)
          lastLength = result.lineLength[start]!
        words = words.slice(split)
        chars = words.reduce((sum, item) => sum + item.length, 0)
      }
      words.push(word)
      chars += word.length
    }
    if (splitOnly) {
      wordsOf(line).forEach(add)
      i++
    } else
      while (i < all.length && all[i]!.trim() !== '' && all[i]!.match(/^\s*/)![0] === indent) {
        wordsOf(all[i]!).forEach(add)
        i++
      }
    emit(
      indent,
      words,
      fmtParagraph(words, indentWidth, width, goal, lastLength).next,
      words.length,
    )
  }
  ctx.stdout.write(out.map((line) => line + '\n').join(''))
  return status
}

function hexFormat(specs: string[], data: Uint8Array, skip: number): string {
  type Unit = { iterations: number; bytes: number | undefined; format: string }
  const units: Unit[] = []
  let tail = ''
  for (const spec of specs) {
    const pattern = /\s*(\d+)?\s*(?:\/\s*(\d+))?\s*"((?:[^"\\]|\\[\s\S])*)"/g
    for (let match = pattern.exec(spec); match; match = pattern.exec(spec)) {
      const format = match[3]!.replace(
        /\\([\s\S])/g,
        (_, c: string) =>
          ({ n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' })[c] ?? c,
      )
      if (/%_A[dox]/.test(format)) {
        tail += format
        continue
      }
      units.push({
        iterations: match[1] ? Number(match[1]) : 1,
        bytes: match[2] ? Number(match[2]) : undefined,
        format,
      })
    }
  }
  const conversion =
    /%([-+ #0]*)(\d*)(?:\.(\d+))?(_[acpAu]|_a[dox]|_A[dox]|[diouxXcsefgEG%])([dox]?)/g
  const size = (kind: string) =>
    kind === '%' || kind.startsWith('_a') || kind.startsWith('_A')
      ? 0
      : kind === 'c' || kind.startsWith('_')
        ? 1
        : /[efgEG]/.test(kind)
          ? 8
          : 4
  const named: Record<number, string> = {
    0: '\\0',
    7: '\\a',
    8: '\\b',
    9: '\\t',
    10: '\\n',
    11: '\\v',
    12: '\\f',
    13: '\\r',
  }
  let out = ''
  let offset = 0
  const render = (format: string, bytes: number | undefined): boolean => {
    let ended = false
    out += format.replace(
      conversion,
      (
        whole,
        flags: string,
        width: string,
        precision: string | undefined,
        kind: string,
        base: string,
      ) => {
        if (kind === '%') return '%'
        if (kind === '_a') kind += base
        const pad = (text: string, numeric = false) => {
          const w = Number(width || 0)
          let t = text
          if (precision !== undefined && numeric) t = t.padStart(Number(precision), '0')
          if (t.length >= w) return t
          return flags.includes('-')
            ? t.padEnd(w)
            : flags.includes('0') && numeric
              ? t.padStart(w, '0')
              : t.padStart(w)
        }
        if (kind.startsWith('_a')) {
          const radix = kind[2] === 'd' ? 10 : kind[2] === 'o' ? 8 : 16
          return pad((skip + offset).toString(radix), true)
        }
        const count = bytes ?? size(kind)
        if (offset >= data.length) {
          ended = true
          return pad('')
        }
        const chunk = data.subarray(offset, offset + count)
        offset += count
        let value = 0n
        for (let i = chunk.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(chunk[i]!)
        const signed = BigInt.asIntN(count * 8 || 8, value)
        if (kind === '_p')
          return pad(chunk[0]! >= 0x20 && chunk[0]! < 0x7f ? String.fromCharCode(chunk[0]!) : '.')
        if (kind === '_c' || kind === 'c') {
          const b = chunk[0]!
          if (b >= 0x20 && b < 0x7f) return pad(String.fromCharCode(b))
          return pad(
            kind === '_c' ? (named[b] ?? b.toString(8).padStart(3, '0')) : String.fromCharCode(b),
          )
        }
        if (kind === '_u')
          return pad(
            chunk[0]! < 0x20
              ? [
                  'nul',
                  'soh',
                  'stx',
                  'etx',
                  'eot',
                  'enq',
                  'ack',
                  'bel',
                  'bs',
                  'ht',
                  'lf',
                  'vt',
                  'ff',
                  'cr',
                  'so',
                  'si',
                  'dle',
                  'dc1',
                  'dc2',
                  'dc3',
                  'dc4',
                  'nak',
                  'syn',
                  'etb',
                  'can',
                  'em',
                  'sub',
                  'esc',
                  'fs',
                  'gs',
                  'rs',
                  'us',
                ][chunk[0]!]!
              : chunk[0] === 0x7f
                ? 'del'
                : String.fromCharCode(chunk[0]!),
          )
        if (kind === 'd' || kind === 'i') return pad(signed.toString(), true)
        if (kind === 'u') return pad(value.toString(), true)
        if (kind === 'o') return pad((flags.includes('#') ? '0' : '') + value.toString(8), true)
        if (kind === 'x' || kind === 'X') {
          const text = value.toString(16)
          return pad(
            (flags.includes('#') ? '0x' : '') + (kind === 'X' ? text.toUpperCase() : text),
            true,
          )
        }
        if (/[efgEG]/.test(kind)) {
          const view = new DataView(chunk.slice().buffer)
          const number =
            chunk.length >= 8
              ? view.getFloat64(0, true)
              : chunk.length >= 4
                ? view.getFloat32(0, true)
                : 0
          return pad(
            kind === 'e' || kind === 'E'
              ? number.toExponential(Number(precision ?? 6))
              : number.toFixed(Number(precision ?? 6)),
            true,
          )
        }
        return whole
      },
    )
    return ended
  }
  while (offset < data.length) {
    const start = offset
    for (const unit of units) {
      const converts = new RegExp(conversion.source).test(unit.format.replace(/%%/g, ''))
      for (let k = 0; k < unit.iterations; k++) {
        if (converts && offset >= data.length && !/%_a/.test(unit.format)) break
        const format =
          unit.iterations > 1 && k === unit.iterations - 1
            ? unit.format.replace(/[ \t]+$/, '')
            : unit.format
        render(format, unit.bytes)
      }
    }
    if (offset === start) break
  }
  if (tail)
    out += tail.replace(/%(\d*)_A([dox])/g, (_, width: string, base: string) =>
      (skip + data.length)
        .toString(base === 'd' ? 10 : base === 'o' ? 8 : 16)
        .padStart(Number(width || 0), '0'),
    )
  return out
}

const hexdump: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'Cbcdovx',
    values: 'nse',
    long: { canonical: 'C', length: 'n', skip: 's' },
  })
  const chunks: Uint8Array[] = []
  let status = 0
  for (const operand of parsed.operands.length ? parsed.operands : ['-']) {
    try {
      if (operand === '-') chunks.push(encode(ctx.stdin.read()))
      else {
        const path = ctx.resolve(operand)
        const special = (await ctx.fs.stat(path))
          ? undefined
          : device(path, Number(last(parsed, 'n') ?? 65536) + Number(last(parsed, 's') ?? 0))
        chunks.push(special !== undefined ? encode(special) : await ctx.fs.read(path))
      }
    } catch {
      ctx.stderr.write('hexdump: ' + operand + ': No such file or directory\n')
      status = 1
    }
  }
  let data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    data.set(chunk, at)
    at += chunk.length
  }
  const skip = Number(last(parsed, 's') ?? 0)
  const length = last(parsed, 'n') === undefined ? data.length : Number(last(parsed, 'n'))
  data = data.subarray(Math.min(skip, data.length), Math.min(data.length, skip + length))
  const formats = parsed.values.get('e')
  if (formats?.length) {
    await put(ctx, hexFormat(formats, data, skip))
    return status
  }
  const canonical = parsed.flags.has('C')
  let previous: string | undefined
  let starred = false
  for (let offset = 0; offset < data.length; offset += 16) {
    const row = data.subarray(offset, offset + 16)
    const key = Array.from(row).join(',')
    if (row.length === 16 && key === previous && !parsed.flags.has('v')) {
      if (!starred) ctx.stdout.write('*\n')
      starred = true
      continue
    }
    starred = false
    previous = row.length === 16 ? key : undefined
    const address = skip + offset
    if (canonical) {
      let hex = ''
      for (let i = 0; i < 16; i++)
        hex +=
          (i < row.length ? row[i]!.toString(16).padStart(2, '0') : '  ') +
          ' ' +
          (i === 7 ? ' ' : '')
      const ascii = Array.from(row, (byte) =>
        byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.',
      ).join('')
      ctx.stdout.write(address.toString(16).padStart(8, '0') + '  ' + hex + ' |' + ascii + '|\n')
      if (ctx.stdout.backlog) await pause(ctx)
    } else {
      let line = address.toString(16).padStart(7, '0')
      for (let i = 0; i < row.length; i += 2)
        line += ' ' + ((row[i + 1] ?? 0) * 256 + row[i]!).toString(16).padStart(4, '0')
      ctx.stdout.write(line.padEnd(47) + '\n')
      if (ctx.stdout.backlog) await pause(ctx)
    }
  }
  if (data.length || skip)
    ctx.stdout.write((skip + data.length).toString(16).padStart(canonical ? 8 : 7, '0') + '\n')
  return status
}

const NUMFMT_UNITS = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y']

const numfmt: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'z',
    values: 'd',
    long: {
      to: 'to',
      from: 'from',
      'to-unit': 'to-unit',
      'from-unit': 'from-unit',
      suffix: 'suffix',
      field: 'field',
      format: 'format',
      padding: 'padding',
      round: 'round',
      header: 'header',
      invalid: 'invalid',
      delimiter: 'd',
      grouping: '',
      'zero-terminated': 'z',
    },
  })
  const to = last(parsed, 'to')
  const from = last(parsed, 'from')
  const suffix = last(parsed, 'suffix') ?? ''
  const round = last(parsed, 'round') ?? 'from-zero'
  const formatSpec = last(parsed, 'format')
  const padding = last(parsed, 'padding') === undefined ? 0 : Number(last(parsed, 'padding'))
  const fieldSpec = last(parsed, 'field') ?? '1'
  const delimiter = last(parsed, 'd')
  const fromUnit = Number(last(parsed, 'from-unit') ?? 1)
  const toUnit = Number(last(parsed, 'to-unit') ?? 1)
  const rounder = (value: number) =>
    round === 'up'
      ? Math.ceil(value)
      : round === 'down'
        ? Math.floor(value)
        : round === 'towards-zero'
          ? Math.trunc(value)
          : round === 'nearest'
            ? Math.round(value)
            : value < 0
              ? -Math.ceil(-value)
              : Math.ceil(value)
  const parse = (text: string): number => {
    const match = text.trim().match(/^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)([KMGTPEZY]?)(i?)$/i)
    if (!match) throw new CommandError("invalid number: '" + text + "'", 2)
    const unit = NUMFMT_UNITS.indexOf((match[2] ?? '').toUpperCase())
    if (unit > 0 && (from === undefined || from === 'none'))
      throw new CommandError("rejecting suffix in input: '" + text + "' (consider using --from)", 2)
    const base =
      from === 'si'
        ? 1000
        : from === 'iec' || from === 'iec-i'
          ? 1024
          : from === 'auto'
            ? match[3]
              ? 1024
              : 1000
            : 1
    return Number(match[1]) * base ** Math.max(0, unit) * fromUnit
  }
  const render = (raw: number): string => {
    const value = raw / toUnit
    let text: string
    if (to === undefined || to === 'none') {
      if (formatSpec !== undefined) {
        const precision = formatSpec.match(/\.(\d+)/)
        const digits = precision ? Number(precision[1]) : 0
        const scaled = rounder(value * 10 ** digits) / 10 ** digits
        text = format(
          formatSpec.replace(/%([-0'#]*\d*)(?:\.\d+)?f/, '%$1.' + digits + 'f'),
          [scaled],
          false,
        ).text
        return text
      }
      text = String(Number.isInteger(value) ? value : rounder(value))
    } else {
      const base = to === 'si' ? 1000 : 1024
      let scaled = Math.abs(value)
      let unit = 0
      while (scaled >= base && unit < NUMFMT_UNITS.length - 1) {
        scaled /= base
        unit++
      }
      const precision = formatSpec?.match(/\.(\d+)/)
      let body: string
      if (unit === 0) body = String(rounder(scaled))
      else if (precision) {
        const digits = Number(precision[1])
        body = (rounder(scaled * 10 ** digits) / 10 ** digits).toFixed(digits)
      } else if (scaled < 10) {
        let tenths = rounder(scaled * 10) / 10
        if (tenths >= 10) body = '10'
        else body = tenths.toFixed(1)
        if (tenths >= base) {
          tenths = 1
          unit++
          body = '1.0'
        }
      } else {
        let whole = rounder(scaled)
        if (whole >= base) {
          whole = 1
          unit++
          body = '1.0'
        } else body = String(whole)
      }
      text =
        (value < 0 ? '-' : '') + body + NUMFMT_UNITS[unit] + (unit && to === 'iec-i' ? 'i' : '')
    }
    text += suffix
    if (formatSpec !== undefined && to !== undefined) {
      const width = formatSpec.match(/%(-?)(\d+)/)
      if (width) text = width[1] ? text.padEnd(Number(width[2])) : text.padStart(Number(width[2]))
    }
    if (padding) text = padding < 0 ? text.padEnd(-padding) : text.padStart(padding)
    return text
  }
  const fields = (count: number): Set<number> => {
    const set = new Set<number>()
    for (const part of fieldSpec.split(',')) {
      const match = part.match(/^(\d*)(-?)(\d*)$/)
      if (!match) throw new CommandError("invalid field value '" + fieldSpec + "'")
      const start = match[1] ? Number(match[1]) : 1
      const end = match[2] ? (match[3] ? Number(match[3]) : count) : start
      for (let n = start; n <= end; n++) set.add(n)
    }
    return set
  }
  const convert = (line: string): string => {
    if (delimiter !== undefined) {
      const parts = line.split(delimiter)
      const wanted = fields(parts.length)
      return parts
        .map((part, index) => (wanted.has(index + 1) ? render(parse(part)) : part))
        .join(delimiter)
    }
    const lead = line.match(/^\s*/)![0]
    const parts = line.trim().split(/\s+/)
    const wanted = fields(parts.length)
    return (
      lead +
      parts.map((part, index) => (wanted.has(index + 1) ? render(parse(part)) : part)).join(' ')
    )
  }
  let status = 0
  const handle = (line: string) => {
    try {
      ctx.stdout.write(convert(line) + '\n')
    } catch (error) {
      if (!(error instanceof CommandError)) throw error
      ctx.stderr.write('numfmt: ' + error.message + '\n')
      status = 2
    }
  }
  if (parsed.operands.length) for (const operand of parsed.operands) handle(operand)
  else {
    const all = lines(ctx.stdin.read())
    const header = Number(last(parsed, 'header') ?? 0)
    all.slice(0, header).forEach((line) => ctx.stdout.write(line + '\n'))
    for (const line of all.slice(header)) handle(line)
  }
  return status
}

const iconv: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'cls',
    values: 'fto',
    long: { 'from-code': 'f', 'to-code': 't', output: 'o', list: 'l', silent: 's' },
  })
  if (parsed.flags.has('l')) {
    ctx.stdout.write(
      'ASCII//\nISO-8859-1//\nLATIN1//\nUS-ASCII//\nUTF-8//\nUTF-16//\nUTF-16BE//\nUTF-16LE//\n',
    )
    return 0
  }
  const normalize = (name: string | undefined) =>
    (name ?? 'UTF-8').toUpperCase().replace(/[_-]/g, '')
  const fromSpec = normalize(last(parsed, 'f'))
  const toSpec = normalize(last(parsed, 't'))
  const [toName, ...modifiers] = toSpec.split('//')
  const fromName = fromSpec.split('//')[0]!
  const known = (name: string) =>
    [
      'UTF8',
      'ASCII',
      'USASCII',
      'ANSIX3.41968',
      'LATIN1',
      'ISO88591',
      'UTF16',
      'UTF16LE',
      'UTF16BE',
      'CP1252',
      'WINDOWS1252',
    ].includes(name)
  if (!known(fromName) || !known(toName!))
    throw new CommandError(
      'conversion ' +
        (known(fromName) ? "to '" + last(parsed, 't') : "from '" + last(parsed, 'f')) +
        "' is not supported",
      1,
    )
  const chunks: Uint8Array[] = []
  let status = 0
  for (const operand of parsed.operands.length ? parsed.operands : ['-']) {
    try {
      chunks.push(await bytesOf(ctx, operand))
    } catch {
      ctx.stderr.write(
        "iconv: cannot open input file '" + operand + "': No such file or directory\n",
      )
      status = 1
    }
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  let text: string
  if (
    fromName === 'LATIN1' ||
    fromName === 'ISO88591' ||
    fromName === 'CP1252' ||
    fromName === 'WINDOWS1252'
  )
    text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  else if (fromName.startsWith('UTF16')) {
    const little = fromName !== 'UTF16BE' && !(bytes[0] === 0xfe && bytes[1] === 0xff)
    const start =
      (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff) ? 2 : 0
    text = ''
    for (let i = start; i + 1 < bytes.length; i += 2)
      text += String.fromCharCode(
        little ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!,
      )
  } else text = decode(bytes)
  const discard = parsed.flags.has('c') || modifiers.includes('IGNORE')
  const translit = modifiers.includes('TRANSLIT')
  const limit =
    toName === 'UTF8' || toName!.startsWith('UTF16')
      ? Infinity
      : toName === 'LATIN1' ||
          toName === 'ISO88591' ||
          toName === 'CP1252' ||
          toName === 'WINDOWS1252'
        ? 0xff
        : 0x7f
  let out = ''
  let position = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    if ((code >= 0xdc80 && code <= 0xdcff) || code > limit) {
      if (translit) {
        const plain = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        out += [...plain].every((c) => c.codePointAt(0)! <= limit) && plain !== '' ? plain : '?'
      } else if (!discard) {
        writeIconv(ctx, out, toName!)
        ctx.stderr.write(
          'iconv: ' +
            (code >= 0xdc80 && code <= 0xdcff ? 'illegal input sequence' : 'cannot convert') +
            ' at position ' +
            position +
            '\n',
        )
        return 1
      }
    } else out += char
    position += encode(char).length
  }
  writeIconv(ctx, out, toName!)
  return status
}

function writeIconv(ctx: CommandContext, text: string, target: string) {
  if (
    target === 'LATIN1' ||
    target === 'ISO88591' ||
    target === 'CP1252' ||
    target === 'WINDOWS1252'
  )
    ctx.stdout.write(Array.from(text, (char) => byte(char.codePointAt(0)!)).join(''))
  else if (target.startsWith('UTF16')) {
    let out = target === 'UTF16' ? byte(0xff) + byte(0xfe) : ''
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      out +=
        target === 'UTF16BE'
          ? byte(code >> 8) + byte(code & 0xff)
          : byte(code & 0xff) + byte(code >> 8)
    }
    ctx.stdout.write(out)
  } else ctx.stdout.write(text)
}

type BcNumber = { v: bigint; s: number }

type BcNode =
  | { kind: 'num'; text: string }
  | { kind: 'str'; text: string }
  | { kind: 'var'; name: string; index?: BcNode }
  | { kind: 'unary'; op: string; arg: BcNode }
  | { kind: 'binary'; op: string; left: BcNode; right: BcNode }
  | { kind: 'assign'; op: string; target: BcNode; value: BcNode }
  | { kind: 'incr'; op: string; prefix: boolean; target: BcNode }
  | { kind: 'call'; name: string; args: BcNode[] }

type BcStatement =
  | { kind: 'expr'; expr: BcNode }
  | { kind: 'print'; items: BcNode[] }
  | { kind: 'block'; body: BcStatement[] }
  | { kind: 'if'; test: BcNode; then: BcStatement; otherwise?: BcStatement }
  | { kind: 'while'; test: BcNode; body: BcStatement }
  | { kind: 'for'; init?: BcNode; test?: BcNode; step?: BcNode; body: BcStatement }
  | { kind: 'return'; value?: BcNode }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'quit' }
  | { kind: 'define'; name: string; params: string[]; autos: string[]; body: BcStatement[] }
  | { kind: 'empty' }

class BcError extends Error {}

class BcControl {
  kind: 'break' | 'continue' | 'return' | 'quit'
  value: BcNumber | undefined
  constructor(kind: 'break' | 'continue' | 'return' | 'quit', value?: BcNumber) {
    this.kind = kind
    this.value = value
  }
}

const TEN = 10n

function pow10(n: number): bigint {
  return TEN ** BigInt(Math.max(0, n))
}

function rescale(x: BcNumber, s: number): BcNumber {
  if (s === x.s) return x
  if (s > x.s) return { v: x.v * pow10(s - x.s), s }
  return { v: x.v / pow10(x.s - s), s }
}

function bcSqrtInt(n: bigint): bigint {
  if (n < 2n) return n
  let x = BigInt(Math.floor(Math.sqrt(Number(n))))
  if (x === 0n) x = 1n
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x && y - x <= 1n) {
      let r = x < y ? x : y
      while (r * r > n) r--
      while ((r + 1n) * (r + 1n) <= n) r++
      return r
    }
    x = y
  }
}

function bcTokens(source: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    if (c === '\\' && source[i + 1] === '\n') {
      i += 2
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (c === '\n' || c === ';') {
      tokens.push(c === '\n' ? '\n' : ';')
      i++
      continue
    }
    if (c === '"') {
      const end = source.indexOf('"', i + 1)
      if (end < 0) throw new BcError('unterminated string')
      tokens.push(source.slice(i, end + 1))
      i = end + 1
      continue
    }
    const number = source.slice(i).match(/^(?:[0-9A-F]+(?:\.[0-9A-F]*)?|\.[0-9A-F]+)/)
    if (number) {
      tokens.push(number[0])
      i += number[0].length
      continue
    }
    const word = source.slice(i).match(/^[a-z_][a-z0-9_]*/)
    if (word) {
      tokens.push(word[0])
      i += word[0].length
      continue
    }
    const op = source
      .slice(i)
      .match(/^(?:\+\+|--|\+=|-=|\*=|\/=|%=|\^=|==|<=|>=|!=|&&|\|\||[-+*\/%^=<>!(){}\[\],])/)
    if (!op) throw new BcError('illegal character: ' + c)
    tokens.push(op[0])
    i += op[0].length
  }
  return tokens
}

function bcParse(tokens: string[]): BcStatement[] {
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const expect = (token: string) => {
    if (tokens[pos] !== token) throw new BcError('syntax error')
    pos++
  }
  const skipNewlines = () => {
    while (tokens[pos] === '\n') pos++
  }
  const isName = (token: string | undefined) =>
    token !== undefined && /^[a-z_][a-z0-9_]*$/.test(token)
  const primary = (): BcNode => {
    const token = next()
    if (token === undefined) throw new BcError('syntax error')
    if (token === '(') {
      const node = expression()
      expect(')')
      return node
    }
    if (token === '-' || token === '!' || token === '+')
      return { kind: 'unary', op: token, arg: unaryLevel() }
    if (token === '++' || token === '--')
      return { kind: 'incr', op: token, prefix: true, target: primary() }
    if (/^[0-9A-F.]/.test(token)) return { kind: 'num', text: token }
    if (token.startsWith('"')) return { kind: 'str', text: token.slice(1, -1) }
    if (isName(token)) {
      if (peek() === '(') {
        pos++
        const args: BcNode[] = []
        if (peek() !== ')') {
          args.push(expression())
          while (peek() === ',') {
            pos++
            args.push(expression())
          }
        }
        expect(')')
        return { kind: 'call', name: token, args }
      }
      let node: BcNode = { kind: 'var', name: token }
      if (peek() === '[') {
        pos++
        node = { kind: 'var', name: token, index: expression() }
        expect(']')
      }
      if (peek() === '++' || peek() === '--')
        return { kind: 'incr', op: next()!, prefix: false, target: node }
      return node
    }
    throw new BcError('syntax error')
  }
  const power = (): BcNode => {
    const base = primary()
    if (peek() === '^') {
      pos++
      return { kind: 'binary', op: '^', left: base, right: unaryLevel() }
    }
    return base
  }
  const unaryLevel = (): BcNode => power()
  const multiplicative = (): BcNode => {
    let node = unaryLevel()
    while (peek() === '*' || peek() === '/' || peek() === '%')
      node = { kind: 'binary', op: next()!, left: node, right: unaryLevel() }
    return node
  }
  const additive = (): BcNode => {
    let node = multiplicative()
    while (peek() === '+' || peek() === '-')
      node = { kind: 'binary', op: next()!, left: node, right: multiplicative() }
    return node
  }
  const relational = (): BcNode => {
    let node = additive()
    while (['<', '>', '<=', '>=', '==', '!='].includes(peek() ?? ''))
      node = { kind: 'binary', op: next()!, left: node, right: additive() }
    return node
  }
  const not = (): BcNode => {
    if (peek() === '!') {
      pos++
      return { kind: 'unary', op: '!', arg: not() }
    }
    return relational()
  }
  const and = (): BcNode => {
    let node = not()
    while (peek() === '&&') {
      pos++
      node = { kind: 'binary', op: '&&', left: node, right: not() }
    }
    return node
  }
  const or = (): BcNode => {
    let node = and()
    while (peek() === '||') {
      pos++
      node = { kind: 'binary', op: '||', left: node, right: and() }
    }
    return node
  }
  const expression = (): BcNode => {
    const start = pos
    if (isName(peek())) {
      const target = primary()
      if (
        target.kind === 'var' &&
        ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(peek() ?? '')
      ) {
        const op = next()!
        return { kind: 'assign', op, target, value: expression() }
      }
      pos = start
    }
    return or()
  }
  const statement = (): BcStatement => {
    const token = peek()
    if (token === '\n' || token === ';') {
      pos++
      return { kind: 'empty' }
    }
    if (token === '{') {
      pos++
      const body: BcStatement[] = []
      skipNewlines()
      while (peek() !== '}' && peek() !== undefined) {
        body.push(statement())
        skipNewlines()
      }
      expect('}')
      return { kind: 'block', body }
    }
    if (token === 'if') {
      pos++
      expect('(')
      const test = expression()
      expect(')')
      skipNewlines()
      const then = statement()
      const save = pos
      while (tokens[pos] === '\n' || tokens[pos] === ';') pos++
      if (peek() === 'else') {
        pos++
        skipNewlines()
        return { kind: 'if', test, then, otherwise: statement() }
      }
      pos = save
      return { kind: 'if', test, then }
    }
    if (token === 'while') {
      pos++
      expect('(')
      const test = expression()
      expect(')')
      skipNewlines()
      return { kind: 'while', test, body: statement() }
    }
    if (token === 'for') {
      pos++
      expect('(')
      const init = peek() === ';' ? undefined : expression()
      expect(';')
      const test = peek() === ';' ? undefined : expression()
      expect(';')
      const step = peek() === ')' ? undefined : expression()
      expect(')')
      skipNewlines()
      return {
        kind: 'for',
        ...(init ? { init } : {}),
        ...(test ? { test } : {}),
        ...(step ? { step } : {}),
        body: statement(),
      }
    }
    if (token === 'break' || token === 'continue' || token === 'quit' || token === 'halt') {
      pos++
      return { kind: token === 'halt' ? 'quit' : token }
    }
    if (token === 'return') {
      pos++
      if (peek() === '(') {
        pos++
        if (peek() === ')') {
          pos++
          return { kind: 'return' }
        }
        const value = expression()
        expect(')')
        return { kind: 'return', value }
      }
      if (peek() === undefined || peek() === '\n' || peek() === ';' || peek() === '}')
        return { kind: 'return' }
      return { kind: 'return', value: expression() }
    }
    if (token === 'print') {
      pos++
      const items = [expression()]
      while (peek() === ',') {
        pos++
        items.push(expression())
      }
      return { kind: 'print', items }
    }
    if (token === 'define') {
      pos++
      const name = next()!
      expect('(')
      const params: string[] = []
      while (peek() !== ')') {
        params.push(next()!)
        if (peek() === '[') {
          pos += 2
        }
        if (peek() === ',') pos++
      }
      expect(')')
      skipNewlines()
      expect('{')
      skipNewlines()
      const autos: string[] = []
      if (peek() === 'auto') {
        pos++
        while (peek() !== '\n' && peek() !== ';' && peek() !== undefined) {
          const word = next()!
          if (word !== ',') autos.push(word)
        }
      }
      const body: BcStatement[] = []
      skipNewlines()
      while (peek() !== '}' && peek() !== undefined) {
        body.push(statement())
        skipNewlines()
      }
      expect('}')
      return { kind: 'define', name, params, autos, body }
    }
    return { kind: 'expr', expr: expression() }
  }
  const program: BcStatement[] = []
  while (pos < tokens.length) program.push(statement())
  return program
}

const bc: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'lqswi',
    long: { mathlib: 'l', quiet: 'q', standard: 's', warn: 'w', interactive: 'i' },
  })
  let source = ''
  let status = 0
  for (const operand of parsed.operands) {
    try {
      source += (await readInput(ctx, operand)) + '\n'
    } catch {
      ctx.stderr.write('bc: File ' + operand + ' is unavailable.\n')
      status = 1
    }
  }
  source += ctx.stdin.read()
  const vars = new Map<string, BcNumber>()
  const arrays = new Map<string, Map<string, BcNumber>>()
  const functions = new Map<string, Extract<BcStatement, { kind: 'define' }>>()
  let scale = parsed.flags.has('l') ? 20 : 0
  let ibase = 10
  let obase = 10
  let last: BcNumber = { v: 0n, s: 0 }
  let steps = 0
  const zero: BcNumber = { v: 0n, s: 0 }
  const int = (n: bigint | number): BcNumber => ({ v: BigInt(n), s: 0 })
  const truthy = (x: BcNumber) => x.v !== 0n
  const parseNumber = (text: string): BcNumber => {
    if (ibase === 10 && /^[0-9]*\.?[0-9]*$/.test(text)) {
      const [whole = '', fraction = ''] = text.split('.')
      return { v: BigInt((whole || '0') + fraction), s: fraction.length }
    }
    const [whole = '', fraction = ''] = text.split('.')
    let v = 0n
    for (const digit of whole)
      v = v * BigInt(ibase) + BigInt(Math.min(parseInt(digit, 16), ibase - 1))
    let result: BcNumber = { v, s: 0 }
    if (fraction) {
      let num = 0n
      let den = 1n
      for (const digit of fraction) {
        num = num * BigInt(ibase) + BigInt(parseInt(digit, 16))
        den *= BigInt(ibase)
      }
      const s = Math.max(fraction.length, scale)
      result = { v: v * pow10(s) + (num * pow10(s)) / den, s }
    }
    return result
  }
  const add = (a: BcNumber, b: BcNumber, sign = 1n): BcNumber => {
    const s = Math.max(a.s, b.s)
    return { v: rescale(a, s).v + sign * rescale(b, s).v, s }
  }
  const multiply = (a: BcNumber, b: BcNumber, target?: number): BcNumber => {
    const full = { v: a.v * b.v, s: a.s + b.s }
    return rescale(full, target ?? Math.min(a.s + b.s, Math.max(scale, a.s, b.s)))
  }
  const divide = (a: BcNumber, b: BcNumber, s = scale): BcNumber => {
    if (b.v === 0n) throw new BcError('Divide by zero')
    return { v: (a.v * pow10(s + b.s)) / (b.v * pow10(a.s)), s }
  }
  const modulo = (a: BcNumber, b: BcNumber): BcNumber => {
    if (b.v === 0n) throw new BcError('Modulo by zero')
    const q = divide(a, b)
    const product = { v: q.v * b.v, s: q.s + b.s }
    return rescale(add(a, product, -1n), Math.max(scale + b.s, a.s))
  }
  const power = (a: BcNumber, b: BcNumber): BcNumber => {
    if (b.s && b.v % pow10(b.s) !== 0n)
      ctx.stderr.write('bc: warning: non-zero scale in exponent\n')
    let e = b.v / pow10(b.s)
    if (e > 100000n) throw new BcError('exponent too large')
    const negative = e < 0n
    if (negative) e = -e
    let result: BcNumber = { v: 1n, s: 0 }
    let base = a
    const exact = (x: BcNumber, y: BcNumber): BcNumber => ({ v: x.v * y.v, s: x.s + y.s })
    let k = e
    while (k > 0n) {
      if (k & 1n) result = exact(result, base)
      k >>= 1n
      if (k > 0n) base = exact(base, base)
      if (result.s > 2000) result = rescale(result, Math.max(scale, a.s) + 50)
      if (base.s > 2000) base = rescale(base, Math.max(scale, a.s) + 50)
    }
    if (negative) return divide({ v: 1n, s: 0 }, result)
    return rescale(result, Math.min(a.s * Number(e), Math.max(scale, a.s)))
  }
  const compare = (a: BcNumber, b: BcNumber): number => {
    const d = add(a, b, -1n).v
    return d < 0n ? -1 : d > 0n ? 1 : 0
  }
  const sqrt = (a: BcNumber): BcNumber => {
    if (a.v < 0n) throw new BcError('Square root of a negative number')
    const s = Math.max(scale, a.s)
    return { v: bcSqrtInt(rescale(a, 2 * s).v), s }
  }
  const fixed = (x: BcNumber, w: number) => rescale(x, w).v
  const mathScale = () => scale + 10
  const fromFixed = (v: bigint, w: number): BcNumber => rescale({ v, s: w }, scale)
  const fmul = (a: bigint, b: bigint, one: bigint) => (a * b) / one
  const fdiv = (a: bigint, b: bigint, one: bigint) => (a * one) / b
  const expFixed = (x: bigint, w: number): bigint => {
    const one = pow10(w)
    if (x < 0n) return fdiv(one, expFixed(-x, w), one)
    let k = 0
    let y = x
    while (y > one) {
      y /= 2n
      k++
    }
    let term = one
    let sum = one
    for (let n = 1n; term !== 0n; n++) {
      term = fmul(term, y, one) / n
      sum += term
    }
    for (let i = 0; i < k; i++) sum = fmul(sum, sum, one)
    return sum
  }
  const lnFixed = (x: bigint, w: number): bigint => {
    const one = pow10(w)
    if (x <= 0n) throw new BcError('logarithm of a non-positive number')
    let k = 0n
    let y = x
    while (y > 2n * one) {
      y = bcSqrtInt(y * one)
      k++
    }
    while (y < one / 2n) {
      y = bcSqrtInt(y * one)
      k++
    }
    const z = fdiv(y - one, y + one, one)
    const z2 = fmul(z, z, one)
    let term = z
    let sum = 0n
    for (let n = 1n; term !== 0n; n += 2n) {
      sum += term / n
      term = fmul(term, z2, one)
    }
    return 2n * sum * (1n << k)
  }
  const atanFixed = (x: bigint, w: number): bigint => {
    const one = pow10(w)
    if (x < 0n) return -atanFixed(-x, w)
    if (x > one) return piFixed(w) / 2n - atanFixed(fdiv(one, x, one), w)
    let y = x
    let doubled = 0
    while (y > one / 5n) {
      y = fdiv(y, one + bcSqrtInt(one * one + y * y), one)
      doubled++
    }
    const y2 = fmul(y, y, one)
    let term = y
    let sum = 0n
    for (let n = 1n, sign = 1n; term !== 0n; n += 2n, sign = -sign) {
      sum += (sign * term) / n
      term = fmul(term, y2, one)
    }
    return sum << BigInt(doubled)
  }
  const piFixed = (w: number): bigint => {
    const one = pow10(w + 5)
    const series = (inverse: bigint) => {
      let term = one / inverse
      let sum = 0n
      const square = inverse * inverse
      for (let n = 1n, sign = 1n; term !== 0n; n += 2n, sign = -sign) {
        sum += (sign * term) / n
        term /= square
      }
      return sum
    }
    return (16n * series(5n) - 4n * series(239n)) / pow10(5)
  }
  const sinFixed = (x: bigint, w: number): bigint => {
    const one = pow10(w)
    const pi = piFixed(w)
    let y = x % (2n * pi)
    if (y > pi) y -= 2n * pi
    if (y < -pi) y += 2n * pi
    const y2 = fmul(y, y, one)
    let term = y
    let sum = 0n
    for (let n = 1n; term !== 0n; n += 2n) {
      sum += term
      term = -fmul(term, y2, one) / ((n + 1n) * (n + 2n))
    }
    return sum
  }
  const builtin = (name: string, args: BcNumber[]): BcNumber | undefined => {
    const arg = args[0] ?? zero
    const w = mathScale()
    switch (name) {
      case 'sqrt':
        return sqrt(arg)
      case 'length': {
        const digits = (arg.v < 0n ? -arg.v : arg.v).toString().replace(/^0+/, '')
        return int(arg.v === 0n ? (arg.s ? arg.s : 1) : Math.max(digits.length, arg.s))
      }
      case 'scale':
        return int(arg.s)
    }
    if (!parsed.flags.has('l')) return undefined
    switch (name) {
      case 'e':
        return fromFixed(expFixed(fixed(arg, w), w), w)
      case 'l':
        return fromFixed(lnFixed(fixed(arg, w), w), w)
      case 'a':
        return fromFixed(atanFixed(fixed(arg, w), w), w)
      case 's':
        return fromFixed(sinFixed(fixed(arg, w), w), w)
      case 'c':
        return fromFixed(sinFixed(fixed(arg, w) + piFixed(w) / 2n, w), w)
    }
    return undefined
  }
  const frames: Map<string, BcNumber>[] = []
  const lookup = (name: string): BcNumber => {
    if (name === 'scale') return int(scale)
    if (name === 'ibase') return int(ibase)
    if (name === 'obase') return int(obase)
    if (name === 'last') return last
    for (let i = frames.length - 1; i >= 0; i--) {
      const value = frames[i]!.get(name)
      if (value !== undefined) return value
    }
    return vars.get(name) ?? zero
  }
  const store = (node: BcNode, value: BcNumber, index?: BcNumber) => {
    if (node.kind !== 'var') throw new BcError('assignment to a non-variable')
    if (index !== undefined) {
      const array = arrays.get(node.name) ?? new Map<string, BcNumber>()
      arrays.set(node.name, array)
      array.set(String(index.v / pow10(index.s)), value)
      return
    }
    const whole = Number(value.v / pow10(value.s))
    if (node.name === 'scale') scale = Math.max(0, whole)
    else if (node.name === 'ibase') ibase = Math.min(16, Math.max(2, whole))
    else if (node.name === 'obase') obase = Math.max(2, whole)
    else if (node.name === 'last') last = value
    else {
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i]!.has(node.name)) {
          frames[i]!.set(node.name, value)
          return
        }
      }
      vars.set(node.name, value)
    }
  }
  const read = (node: BcNode, index?: BcNumber): BcNumber => {
    if (node.kind !== 'var') throw new BcError('not a variable')
    if (index !== undefined)
      return arrays.get(node.name)?.get(String(index.v / pow10(index.s))) ?? zero
    return lookup(node.name)
  }
  const call = (name: string, args: BcNumber[]): BcNumber => {
    const fn = functions.get(name)
    if (!fn) {
      const value = builtin(name, args)
      if (value === undefined) throw new BcError('Function ' + name + ' not defined.')
      return value
    }
    const frame = new Map<string, BcNumber>()
    fn.params.forEach((param, index) => frame.set(param, args[index] ?? zero))
    for (const auto of fn.autos) frame.set(auto, zero)
    frames.push(frame)
    try {
      for (const statement of fn.body) run(statement, true)
      return zero
    } catch (error) {
      if (error instanceof BcControl && error.kind === 'return') return error.value ?? zero
      throw error
    } finally {
      frames.pop()
    }
  }
  const evaluate = (node: BcNode): BcNumber => {
    if (++steps > 10_000_000) throw new BcError('too many steps')
    switch (node.kind) {
      case 'num':
        return parseNumber(node.text)
      case 'str':
        return zero
      case 'var':
        return read(node, node.index ? evaluate(node.index) : undefined)
      case 'unary': {
        const value = evaluate(node.arg)
        if (node.op === '-') return { v: -value.v, s: value.s }
        if (node.op === '!') return int(truthy(value) ? 0 : 1)
        return value
      }
      case 'binary': {
        if (node.op === '&&')
          return int(truthy(evaluate(node.left)) && truthy(evaluate(node.right)) ? 1 : 0)
        if (node.op === '||')
          return int(truthy(evaluate(node.left)) || truthy(evaluate(node.right)) ? 1 : 0)
        const a = evaluate(node.left)
        const b = evaluate(node.right)
        switch (node.op) {
          case '+':
            return add(a, b)
          case '-':
            return add(a, b, -1n)
          case '*':
            return multiply(a, b)
          case '/':
            return divide(a, b)
          case '%':
            return modulo(a, b)
          case '^':
            return power(a, b)
          case '<':
            return int(compare(a, b) < 0 ? 1 : 0)
          case '>':
            return int(compare(a, b) > 0 ? 1 : 0)
          case '<=':
            return int(compare(a, b) <= 0 ? 1 : 0)
          case '>=':
            return int(compare(a, b) >= 0 ? 1 : 0)
          case '==':
            return int(compare(a, b) === 0 ? 1 : 0)
          case '!=':
            return int(compare(a, b) !== 0 ? 1 : 0)
        }
        throw new BcError('unknown operator ' + node.op)
      }
      case 'assign': {
        const index =
          node.target.kind === 'var' && node.target.index ? evaluate(node.target.index) : undefined
        let value = evaluate(node.value)
        if (node.op !== '=') {
          const current = read(node.target, index)
          const op = node.op[0]!
          value =
            op === '+'
              ? add(current, value)
              : op === '-'
                ? add(current, value, -1n)
                : op === '*'
                  ? multiply(current, value)
                  : op === '/'
                    ? divide(current, value)
                    : op === '%'
                      ? modulo(current, value)
                      : power(current, value)
        }
        store(node.target, value, index)
        return value
      }
      case 'incr': {
        const index =
          node.target.kind === 'var' && node.target.index ? evaluate(node.target.index) : undefined
        const current = read(node.target, index)
        const updated = add(current, { v: 1n, s: 0 }, node.op === '++' ? 1n : -1n)
        store(node.target, updated, index)
        return node.prefix ? updated : current
      }
      case 'call':
        return call(node.name, node.args.map(evaluate))
    }
  }
  const render = (x: BcNumber): string => {
    if (obase !== 10) {
      const negative = x.v < 0n
      let whole = (negative ? -x.v : x.v) / pow10(x.s)
      if (whole === 0n) return (negative ? '-' : '') + '0'
      const digits: string[] = []
      const base = BigInt(obase)
      while (whole > 0n) {
        const digit = Number(whole % base)
        digits.unshift(
          obase <= 16
            ? '0123456789ABCDEF'[digit]!
            : ' ' + String(digit).padStart(String(obase - 1).length, '0'),
        )
        whole /= base
      }
      return (negative ? '-' : '') + digits.join('')
    }
    if (x.v === 0n) return '0'
    const negative = x.v < 0n
    const text = (negative ? -x.v : x.v).toString().padStart(x.s + 1, '0')
    const whole = text.slice(0, text.length - x.s).replace(/^0+(?=.)/, '')
    const body = x.s ? (whole === '0' ? '' : whole) + '.' + text.slice(text.length - x.s) : whole
    return (negative ? '-' : '') + body
  }
  const wrap = (text: string): string => {
    const out: string[] = []
    let rest = text
    while (rest.length > 69) {
      out.push(rest.slice(0, 68) + '\\')
      rest = rest.slice(68)
    }
    out.push(rest)
    return out.join('\n')
  }
  const escapesBc = (text: string) =>
    text.replace(
      /\\([abfnrtq\\e])/g,
      (_, c: string) =>
        ({ a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', q: '"', '\\': '\\', e: '\\' })[
          c
        ] ?? c,
    )
  const run = (statement: BcStatement, inFunction = false): void => {
    switch (statement.kind) {
      case 'empty':
        return
      case 'expr': {
        const expr = statement.expr
        if (expr.kind === 'str') {
          ctx.stdout.write(expr.text)
          return
        }
        const value = evaluate(expr)
        if (expr.kind !== 'assign') {
          last = value
          ctx.stdout.write(wrap(render(value)) + '\n')
        }
        return
      }
      case 'print':
        for (const item of statement.items)
          ctx.stdout.write(
            item.kind === 'str' ? escapesBc(item.text) : wrap(render(evaluate(item))),
          )
        return
      case 'block':
        for (const inner of statement.body) run(inner, inFunction)
        return
      case 'if':
        if (truthy(evaluate(statement.test))) run(statement.then, inFunction)
        else if (statement.otherwise) run(statement.otherwise, inFunction)
        return
      case 'while':
      case 'for':
        if (statement.kind === 'for' && statement.init) evaluate(statement.init)
        for (;;) {
          if (++steps > 10_000_000) throw new BcError('too many steps')
          if (statement.test && !truthy(evaluate(statement.test))) break
          try {
            run(statement.body, inFunction)
          } catch (error) {
            if (!(error instanceof BcControl)) throw error
            if (error.kind === 'break') break
            if (error.kind !== 'continue') throw error
          }
          if (statement.kind === 'for' && statement.step) evaluate(statement.step)
        }
        return
      case 'return':
        if (!inFunction) throw new BcError('return outside a function')
        throw new BcControl('return', statement.value ? evaluate(statement.value) : zero)
      case 'break':
        throw new BcControl('break')
      case 'continue':
        throw new BcControl('continue')
      case 'quit':
        throw new BcControl('quit')
      case 'define':
        functions.set(statement.name, statement)
        return
    }
  }
  let program: BcStatement[]
  try {
    program = bcParse(bcTokens(source))
  } catch (error) {
    if (!(error instanceof BcError)) throw error
    ctx.stderr.write(
      '(standard_in) 1: ' +
        (error.message === 'syntax error' ? 'syntax error' : error.message) +
        '\n',
    )
    return 1
  }
  for (const statement of program) {
    try {
      run(statement)
    } catch (error) {
      if (error instanceof BcControl) {
        if (error.kind === 'quit') break
        continue
      }
      if (!(error instanceof BcError)) throw error
      ctx.stderr.write('Runtime error (func=(main), adr=0): ' + error.message + '\n')
      break
    }
  }
  return status
}

const unexpand: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'a',
    values: 't',
    long: { all: 'a', tabs: 't', 'first-only': 'F' },
  })
  const tab = Number(last(parsed, 't') ?? 8)
  const all = parsed.flags.has('a') || (parsed.values.has('t') && !parsed.flags.has('F'))
  return eachInput(ctx, parsed.operands, (text) => {
    ctx.stdout.write(
      text
        .split('\n')
        .map((line) => {
          let out = ''
          let column = 0
          let pending = ''
          let pendingStart = 0
          let leading = true
          for (const char of line) {
            if ((char === ' ' || char === '\t') && (leading || all)) {
              if (!pending) pendingStart = column
              pending += char
              column = char === '\t' ? (Math.floor(column / tab) + 1) * tab : column + 1
              if (column % tab === 0) {
                out += pending.length > 1 || pending === '\t' ? '\t' : pending
                pending = ''
                pendingStart = column
              }
              continue
            }
            out += pending + char
            pending = ''
            leading = false
            column++
          }
          void pendingStart
          return out + pending
        })
        .join('\n'),
    )
  })
}

const id: CommandHandler = (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'ugGnr',
    long: { user: 'u', group: 'g', groups: 'G', name: 'n', real: 'r' },
  })
  const user = ctx.env.USER ?? 'user'
  const f = parsed.flags
  if (f.has('u')) ctx.stdout.write((f.has('n') ? user : '1000') + '\n')
  else if (f.has('g') || f.has('G')) ctx.stdout.write((f.has('n') ? user : '1000') + '\n')
  else ctx.stdout.write('uid=1000(' + user + ') gid=1000(' + user + ') groups=1000(' + user + ')\n')
  return 0
}

const SIGNALS = [
  'HUP',
  'INT',
  'QUIT',
  'ILL',
  'TRAP',
  'ABRT',
  'BUS',
  'FPE',
  'KILL',
  'USR1',
  'SEGV',
  'USR2',
  'PIPE',
  'ALRM',
  'TERM',
  'STKFLT',
  'CHLD',
  'CONT',
  'STOP',
  'TSTP',
  'TTIN',
  'TTOU',
  'URG',
  'XCPU',
  'XFSZ',
  'VTALRM',
  'PROF',
  'WINCH',
  'IO',
  'PWR',
  'SYS',
]

function signalTable(): [number, string][] {
  const table: [number, string][] = SIGNALS.map((name, index) => [index + 1, name])
  for (let n = 34; n <= 64; n++)
    table.push([
      n,
      n === 34 ? 'RTMIN' : n === 64 ? 'RTMAX' : n < 50 ? 'RTMIN+' + (n - 34) : 'RTMAX-' + (64 - n),
    ])
  return table
}

const kill: CommandHandler = (ctx) => {
  if (ctx.args[0] === '-l' || ctx.args[0] === '-L') {
    const table = signalTable()
    if (ctx.args.length > 1) {
      for (const arg of ctx.args.slice(1)) {
        const number = Number(arg)
        const found = Number.isInteger(number)
          ? table.find(([n]) => n === (number > 128 ? number - 128 : number))
          : table.find(([, name]) => name === arg.toUpperCase().replace(/^SIG/, ''))
        if (!found) throw new CommandError(arg + ': invalid signal specification', 1)
        ctx.stdout.write((Number.isInteger(number) ? found[1] : String(found[0])) + '\n')
      }
      return 0
    }
    let text = ''
    table.forEach(([n, name], index) => {
      text +=
        String(n).padStart(2) +
        ') SIG' +
        name +
        (index % 5 === 4 || index === table.length - 1 ? '\n' : '\t')
    })
    ctx.stdout.write(text)
    return 0
  }
  if (!ctx.args.some((arg) => !arg.startsWith('-')))
    throw new CommandError(
      'usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]',
      2,
    )
  return 0
}

const envsubst: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'vh',
    long: { variables: 'v', help: 'h', version: 'V' },
  })
  const reference = /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g
  const named = (text: string) =>
    [...text.matchAll(reference)].map((match) => match[1] ?? match[2]!)
  if (parsed.flags.has('v')) {
    if (!parsed.operands.length) throw new CommandError('missing arguments', 1)
    ctx.stdout.write(
      named(parsed.operands.join(' '))
        .map((name) => name + '\n')
        .join(''),
    )
    return 0
  }
  const allowed = parsed.operands.length ? new Set(named(parsed.operands.join(' '))) : undefined
  ctx.stdout.write(
    ctx.stdin
      .read()
      .replace(reference, (whole, plain: string | undefined, braced: string | undefined) => {
        const name = plain ?? braced!
        if (allowed && !allowed.has(name)) return whole
        return ctx.env[name] ?? ''
      }),
  )
  return 0
}

const csplit: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'skzq',
    values: 'fnb',
    long: {
      prefix: 'f',
      digits: 'n',
      'suffix-format': 'b',
      silent: 's',
      quiet: 's',
      'keep-files': 'k',
      'elide-empty-files': 'z',
      'suppress-matched': 'suppress',
    },
  })
  const [input, ...patterns] = parsed.operands
  if (input === undefined) throw new CommandError('missing operand', 1)
  if (!patterns.length) throw new CommandError("missing operand after '" + input + "'", 1)
  const prefix = last(parsed, 'f') ?? 'xx'
  const digits = Number(last(parsed, 'n') ?? 2)
  const suffix = last(parsed, 'b')
  const text = await readInput(ctx, input)
  const rows = text.split(/(?<=\n)/).filter((row) => row !== '')
  const pieces: string[] = []
  const written: string[] = []
  let position = 0
  let split = false
  let error: string | undefined
  const emit = (end: number) => {
    pieces.push(rows.slice(position, end).join(''))
    position = end
    split = true
  }
  const steps: { spec: string; repeat: number | '*' }[] = []
  for (const pattern of patterns) {
    const repeat = pattern.match(/^\{(\d+|\*)\}$/)
    if (repeat) {
      const previous = steps.at(-1)
      if (!previous) throw new CommandError('‘' + pattern + '’: invalid pattern', 1)
      steps.push({ spec: previous.spec, repeat: repeat[1] === '*' ? '*' : Number(repeat[1]) })
    } else steps.push({ spec: pattern, repeat: 1 })
  }
  const run = (spec: string, attempt: number): boolean => {
    const regex = spec.match(/^([/%])(.*)\1([+-]\d+)?$/)
    if (regex) {
      const re = posixRegExp(regex[2]!, false)
      const offset = Number(regex[3] ?? 0)
      let found = -1
      for (let i = position + (split || position > 0 ? 1 : 0); i < rows.length; i++) {
        if (re.test(rows[i]!.replace(/\n$/, ''))) {
          found = i
          break
        }
      }
      if (found < 0) {
        error = '‘' + spec + '’: match not found' + (attempt ? ' on repetition ' + attempt : '')
        return false
      }
      const end = Math.max(position, Math.min(rows.length, found + offset))
      if (regex[1] === '%') {
        position = end
        split = true
      } else emit(end)
      return true
    }
    if (/^\d+$/.test(spec)) {
      const line = Number(spec) * (attempt + 1)
      if (line > rows.length || line - 1 < position) {
        error =
          '‘' + spec + '’: line number out of range' + (attempt ? ' on repetition ' + attempt : '')
        return false
      }
      emit(line - 1)
      return true
    }
    throw new CommandError('‘' + spec + '’: invalid pattern', 1)
  }
  outer: for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!
    const first = index > 0 && steps[index - 1]!.spec === step.spec && step.repeat !== 1 ? 1 : 0
    const count = step.repeat === '*' ? Infinity : step.repeat
    for (let attempt = 0; attempt < count; attempt++) {
      const before = /^\d+$/.test(step.spec) && first ? Number(step.spec) * (attempt + 1) : 0
      void before
      if (!run(step.spec, attempt + first)) {
        if (step.repeat === '*' && /^[/%]/.test(step.spec)) {
          error = undefined
          break
        }
        break outer
      }
    }
  }
  pieces.push(rows.slice(position).join(''))
  let count = 0
  for (const piece of pieces) {
    if (parsed.flags.has('z') && piece === '') continue
    const name =
      prefix + (suffix ? format(suffix, [count], false).text : String(count).padStart(digits, '0'))
    count++
    await ctx.fs.write(ctx.resolve(name), encode(piece))
    written.push(name)
    if (!parsed.flags.has('s')) ctx.stdout.write(encode(piece).length + '\n')
  }
  if (error !== undefined) {
    ctx.stderr.write('csplit: ' + error + '\n')
    if (!parsed.flags.has('k')) for (const name of written) await ctx.fs.remove(ctx.resolve(name))
    return 1
  }
  return 0
}

const install: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'dDcCpsvTb',
    values: 'mtgoS',
    long: {
      directory: 'd',
      mode: 'm',
      'target-directory': 't',
      group: 'g',
      owner: 'o',
      verbose: 'v',
      'preserve-timestamps': 'p',
      strip: 's',
      compare: 'C',
      'no-target-directory': 'T',
      suffix: 'S',
      backup: 'b',
    },
  })
  const fs = linked(ctx)
  const f = parsed.flags
  const spec = last(parsed, 'm')
  const bits = spec === undefined ? 0o755 : /^[0-7]+$/.test(spec) ? parseInt(spec, 8) : undefined
  if (bits === undefined) throw new CommandError("invalid mode '" + spec + "'", 1)
  const operands = [...parsed.operands]
  let status = 0
  const fail = (message: string) => {
    ctx.stderr.write('install: ' + message + '\n')
    status = 1
  }
  const makeDirs = async (path: string) => {
    let current = ''
    for (const part of path.split('/').filter(Boolean)) {
      current += '/' + part
      const stat = await fs.stat(current)
      if (!stat) {
        await fs.mkdir(current)
        if (fs.chmod) await fs.chmod(current, 0o755)
      } else if (stat.kind !== 'directory')
        throw new CommandError("cannot create directory '" + path + "': File exists", 1)
    }
  }
  if (f.has('d')) {
    if (!operands.length) throw new CommandError('missing file operand', 1)
    for (const operand of operands) {
      await makeDirs(ctx.resolve(operand))
      if (spec !== undefined && fs.chmod) await fs.chmod(ctx.resolve(operand), bits)
      if (f.has('v')) ctx.stdout.write("install: creating directory '" + operand + "'\n")
    }
    return 0
  }
  let directory = last(parsed, 't')
  if (directory === undefined) {
    if (operands.length < 2)
      throw new CommandError(
        operands.length
          ? "missing destination file operand after '" + operands[0] + "'"
          : 'missing file operand',
        1,
      )
    const candidate = operands[operands.length - 1]!
    const stat = await fs.stat(ctx.resolve(candidate))
    if ((stat?.kind === 'directory' && !f.has('T')) || operands.length > 2)
      directory = operands.pop()
  }
  if (directory !== undefined && f.has('D')) await makeDirs(ctx.resolve(directory))
  const pairs: [string, string][] =
    directory !== undefined
      ? operands.map((source) => [source, directory.replace(/\/+$/, '') + '/' + baseOf(source)])
      : [[operands[0]!, operands[1]!]]
  if (directory !== undefined && (await fs.stat(ctx.resolve(directory)))?.kind !== 'directory')
    throw new CommandError("target '" + directory + "' is not a directory", 1)
  for (const [source, destination] of pairs) {
    const from = ctx.resolve(source)
    const to = ctx.resolve(destination)
    const stat = await fs.stat(from)
    if (!stat) {
      fail("cannot stat '" + source + "': No such file or directory")
      continue
    }
    if (stat.kind === 'directory') {
      fail("omitting directory '" + source + "'")
      continue
    }
    if (f.has('D') && directory === undefined) await makeDirs(parentOf(to))
    if (!(await fs.stat(parentOf(to)))) {
      fail("cannot create regular file '" + destination + "': No such file or directory")
      continue
    }
    if ((await fs.stat(to))?.kind === 'directory') {
      fail("cannot overwrite directory '" + destination + "' with non-directory")
      continue
    }
    await fs.write(to, await fs.read(from))
    if (fs.chmod) await fs.chmod(to, bits)
    if (f.has('p') && fs.utimes) await fs.utimes(to, stat.mtime)
    if (f.has('v')) ctx.stdout.write("'" + source + "' -> '" + destination + "'\n")
  }
  return status
}

export const extraCommands: Record<string, CommandHandler> = {
  bc,
  cmp,
  csplit,
  env,
  envsubst,
  expand,
  file,
  fmt,
  gunzip: compressor('gunzip'),
  gzip: compressor('gzip'),
  hexdump,
  iconv,
  id,
  install,
  join,
  kill,
  ln,
  make,
  md5sum,
  numfmt,
  od,
  rg,
  shuf,
  split,
  strings,
  tar,
  time,
  timeout,
  tree,
  truncate,
  unexpand,
  which,
  xxd,
  yes,
  yq,
  zcat: compressor('zcat'),
}

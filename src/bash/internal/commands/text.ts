import {
  CommandError,
  PipeError,
  budget,
  streaming,
  type CommandContext,
  type CommandHandler,
} from '../Shell.ts'
import { FsError } from '../../FileSystem.ts'
import { baseOf, byteLength, decode, encode, fromBase64, toBase64 } from '../Fs.ts'
import {
  ahead,
  exactLiterals,
  literals,
  pruned,
  prunedList,
  prunedStat,
  type Pruned,
} from '../Prune.ts'
import {
  escapeRegExp,
  escapes,
  format,
  globRegExp,
  joinLines,
  lines,
  posixRegExp,
} from '../Text.ts'
import {
  allInput,
  batches,
  device,
  eachBatch,
  eachInput,
  last,
  options,
  pause,
  put,
  readInput,
} from './util.ts'

async function eachLine(
  ctx: CommandContext,
  operands: string[],
  visit: (line: string) => string,
  terminate = false,
): Promise<number> {
  let carry = ''
  const status = await eachBatch(ctx, operands, async (batch) => {
    const text = carry ? carry + batch : batch
    const cut = text.lastIndexOf('\n')
    carry = text.slice(cut + 1)
    if (cut < 0) return
    let out = ''
    for (let start = 0; start <= cut; ) {
      const end = text.indexOf('\n', start)
      out += visit(text.slice(start, end)) + '\n'
      start = end + 1
      if (out.length < 1 << 16) continue
      await put(ctx, out)
      out = ''
    }
    await put(ctx, out)
  })
  if (carry) await put(ctx, visit(carry) + (terminate ? '\n' : ''))
  return status
}

const echo: CommandHandler = (ctx) => {
  let newline = true
  let interpret = false
  let i = 0
  for (; i < ctx.args.length; i++) {
    const arg = ctx.args[i]
    if (!/^-[neE]+$/.test(arg)) break
    for (const flag of arg.slice(1)) {
      if (flag === 'n') newline = false
      else if (flag === 'e') interpret = true
      else interpret = false
    }
  }
  let text = ctx.args.slice(i).join(' ')
  if (interpret) {
    const [expanded, stop] = escapes(text)
    text = expanded
    if (stop) newline = false
  }
  ctx.stdout.write(newline ? text + '\n' : text)
  return 0
}

const printf: CommandHandler = (ctx) => {
  const args = ctx.args[0] === '--' ? ctx.args.slice(1) : ctx.args
  if (!args.length) throw new CommandError('usage: printf format [arguments]', 2)
  const [spec, ...rest] = args
  let remaining = rest
  let status = 0
  for (;;) {
    const result = format(spec, remaining, true, (pattern, seconds) =>
      strftime(pattern || '%X', new Date(seconds * 1000)),
    )
    ctx.stdout.write(result.text)
    for (const error of result.errors ?? []) {
      ctx.stderr.write('printf: ' + error + '\n')
      status = 1
    }
    if (result.stop) return status
    remaining = remaining.slice(result.used)
    if (!result.used || !remaining.length) return status
  }
}

function count(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const match = value.match(/^([+-]?\d+)([kKmMgGbB]?)$/)
  if (!match) throw new CommandError("invalid number: '" + value + "'")
  const scale = {
    '': 1,
    k: 1024,
    K: 1024,
    m: 1024 ** 2,
    M: 1024 ** 2,
    g: 1024 ** 3,
    G: 1024 ** 3,
    b: 512,
    B: 512,
  }[match[2]]!
  return Number(match[1]) * scale
}

function lastLines(text: string, n: number): string {
  let pos = text.length - 1
  for (let k = 0; k < n && pos >= 0; k++) pos = text.lastIndexOf('\n', pos - 1)
  return pos < 0 ? text : text.slice(pos + 1)
}

async function headTail(ctx: CommandContext, tail: boolean): Promise<number> {
  const parsed = options(ctx.args, {
    flags: 'qvfFz',
    values: 'nc',
    numeric: true,
    long: { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v', follow: 'f' },
  })
  const lineSpec = last(parsed, 'n')
  const byteSpec = last(parsed, 'c')
  const headers = (parsed.operands.length > 1 || parsed.flags.has('v')) && !parsed.flags.has('q')
  let first = true
  const header = (name: string) => {
    if (!headers) return
    ctx.stdout.write(
      (first ? '' : '\n') + '==> ' + (name === '-' ? 'standard input' : name) + ' <==\n',
    )
    first = false
  }
  const render = async (text: string) => {
    if (byteSpec !== undefined) {
      const n = count(byteSpec, 0)
      const bytes = encode(text)
      if (tail)
        await put(
          ctx,
          byteSpec.startsWith('+')
            ? decode(bytes.subarray(Math.max(0, n - 1)))
            : n === 0
              ? ''
              : decode(bytes.subarray(-n)),
        )
      else await put(ctx, decode(bytes.subarray(0, n)))
      return
    }
    const n = count(lineSpec, 10)
    const all = text.split('\n')
    const trailing = all[all.length - 1] === ''
    if (trailing) all.pop()
    let start: number
    let end: number
    if (tail) {
      start = lineSpec?.startsWith('+') ? Math.max(0, n - 1) : Math.max(0, all.length - Math.abs(n))
      end = all.length
    } else {
      start = 0
      end = n < 0 ? Math.max(0, all.length + n) : Math.min(all.length, n)
    }
    if (end <= start) return
    await put(ctx, all.slice(start, end).join('\n') + (end < all.length || trailing ? '\n' : ''))
  }
  const size =
    byteSpec !== undefined && !tail && !byteSpec.startsWith('-')
      ? Math.max(0, count(byteSpec, 0))
      : undefined
  let status = 0
  for (const operand of parsed.operands.length ? parsed.operands : ['-']) {
    if (size !== undefined && device(ctx.resolve(operand), 0) !== undefined) {
      header(operand)
      for (let remaining = size; remaining > 0; remaining -= 1 << 20)
        await put(ctx, device(ctx.resolve(operand), Math.min(remaining, 1 << 20))!)
      continue
    }
    if (operand !== '-' && operand !== '/dev/stdin' && operand !== '/dev/fd/0') {
      status |= await eachInput(
        ctx,
        [operand],
        async (text, name) => {
          header(name)
          await render(text)
        },
        size,
      )
      continue
    }
    header(operand)
    const n = count(byteSpec ?? lineSpec, 10)
    if (!tail && byteSpec !== undefined && !byteSpec.startsWith('-')) {
      for (let remaining = n; remaining > 0; ) {
        const want = Math.min(remaining, 1 << 20)
        const text = await ctx.stdin.readChars(want)
        const bytes = encode(text)
        await put(ctx, bytes.length > remaining ? decode(bytes.subarray(0, remaining)) : text)
        remaining -= bytes.length
        if (text.length < want) break
      }
      ctx.stdin.close()
    } else if (!tail && byteSpec === undefined && !lineSpec?.startsWith('-')) {
      let out = ''
      for (let i = 0; i < n; i++) {
        const line = await ctx.stdin.readLine()
        if (!line) break
        out += line.text + (line.complete ? '\n' : '')
        if (out.length > 65536) {
          await put(ctx, out)
          out = ''
        }
      }
      await put(ctx, out)
      ctx.stdin.close()
    } else if (tail && byteSpec === undefined && !lineSpec?.startsWith('+')) {
      let text = ''
      for (let chunk = await ctx.stdin.chunk(); chunk !== null; chunk = await ctx.stdin.chunk()) {
        text += chunk
        if (text.length > 1 << 22) text = lastLines(text, Math.abs(n))
      }
      await render(lastLines(text, Math.abs(n)))
    } else await render(await ctx.stdin.text())
  }
  return status
}

const wc: CommandHandler = streaming(async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'lwcmL',
    long: { lines: 'l', words: 'w', bytes: 'c', chars: 'm', 'max-line-length': 'L' },
  })
  const f = parsed.flags
  const fields = f.size ? ['l', 'w', 'm', 'c', 'L'].filter((flag) => f.has(flag)) : ['l', 'w', 'c']
  const rows: { counts: number[]; name: string; bytes: number }[] = []
  const totals = fields.map(() => 0)
  const tally = (text: string) => {
    let bytes = 0
    const counts = fields.map((field) => {
      if (field === 'l') {
        let n = 0
        for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
        return n
      }
      if (field === 'w') return (text.match(/\S+/g) ?? []).length
      if (field === 'm') {
        let n = text.length
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i)
          if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1)
            if (next >= 0xdc00 && next <= 0xdfff) {
              n--
              i++
            }
          }
        }
        return n
      }
      if (field === 'c') return (bytes = byteLength(text))
      let max = 0
      for (const line of text.split('\n')) max = Math.max(max, line.length)
      return max
    })
    return { counts, bytes: fields.includes('c') ? bytes : byteLength(text) }
  }
  let status = 0
  for (const operand of parsed.operands.length ? parsed.operands : ['-']) {
    const row = {
      counts: fields.map(() => 0),
      name: parsed.operands.length ? operand : '',
      bytes: 0,
    }
    const failed = await eachBatch(ctx, [operand], (text) => {
      const { counts, bytes } = tally(text)
      row.counts = row.counts.map((value, index) =>
        fields[index] === 'L' ? Math.max(value, counts[index]) : value + counts[index],
      )
      row.bytes += bytes
    })
    if (failed) {
      status = failed
      continue
    }
    row.counts.forEach(
      (value, index) =>
        (totals[index] =
          fields[index] === 'L' ? Math.max(totals[index], value) : totals[index] + value),
    )
    rows.push(row)
  }
  if (parsed.operands.length > 1) rows.push({ counts: totals, name: 'total', bytes: 0 })
  const stdin = !parsed.operands.length || parsed.operands.includes('-')
  const bytes = rows.slice(0, parsed.operands.length || 1).reduce((sum, row) => sum + row.bytes, 0)
  const width =
    fields.length === 1 && rows.length === 1 ? 0 : Math.max(stdin ? 7 : 1, String(bytes).length)
  for (const row of rows)
    ctx.stdout.write(
      row.counts.map((value) => String(value).padStart(width)).join(' ') +
        (row.name ? ' ' + row.name : '') +
        '\n',
    )
  return status
})

export type ScanState = { printed: boolean }

export type ScanOptions = {
  regex: RegExp
  invert: boolean
  max: number
  before: number
  after: number
  only: boolean
  numbers: boolean
  offsets?: boolean
  column?: boolean
  name?: string | undefined
  base?: number
  separator?: string
  terminator: string
  replace?: string | undefined
  silent: boolean
  state: ScanState
  write(text: string): void
}

export function scan(text: string, options: ScanOptions): number {
  const all = text.split(options.separator ?? '\n')
  if (all[all.length - 1] === '') all.pop()
  const regex = options.regex
  const context = !options.silent && !options.only && (options.before > 0 || options.after > 0)
  const starts: number[] = []
  if (options.offsets) {
    let offset = 0
    for (const line of all) {
      starts.push(offset)
      offset += encode(line).length + 1
    }
  }
  const prefix = (n: number, mark: string, column?: number) =>
    (options.name !== undefined ? options.name + mark : '') +
    (options.numbers ? n + 1 + (options.base ?? 0) + mark : '') +
    (options.offsets
      ? (starts[n] ?? 0) +
        (column !== undefined && !options.column ? encode(all[n].slice(0, column)).length : 0) +
        mark
      : '') +
    (options.column && column !== undefined ? column + 1 + mark : '')
  const replaced = (line: string) =>
    options.replace === undefined ? line : line.replace(regex, options.replace)
  let matches = 0
  let lastPrinted = -1
  let pendingAfter = 0
  const emit = (i: number, mark: string, body: string) => {
    if (context && options.state.printed && lastPrinted !== i - 1)
      options.write('--' + options.terminator)
    options.state.printed = true
    lastPrinted = i
    options.write(prefix(i, mark) + body + options.terminator)
  }
  for (let i = 0; i < all.length; i++) {
    const line = all[i]
    if (matches >= options.max) {
      if (!context || pendingAfter <= 0) break
      emit(i, '-', line)
      pendingAfter--
      continue
    }
    regex.lastIndex = 0
    const hit = regex.test(line) !== options.invert
    if (!hit) {
      if (context && pendingAfter > 0) {
        emit(i, '-', line)
        pendingAfter--
      }
      continue
    }
    matches++
    if (options.silent) continue
    if (context)
      for (let j = Math.max(lastPrinted + 1, i - options.before); j < i; j++) emit(j, '-', all[j])
    if (options.only && !options.invert) {
      regex.lastIndex = 0
      for (const match of line.matchAll(regex)) {
        if (!match[0]) continue
        options.state.printed = true
        options.write(
          prefix(i, ':', match.index) +
            (options.replace === undefined
              ? match[0]
              : match[0].replace(
                  new RegExp(regex.source, regex.flags.replace('g', '')),
                  options.replace,
                )) +
            options.terminator,
        )
      }
    } else if (options.column) {
      regex.lastIndex = 0
      const first = options.invert ? null : regex.exec(line)
      options.state.printed = true
      options.write(prefix(i, ':', first?.index ?? 0) + replaced(line) + options.terminator)
    } else emit(i, ':', replaced(line))
    pendingAfter = options.after
  }
  return matches
}

export function perlSource(pattern: string): { source: string; flags: string } {
  let source = pattern
  let flags = ''
  const inline = source.match(/^\(\?([imsx]+)\)/)
  if (inline) {
    source = source.slice(inline[0].length)
    flags = inline[1].replace(/x/g, '')
  }
  source = source
    .replace(/\(\?P</g, '(?<')
    .replace(/\\A/g, '^')
    .replace(/\\[zZ]/g, '$')
  return { source, flags }
}

const grep: CommandHandler = streaming(async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'ivncLlrRhHqsoxwEFGPZaIUzb',
    values: 'eABCmfd',
    numeric: true,
    long: {
      'ignore-case': 'i',
      'invert-match': 'v',
      'line-number': 'n',
      count: 'c',
      'files-with-matches': 'l',
      'files-without-match': 'L',
      recursive: 'r',
      'dereference-recursive': 'R',
      'no-filename': 'h',
      'with-filename': 'H',
      quiet: 'q',
      silent: 'q',
      'no-messages': 's',
      'only-matching': 'o',
      'line-regexp': 'x',
      'word-regexp': 'w',
      'extended-regexp': 'E',
      'fixed-strings': 'F',
      'basic-regexp': 'G',
      'perl-regexp': 'P',
      regexp: 'e',
      'after-context': 'A',
      'before-context': 'B',
      context: 'C',
      'max-count': 'm',
      file: 'f',
      include: 'include',
      exclude: 'exclude',
      'exclude-dir': 'exclude-dir',
      color: '',
      colour: '',
      'null-data': 'z',
      null: 'Z',
      binary: '',
      text: 'a',
      'line-buffered': '',
      'no-ignore-case': '',
      'byte-offset': 'b',
      label: 'label',
      'binary-files': 'binary-files',
      directories: 'd',
      devices: 'devices',
    },
  })
  const f = parsed.flags
  const operands = [...parsed.operands]
  const patterns: string[] = [...(parsed.values.get('e') ?? [])]
  for (const file of parsed.values.get('f') ?? []) {
    try {
      for (const line of lines(
        file === '-' ? await ctx.stdin.text() : decode(await ctx.fs.read(ctx.resolve(file))),
      ))
        patterns.push(line)
    } catch (error) {
      if (!(error instanceof FsError)) throw error
      throw new CommandError(file + ': No such file or directory', 2)
    }
  }
  if (!parsed.values.has('e') && !parsed.values.has('f')) {
    if (!operands.length) throw new CommandError('usage: grep [OPTION]... PATTERNS [FILE]...', 2)
    for (const line of operands.shift()!.split('\n')) patterns.push(line)
  }
  let flags = (f.has('i') ? 'i' : '') + 'g'
  const sources = patterns.map((pattern) => {
    let source: string
    if (f.has('F')) source = escapeRegExp(pattern)
    else if (f.has('P')) {
      const perl = perlSource(pattern)
      source = perl.source
      if (perl.flags.includes('i') && !flags.includes('i')) flags += 'i'
      if (perl.flags.includes('s') && !flags.includes('s')) flags += 's'
    } else {
      try {
        source = posixRegExp(pattern, f.has('E'), '').source
      } catch (error) {
        throw new CommandError(
          (error as Error).message.replace(/^Invalid regular expression: /, ''),
          2,
        )
      }
    }
    if (f.has('w')) source = '(?<![\\w])(?:' + source + ')(?![\\w])'
    if (f.has('x')) source = '^(?:' + source + ')$'
    return source
  })
  let regex: RegExp
  try {
    regex = new RegExp(
      sources.length ? sources.map((source) => '(?:' + source + ')').join('|') : '(?!)',
      flags,
    )
  } catch (error) {
    throw new CommandError('invalid regular expression: ' + (error as Error).message, 2)
  }
  const recursive = f.has('r') || f.has('R') || last(parsed, 'd') === 'recurse'
  const implicit = !operands.length && recursive
  const include = (parsed.values.get('include') ?? []).map((glob) => globRegExp(glob))
  const exclude = (parsed.values.get('exclude') ?? []).map((glob) => globRegExp(glob))
  const excludeDir = (parsed.values.get('exclude-dir') ?? []).map((glob) => globRegExp(glob))
  const targets: ({ path: string; display: string; pruned?: boolean; matched?: boolean } | '-')[] =
    []
  let status = 1
  let errors = false
  let directories = false
  const prunable =
    !f.has('v') && !f.has('L') && !f.has('c')
      ? literals(
          patterns,
          f.has('F') ? 'fixed' : f.has('P') ? 'perl' : f.has('E') ? 'extended' : 'basic',
        )
      : null
  const exactTerms =
    (f.has('l') || f.has('q')) &&
    !f.has('v') &&
    !f.has('L') &&
    !f.has('c') &&
    !f.has('w') &&
    !f.has('x') &&
    !f.has('z')
      ? exactLiterals(
          patterns,
          f.has('F') ? 'fixed' : f.has('P') ? 'perl' : f.has('E') ? 'extended' : 'basic',
        )
      : null
  const collect = async (operand: string, display: string, top: boolean, tree?: Pruned | null) => {
    const path = ctx.resolve(operand)
    const stat = tree && !top ? prunedStat(tree, path) : await ctx.fs.stat(path)
    if (!stat && device(path) !== undefined) {
      targets.push({ path, display })
      return
    }
    if (!stat) {
      if (!f.has('s')) ctx.stderr.write('grep: ' + display + ': No such file or directory\n')
      errors = true
      return
    }
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (stat.kind === 'directory') {
      if (!recursive) {
        if (last(parsed, 'd') === 'skip') return
        if (!f.has('s')) ctx.stderr.write('grep: ' + display + ': Is a directory\n')
        errors = true
        return
      }
      directories = true
      if (!top && excludeDir.some((glob) => glob.test(name))) return
      if (top)
        tree = await pruned(
          ctx.fs,
          path,
          prunable,
          exactTerms && { literals: exactTerms, ignoreCase: f.has('i') },
        )
      for (const child of tree ? prunedList(tree, path) : await ctx.fs.list(path))
        await collect(
          (path === '/' ? '' : path) + '/' + child,
          display === '' ? child : display.replace(/\/$/, '') + '/' + child,
          false,
          tree,
        )
      return
    }
    if (!top || recursive) {
      if (include.length && !include.some((glob) => glob.test(name))) return
      if (exclude.some((glob) => glob.test(name))) return
    }
    targets.push({
      path,
      display,
      pruned: (!!tree && !top) || (top && !!prunable),
      matched: !!tree?.exact && !top,
    })
  }
  if (implicit) await collect('.', '', true)
  else
    for (const operand of operands) {
      if (operand === '-') targets.push('-')
      else await collect(operand, operand, true)
    }
  const named = f.has('H') || (!f.has('h') && (operands.length > 1 || directories))
  const context = Number(last(parsed, 'n') ?? 0)
  const after = Number(last(parsed, 'A') ?? last(parsed, 'C') ?? context)
  const before = Number(last(parsed, 'B') ?? last(parsed, 'C') ?? context)
  const max = last(parsed, 'm') === undefined ? Infinity : Number(last(parsed, 'm'))
  const terminator = f.has('z') ? '\0' : '\n'
  const nameEnd = f.has('Z') ? '\0' : ':'
  const state: ScanState = { printed: false }
  const listing = f.has('q') || f.has('l') || f.has('L') || f.has('c')
  const separator = f.has('z') ? '\0' : '\n'
  const search = async (
    source: () => Promise<string | null>,
    name: string,
    stream: boolean,
  ): Promise<boolean> => {
    let matches = 0
    let binary = false
    let base = 0
    for (let text = await source(); text !== null; text = await source()) {
      binary ||= !f.has('a') && !f.has('z') && text.includes('\0')
      const silent = listing || binary || last(parsed, 'binary-files') === 'without-match'
      let output = ''
      matches += scan(text, {
        regex,
        invert: f.has('v'),
        max: max - matches,
        before,
        after,
        only: f.has('o'),
        numbers: f.has('n'),
        offsets: f.has('b'),
        name: named ? name + (f.has('Z') ? '\0' : '') : undefined,
        base,
        separator,
        terminator,
        silent,
        state,
        write: (chunk) => void (output += chunk),
      })
      if (f.has('Z') && named) output = output.replace(/\0[:-]/g, '\0')
      await put(ctx, output)
      if (!stream) continue
      if (f.has('n'))
        for (let i = text.indexOf(separator); i >= 0; i = text.indexOf(separator, i + 1)) base++
      if ((f.has('q') && matches) || matches >= max) {
        ctx.stdin.close()
        break
      }
    }
    if (binary && matches && !listing && last(parsed, 'binary-files') !== 'without-match')
      ctx.stderr.write('grep: ' + name + ': binary file matches\n')
    if (f.has('q')) return matches > 0
    if (f.has('c')) ctx.stdout.write((named ? name + nameEnd : '') + matches + '\n')
    if (f.has('l') && matches) ctx.stdout.write(name + (f.has('Z') ? '\0' : '\n'))
    if (f.has('L') && !matches) ctx.stdout.write(name + (f.has('Z') ? '\0' : '\n'))
    return matches > 0
  }
  const once = (text: string) => {
    let done = false
    return async () => {
      if (done) return null
      done = true
      return text
    }
  }
  const stdin = (): [() => Promise<string | null>, boolean] => {
    if (!before && !after && !f.has('b')) return [batches(ctx.stdin, separator), true]
    let done = false
    return [
      async () => {
        if (done) return null
        done = true
        return ctx.stdin.text()
      },
      false,
    ]
  }
  const stdinName = last(parsed, 'label') ?? '(standard input)'
  if (!operands.length && !recursive) {
    const [source, stream] = stdin()
    if (await search(source, stdinName, stream)) status = 0
  } else {
    let stdinUsed = false
    const partial = prunable && !f.has('b') && !before && !after && !f.has('z') ? prunable : null
    const take = ahead(targets, (target) =>
      target === '-' || target.matched || device(target.path) !== undefined
        ? null
        : partial && target.pruned
          ? (ctx.fs
              .excerpt?.(target.path, partial)
              .then((bytes) => bytes ?? ctx.fs.read(target.path)) ?? ctx.fs.read(target.path))
          : ctx.fs.read(target.path),
    )
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]
      const pending = take(index)
      if (ctx.stdout.closed) throw new PipeError()
      if (target !== '-' && target.matched) {
        status = 0
        if (f.has('q')) return 0
        ctx.stdout.write(target.display + (f.has('Z') ? '\0' : '\n'))
        continue
      }
      let source: () => Promise<string | null>
      let stream = false
      let display: string
      if (target === '-') {
        if (stdinUsed) continue
        stdinUsed = true
        ;[source, stream] = stdin()
        display = stdinName
      } else {
        display = target.display
        try {
          source = once(device(target.path) ?? decode(await pending!))
        } catch (error) {
          if (!(error instanceof FsError)) throw error
          errors = true
          continue
        }
      }
      if (await search(source, display, stream)) {
        status = 0
        if (f.has('q')) return 0
      }
    }
  }
  return errors && !(f.has('q') && status === 0) ? 2 : status
})

type SortKey = { start: number; startChar: number; end: number; endChar: number; flags: string }

function parseKey(spec: string): SortKey {
  const match = spec.match(/^(\d+)(?:\.(\d+))?([a-zA-Z]*)(?:,(\d+)(?:\.(\d+))?([a-zA-Z]*))?$/)
  if (!match) throw new CommandError('invalid key specification: ' + spec, 2)
  return {
    start: Number(match[1]),
    startChar: Number(match[2] ?? 1),
    end: match[4] ? Number(match[4]) : Infinity,
    endChar: Number(match[5] ?? 0),
    flags: (match[3] ?? '') + (match[6] ?? ''),
  }
}

function humanValue(text: string): number {
  const match = text.trim().match(/^([+-]?\d*\.?\d+)\s*([KMGTPE]?)/i)
  if (!match) return 0
  return Number(match[1]) * 1024 ** ' KMGTPE'.indexOf((match[2] || ' ').toUpperCase())
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function versionCompare(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? []
  const pb = b.match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? ''
    const y = pb[i] ?? ''
    if (/^\d/.test(x) && /^\d/.test(y)) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

type Compact = { numeric: boolean; reverse: boolean; stable: boolean; unique: boolean }

function lineCount(text: string, separator: string): number {
  if (!text) return 0
  let n = 0
  for (let at = text.indexOf(separator); at >= 0; at = text.indexOf(separator, at + 1)) n++
  return text.endsWith(separator) ? n : n + 1
}

function mergeSort(order: Uint32Array<ArrayBuffer>, compare: (a: number, b: number) => number) {
  const n = order.length
  const run = 32
  for (let lo = 0; lo < n; lo += run) {
    const hi = Math.min(lo + run, n)
    for (let i = lo + 1; i < hi; i++) {
      const value = order[i]!
      let j = i - 1
      while (j >= lo && compare(order[j]!, value) > 0) {
        order[j + 1] = order[j]!
        j--
      }
      order[j + 1] = value
    }
  }
  if (n <= run) return
  let source = order
  let target = new Uint32Array(n)
  for (let width = run; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n)
      const hi = Math.min(lo + 2 * width, n)
      if (mid >= hi || compare(source[mid - 1]!, source[mid]!) <= 0) {
        target.set(source.subarray(lo, hi), lo)
        continue
      }
      let i = lo
      let j = mid
      let k = lo
      while (i < mid && j < hi)
        target[k++] = compare(source[j]!, source[i]!) < 0 ? source[j++]! : source[i++]!
      while (i < mid) target[k++] = source[i++]!
      while (j < hi) target[k++] = source[j++]!
    }
    ;[source, target] = [target, source]
  }
  if (source !== order) order.set(source)
}

function numberAt(text: string, start: number, end: number): number {
  let i = start
  while (i < end) {
    const c = text.charCodeAt(i)
    if (c !== 32 && (c < 9 || c > 13)) break
    i++
  }
  let negative = false
  if (i < end && text.charCodeAt(i) === 45) {
    negative = true
    i++
  }
  let value = 0
  let digits = 0
  while (i < end && digits < 10) {
    const c = text.charCodeAt(i)
    if (c < 48 || c > 57) break
    value = value * 10 + c - 48
    digits++
    i++
  }
  const next = i < end ? text.charCodeAt(i) : 32
  if (
    digits &&
    digits < 10 &&
    next !== 46 &&
    next !== 69 &&
    next !== 101 &&
    next !== 120 &&
    next !== 88
  )
    return negative ? -value || 0 : value
  return parseFloat(text.slice(start, end).trim()) || 0
}

async function compactSort(
  ctx: CommandContext,
  text: string,
  separator: string,
  order: Compact,
  out: string | undefined,
) {
  const n = lineCount(text, separator)
  const length = text.length
  const mark = separator.charCodeAt(0)
  const sign = order.reverse ? -1 : 1
  const endOf = (start: number) => {
    const end = text.indexOf(separator, start)
    return end < 0 ? length : end
  }
  const textCompare = (a: number, b: number): number => {
    for (;;) {
      let x = a < length ? text.charCodeAt(a) : -1
      let y = b < length ? text.charCodeAt(b) : -1
      if (x === mark) x = -1
      if (y === mark) y = -1
      if (x !== y) return x < y ? -1 : 1
      if (x < 0) return 0
      a++
      b++
    }
  }
  const starts = (visit: (start: number, end: number, index: number) => void) => {
    for (let start = 0, index = 0; index < n; index++) {
      const end = endOf(start)
      visit(start, end, index)
      start = end + 1
    }
  }
  const write = async (next: (index: number) => number, total: number) => {
    budget(
      ctx.limits,
      length + 8 * n + (out === undefined ? 0 : 2 * length),
      'sort: ' + n + ' lines',
    )
    const parts: string[] = []
    let chunk = ''
    let previous = -1
    for (let i = 0; i < total; i++) {
      const start = next(i)
      if (order.unique && previous >= 0 && duplicate(previous, start)) continue
      previous = start
      chunk += text.slice(start, endOf(start)) + separator
      if (chunk.length < 1 << 16) continue
      if (out === undefined) await put(ctx, chunk)
      else parts.push(chunk)
      chunk = ''
    }
    if (out === undefined) await put(ctx, chunk)
    else {
      parts.push(chunk)
      await ctx.fs.write(ctx.resolve(out), encode(parts.join('')))
    }
  }
  let duplicate = (a: number, b: number) => textCompare(a, b) === 0
  if (!order.numeric) {
    budget(ctx.limits, length + 8 * n, 'sort: ' + n + ' lines')
    const positions = new Uint32Array(n)
    starts((start, _end, index) => void (positions[index] = start))
    mergeSort(positions, (a, b) => sign * textCompare(a, b))
    await write((i) => positions[i]!, n)
    return
  }
  budget(ctx.limits, length + 8 * n, 'sort: ' + n + ' lines')
  const packed = new BigInt64Array(n)
  const words = new Int32Array(packed.buffer)
  let integral = true
  starts((start, end, index) => {
    if (!integral) return
    const key = numberAt(text, start, end)
    if (!Number.isInteger(key) || key > 0x7fffffff || key < -0x7fffffff) {
      integral = false
      return
    }
    words[2 * index] = start
    words[2 * index + 1] = sign * key
  })
  if (integral) {
    packed.sort()
    if (!order.stable && !order.unique) {
      for (let lo = 0; lo < n; ) {
        let hi = lo + 1
        while (hi < n && words[2 * hi + 1] === words[2 * lo + 1]) hi++
        if (hi - lo > 1) {
          const run: number[] = []
          for (let i = lo; i < hi; i++) run.push(words[2 * i]! >>> 0)
          run.sort((a, b) => sign * textCompare(a, b))
          for (let i = lo; i < hi; i++) words[2 * i] = run[i - lo]!
        }
        lo = hi
      }
    }
    if (order.unique) {
      let previous = Number.NaN
      const kept: number[] = []
      for (let i = 0; i < n; i++) {
        const key = words[2 * i + 1]!
        if (key === previous) continue
        previous = key
        kept.push(i)
      }
      duplicate = () => false
      await write((i) => words[2 * kept[i]!]! >>> 0, kept.length)
      return
    }
    await write((i) => words[2 * i]! >>> 0, n)
    return
  }
  budget(ctx.limits, length + 20 * n, 'sort: ' + n + ' lines')
  const positions = new Uint32Array(n)
  const keys = new Float64Array(n)
  starts((start, end, index) => {
    positions[index] = start
    keys[index] = numberAt(text, start, end)
  })
  const indices = new Uint32Array(n)
  for (let i = 0; i < n; i++) indices[i] = i
  const tie =
    order.stable || order.unique
      ? () => 0
      : (a: number, b: number) => sign * textCompare(positions[a]!, positions[b]!)
  mergeSort(indices, (a, b) => sign * (keys[a]! - keys[b]!) || tie(a, b))
  if (order.unique) {
    const kept: number[] = []
    for (let i = 0; i < n; i++)
      if (!i || keys[indices[i]!] !== keys[indices[i - 1]!]) kept.push(indices[i]!)
    duplicate = () => false
    await write((i) => positions[kept[i]!]!, kept.length)
    return
  }
  await write((i) => positions[indices[i]!]!, n)
}

const sort: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'nrufbsghVMcCRz',
    values: 'ktoST',
    long: {
      'numeric-sort': 'n',
      reverse: 'r',
      unique: 'u',
      'ignore-case': 'f',
      'ignore-leading-blanks': 'b',
      stable: 's',
      'general-numeric-sort': 'g',
      'human-numeric-sort': 'h',
      'version-sort': 'V',
      key: 'k',
      'field-separator': 't',
      output: 'o',
      check: 'c',
      'random-sort': 'R',
      'month-sort': 'M',
      'zero-terminated': 'z',
      'dictionary-order': 'd',
      parallel: 'parallel',
      'buffer-size': 'S',
      'temporary-directory': 'T',
    },
  })
  const f = parsed.flags
  const { text, status } = await allInput(ctx, parsed.operands)
  if (!parsed.values.has('k') && ![...'cCRfbhMVd'].some((flag) => f.has(flag))) {
    await compactSort(
      ctx,
      text,
      f.has('z') ? '\0' : '\n',
      {
        numeric: f.has('n') || f.has('g'),
        reverse: f.has('r'),
        stable: f.has('s'),
        unique: f.has('u'),
      },
      last(parsed, 'o'),
    )
    return status
  }
  budget(
    ctx.limits,
    2 * text.length + 160 * lineCount(text, f.has('z') ? '\0' : '\n'),
    'sort: ' + lineCount(text, f.has('z') ? '\0' : '\n') + ' lines',
  )
  const items = f.has('z')
    ? text.split('\0').filter((item, index, all) => item !== '' || index < all.length - 1)
    : lines(text)
  const separator = last(parsed, 't')
  const keys = (parsed.values.get('k') ?? []).map(parseKey)
  const split = (line: string): string[] =>
    separator !== undefined ? line.split(separator) : (line.match(/\s*\S+/g) ?? [''])
  const extract = (line: string, key: SortKey): string => {
    const fields = split(line)
    if (key.end === Infinity) {
      const rest = fields.slice(key.start - 1).join(separator ?? '')
      return (separator === undefined ? rest.replace(/^\s+/, '') : rest).slice(key.startChar - 1)
    }
    const span = fields.slice(key.start - 1, key.end).join(separator ?? '')
    const trimmed = separator === undefined ? span.replace(/^\s+/, '') : span
    const endOffset = key.endChar
      ? trimmed.length - (fields[key.end - 1] ?? '').replace(/^\s+/, '').length + key.endChar
      : trimmed.length
    return trimmed.slice(key.startChar - 1, endOffset)
  }
  type Order = {
    numeric: boolean
    human: boolean
    version: boolean
    month: boolean
    fold: boolean
    blanks: boolean
    reverse: boolean
  }
  const orderOf = (flags: string): Order => ({
    numeric: flags.includes('n') || flags.includes('g'),
    human: flags.includes('h'),
    version: flags.includes('V'),
    month: flags.includes('M'),
    fold: flags.includes('f'),
    blanks: flags.includes('b'),
    reverse: flags.includes('r'),
  })
  const prepare = (text: string, order: Order): string | number => {
    if (order.fold) text = text.toUpperCase()
    if (order.blanks) text = text.trimStart()
    if (order.numeric) return parseFloat(text.trim()) || 0
    if (order.human) return humanValue(text)
    if (order.month) return MONTHS.indexOf(text.trim().slice(0, 3).toUpperCase())
    return text
  }
  const comparator = (order: Order): ((a: string | number, b: string | number) => number) => {
    const sign = order.reverse ? -1 : 1
    if (order.numeric || order.human || order.month)
      return (a, b) => sign * ((a as number) - (b as number))
    if (order.version) return (a, b) => sign * versionCompare(a as string, b as string)
    return (a, b) => (a < b ? -sign : a > b ? sign : 0)
  }
  const global = [...f].join('')
  const globalOrder = orderOf(global)
  const keyOrders = keys.map((key) => orderOf((key.flags || global).replace(/[usz]/g, '')))
  const keyCompare = keyOrders.map(comparator)
  const globalCompare = comparator(globalOrder)
  const lineSign = f.has('r') ? -1 : 1
  const stable = f.has('s')
  const unique = f.has('u')
  type Item = { line: string; index: number; rank: number; keys: (string | number)[] }
  const decorate = (line: string, index: number): Item => ({
    line,
    index,
    rank: 0,
    keys: keys.length
      ? keys.map((key, k) => prepare(extract(line, key), keyOrders[k]))
      : [prepare(line, globalOrder)],
  })
  const compare = (a: Item, b: Item): number => {
    for (let k = 0; k < keyCompare.length; k++) {
      const result = keyCompare[k](a.keys[k], b.keys[k])
      if (result) return result
    }
    if (keys.length && stable) return 0
    if (!keys.length) {
      const result = globalCompare(a.keys[0], b.keys[0])
      if (result || stable || unique) return result
    }
    if (unique) return 0
    if (a.rank !== b.rank) return (a.rank - b.rank) * lineSign
    return a.line < b.line ? -lineSign : a.line > b.line ? lineSign : 0
  }
  if (f.has('c') || f.has('C')) {
    for (let i = 1; i < items.length; i++) {
      if (compare(decorate(items[i - 1], i - 1), decorate(items[i], i)) > 0) {
        if (f.has('c')) ctx.stderr.write('sort: -:' + (i + 1) + ': disorder: ' + items[i] + '\n')
        return 1
      }
    }
    return 0
  }
  let sorted = items.map(decorate)
  if (f.has('R')) {
    for (let i = sorted.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[sorted[i], sorted[j]] = [sorted[j], sorted[i]]
    }
  } else {
    if (keys.length && !stable && !unique && sorted.length > 1000) {
      const order = sorted.slice().sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0))
      for (let i = 1; i < order.length; i++)
        order[i].rank = order[i].line === order[i - 1].line ? order[i - 1].rank : i
    }
    sorted.sort(compare)
  }
  if (f.has('u'))
    sorted = sorted.filter((item, index) => index === 0 || compare(sorted[index - 1], item) !== 0)
  const output = f.has('z')
    ? sorted.map((item) => item.line + '\0').join('')
    : joinLines(sorted.map((item) => item.line))
  const out = last(parsed, 'o')
  if (out !== undefined) await ctx.fs.write(ctx.resolve(out), encode(output))
  else await put(ctx, output)
  return status
}

const uniq: CommandHandler = streaming(async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'cdui',
    values: 'fsw',
    long: {
      count: 'c',
      repeated: 'd',
      unique: 'u',
      'ignore-case': 'i',
      'skip-fields': 'f',
      'skip-chars': 's',
      'check-chars': 'w',
    },
  })
  const f = parsed.flags
  const skipFields = Number(last(parsed, 'f') ?? 0)
  const skipChars = Number(last(parsed, 's') ?? 0)
  const width = last(parsed, 'w') === undefined ? undefined : Number(last(parsed, 'w'))
  const key = (line: string) => {
    let value = line
    for (let i = 0; i < skipFields; i++) value = value.replace(/^\s*\S+/, '')
    value = value.slice(skipChars)
    if (width !== undefined) value = value.slice(0, width)
    return f.has('i') ? value.toLowerCase() : value
  }
  let current: { line: string; key: string; count: number } | undefined
  let out = ''
  const target = parsed.operands[1]
  const flush = (group: { line: string; count: number }) => {
    if ((f.has('d') && group.count < 2) || (f.has('u') && group.count !== 1)) return
    out += (f.has('c') ? String(group.count).padStart(7) + ' ' : '') + group.line + '\n'
  }
  const status = await eachBatch(ctx, parsed.operands.slice(0, 1), async (text) => {
    for (const line of lines(text)) {
      const value = key(line)
      if (current && current.key === value) current.count++
      else {
        if (current) flush(current)
        current = { line, key: value, count: 1 }
      }
    }
    if (target === undefined && out.length > 65536) {
      await put(ctx, out)
      out = ''
    }
  })
  if (current) flush(current)
  if (target !== undefined) await ctx.fs.write(ctx.resolve(target), encode(out))
  else await put(ctx, out)
  return status
})

function ranges(spec: string): (n: number) => boolean {
  const parts = spec.split(',').map((part) => {
    const match = part.match(/^(\d*)(-?)(\d*)$/)
    if (!match || (!match[1] && !match[3])) throw new CommandError('invalid field range', 1)
    const from = match[1] ? Number(match[1]) : 1
    const to = match[2] ? (match[3] ? Number(match[3]) : Infinity) : from
    return [from, to] as const
  })
  return (n) => parts.some(([from, to]) => n >= from && n <= to)
}

function merged(spec: string): [number, number][] {
  const parts = spec
    .split(',')
    .map((part) => {
      const match = part.match(/^(\d*)(-?)(\d*)$/)!
      const from = match[1] ? Number(match[1]) : 1
      return [from, match[2] ? (match[3] ? Number(match[3]) : Infinity) : from] as [number, number]
    })
    .sort((a, b) => a[0] - b[0])
  const spans: [number, number][] = []
  for (const part of parts) {
    const previous = spans[spans.length - 1]
    if (previous && part[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], part[1])
    else spans.push(part)
  }
  return spans
}

const cut: CommandHandler = streaming(async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'sn',
    values: 'dfcb',
    long: {
      delimiter: 'd',
      fields: 'f',
      characters: 'c',
      bytes: 'b',
      'only-delimited': 's',
      complement: 'C',
      'output-delimiter': 'output-delimiter',
      'zero-terminated': 'z',
    },
  })
  const fields = last(parsed, 'f')
  const chars = last(parsed, 'c') ?? last(parsed, 'b')
  if (
    (parsed.values.get('f')?.length ?? 0) +
      (parsed.values.get('c')?.length ?? 0) +
      (parsed.values.get('b')?.length ?? 0) >
    1
  )
    throw new CommandError('only one list may be specified')
  if (!fields && !chars)
    throw new CommandError('you must specify a list of bytes, characters, or fields')
  const complement = parsed.flags.has('C')
  const selector = ranges((fields ?? chars)!)
  const pick = (n: number) => selector(n) !== complement
  const delimiter = last(parsed, 'd') ?? '\t'
  if (delimiter.length !== 1) throw new CommandError('the delimiter must be a single character')
  const output = last(parsed, 'output-delimiter') ?? (fields ? delimiter : '')
  const spans = !fields && !complement && output === '' ? merged((fields ?? chars)!) : undefined
  const status = await eachBatch(ctx, parsed.operands, (text) => {
    const out: string[] = []
    for (const line of lines(text)) {
      if (fields) {
        if (!line.includes(delimiter)) {
          if (!parsed.flags.has('s')) out.push(line)
          continue
        }
        out.push(
          line
            .split(delimiter)
            .filter((_, index) => pick(index + 1))
            .join(output),
        )
      } else if (spans && !/[\uD800-\uDFFF]/.test(line)) {
        let picked = ''
        for (const [from, to] of spans) picked += line.slice(from - 1, to)
        out.push(picked)
      } else out.push([...line].filter((_, index) => pick(index + 1)).join(output))
    }
    return put(ctx, joinLines(out))
  })
  return status
})

const CLASS_CHARS: Record<string, string> = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digit: '0123456789',
  space: ' \t\n\r\f\v',
  blank: ' \t',
  punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  xdigit: '0123456789ABCDEFabcdef',
}
CLASS_CHARS.alpha = CLASS_CHARS.lower + CLASS_CHARS.upper
CLASS_CHARS.alnum = CLASS_CHARS.alpha + CLASS_CHARS.digit

function trSet(spec: string): string[] {
  const out: string[] = []
  const [text] = escapes(spec)
  for (let i = 0; i < text.length; i++) {
    const cls = text.slice(i).match(/^\[:(\w+):\]/)
    if (cls && CLASS_CHARS[cls[1]]) {
      out.push(...CLASS_CHARS[cls[1]])
      i += cls[0].length - 1
      continue
    }
    const repeat = text.slice(i).match(/^\[(.)\*(\d*)\]/)
    if (repeat) {
      out.push(...Array(Number(repeat[2] || 0) || 1).fill(repeat[1]))
      i += repeat[0].length - 1
      continue
    }
    if (text[i + 1] === '-' && i + 2 < text.length) {
      const from = text.charCodeAt(i)
      const to = text.charCodeAt(i + 2)
      for (let c = from; c <= to; c++) out.push(String.fromCharCode(c))
      i += 2
      continue
    }
    out.push(text[i])
  }
  return out
}

const tr: CommandHandler = streaming(async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'dscCt',
    long: { delete: 'd', 'squeeze-repeats': 's', complement: 'c', truncate: 't' },
  })
  const f = parsed.flags
  const [first, second] = parsed.operands
  if (first === undefined) throw new CommandError('missing operand')
  const complement = f.has('c') || f.has('C')
  const set2 = second !== undefined ? trSet(second) : []
  const list1 =
    f.has('t') && second !== undefined ? trSet(first).slice(0, set2.length) : trSet(first)
  const set1 = new Set(list1)
  const inSet1 = (c: string) => set1.has(c) !== complement
  let previous = ''
  let last = -1
  let map: Int32Array | undefined
  let squeezable: Uint8Array | undefined
  const squeeze = f.has('s')
    ? new Set(f.has('d') || second === undefined ? (second === undefined ? [...set1] : set2) : set2)
    : undefined
  const translate = (c: string): string | undefined => {
    if (f.has('d')) return inSet1(c) ? undefined : c
    if (second === undefined || !inSet1(c)) return c
    if (complement) return set2[set2.length - 1] ?? c
    const index = list1.lastIndexOf(c)
    return index < set2.length ? set2[index] : (set2[set2.length - 1] ?? c)
  }
  const squeezes = (value: string) =>
    squeeze !== undefined &&
    (second === undefined && !f.has('d') ? inSet1(value) : squeeze.has(value))
  const simple = [...list1, ...set2].every((c) => c.length === 1 && !/[\uD800-\uDFFF]/.test(c))
  const convert = (input: string): string => {
    if (simple && (!complement || !/[\uD800-\uDFFF]/.test(input))) {
      if (!map || !squeezable) {
        map = new Int32Array(65536)
        squeezable = new Uint8Array(65536)
        for (let code = 0; code < 65536; code++) {
          const value = translate(String.fromCharCode(code))
          map[code] = value === undefined ? -1 : value.charCodeAt(0)
          if (value !== undefined && squeezes(value)) squeezable[map[code]] = 1
        }
      }
      const codes = new Uint16Array(input.length)
      let n = 0
      for (let i = 0; i < input.length; i++) {
        const value = map[input.charCodeAt(i)]
        if (value < 0 || (value === last && squeezable[value])) continue
        codes[n++] = value
        last = value
      }
      previous = last < 0 ? previous : String.fromCharCode(last)
      const chunks: string[] = []
      for (let i = 0; i < n; i += 8192)
        chunks.push(
          String.fromCharCode.apply(
            null,
            codes.subarray(i, Math.min(n, i + 8192)) as unknown as number[],
          ),
        )
      return chunks.join('')
    }
    let out = ''
    for (const c of input) {
      let value: string | undefined = c
      if (f.has('d')) {
        if (inSet1(c)) continue
      } else if (second !== undefined && inSet1(c)) {
        if (complement) value = set2[set2.length - 1] ?? c
        else {
          const index = list1.lastIndexOf(c)
          value = index < set2.length ? set2[index] : (set2[set2.length - 1] ?? c)
        }
      }
      if (
        squeeze &&
        value === previous &&
        (second === undefined && !f.has('d') ? inSet1(value) : squeeze.has(value))
      )
        continue
      out += value
      previous = value
    }
    last = previous.length === 1 ? previous.charCodeAt(0) : -1
    return out
  }
  for (let chunk = await ctx.stdin.chunk(); chunk !== null; chunk = await ctx.stdin.chunk()) {
    const code = chunk.charCodeAt(chunk.length - 1)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = await ctx.stdin.readChars(1)
      chunk += next
    }
    await put(ctx, convert(chunk))
  }
  return 0
})

const seq: CommandHandler = async (ctx) => {
  const parsed = options(
    ctx.args.map((arg) => (/^-\d/.test(arg) ? '\u0000' + arg : arg)),
    { flags: 'w', values: 'sf', long: { separator: 's', 'equal-width': 'w', format: 'f' } },
  )
  const numbers = parsed.operands.map((arg) => arg.replace('\u0000', ''))
  if (!numbers.length || numbers.length > 3) throw new CommandError('missing operand')
  const [first, step, end] =
    numbers.length === 1
      ? ['1', '1', numbers[0]]
      : numbers.length === 2
        ? [numbers[0], '1', numbers[1]]
        : numbers
  const values = [first, step, end].map(Number)
  if (values.some(Number.isNaN)) throw new CommandError('invalid floating point argument')
  const [a, inc, b] = values
  if (inc === 0) throw new CommandError("invalid Zero increment value: '0'")
  const decimals = Math.max(
    ...[first, step].map((text) => (text.includes('.') ? text.split('.')[1].length : 0)),
  )
  const spec = last(parsed, 'f')
  if (!parsed.flags.has('w')) {
    const separator = last(parsed, 's') ?? '\n'
    let buffer = ''
    let written = 0
    let i = 0
    for (; ; i++) {
      const value = a + i * inc
      if (inc > 0 ? value > b + 1e-10 : value < b - 1e-10) break
      buffer +=
        (i ? separator : '') + (spec ? format(spec, [value], false).text : value.toFixed(decimals))
      if (buffer.length < 65536) continue
      if (ctx.stdout.bounded && (written += buffer.length) > ctx.limits.maxBufferLength)
        throw new CommandError('output exceeded ' + ctx.limits.maxBufferLength + ' characters')
      await put(ctx, buffer)
      buffer = ''
    }
    await put(ctx, buffer + (i ? '\n' : ''))
    return 0
  }
  const out: string[] = []
  let length = 0
  for (let i = 0; ; i++) {
    const value = a + i * inc
    if (inc > 0 ? value > b + 1e-10 : value < b - 1e-10) break
    if ((length += 8) > ctx.limits.maxBufferLength)
      throw new CommandError('output exceeded ' + ctx.limits.maxBufferLength + ' characters')
    out.push(
      last(parsed, 'f') ? format(last(parsed, 'f')!, [value], false).text : value.toFixed(decimals),
    )
  }
  if (parsed.flags.has('w')) {
    const width = out.reduce((width, value) => Math.max(width, value.length), 0)
    for (let i = 0; i < out.length; i++)
      out[i] = out[i].startsWith('-')
        ? '-' + out[i].slice(1).padStart(width - 1, '0')
        : out[i].padStart(width, '0')
  }
  ctx.stdout.write(out.length ? out.join(last(parsed, 's') ?? '\n') + '\n' : '')
  return 0
}

const rev: CommandHandler = streaming(
  async (ctx) =>
    await eachLine(ctx, ctx.args, (line) =>
      /[\uD800-\uDFFF]/.test(line)
        ? [...line].reverse().join('')
        : line.split('').reverse().join(''),
    ),
)

const tac: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'br',
    values: 's',
    long: { before: 'b', regex: 'r', separator: 's' },
  })
  const [separator] = escapes(last(parsed, 's') ?? '\n')
  if (separator === '') throw new CommandError('separator cannot be empty')
  return eachInput(ctx, parsed.operands, async (text) => {
    if (separator.length === 1) {
      const shift = parsed.flags.has('b') ? 0 : 1
      let hi = text.length
      let from = text.length - 1
      let out = ''
      for (;;) {
        const at = from < 0 ? -1 : text.lastIndexOf(separator, from)
        const lo = at < 0 ? 0 : at + shift
        out += text.slice(lo, hi)
        if (out.length >= 1 << 16) {
          await put(ctx, out)
          out = ''
        }
        if (at < 0) break
        hi = lo
        from = at - 1
      }
      await put(ctx, out)
      return
    }
    budget(ctx.limits, 2 * text.length + 40 * lineCount(text, separator), 'tac: its input')
    const parts = text.split(separator)
    const tail = parts.pop()!
    const records = parsed.flags.has('b')
      ? parts.map((part, index) => (index ? separator : '') + part)
      : parts.map((part) => part + separator)
    if (parsed.flags.has('b')) {
      if (parts.length) records.push(separator + tail)
      else if (tail !== '') records.push(tail)
    } else if (tail !== '') records.push(tail)
    ctx.stdout.write(records.reverse().join(''))
  })
}

const nl: CommandHandler = streaming(async (ctx) => {
  const parsed = options(ctx.args, {
    values: 'bwsvinh',
    long: {
      'body-numbering': 'b',
      'number-width': 'w',
      'number-separator': 's',
      'starting-line-number': 'v',
      'line-increment': 'i',
      'number-format': 'n',
      'header-numbering': 'h',
    },
  })
  const style = last(parsed, 'b') ?? 't'
  const width = Number(last(parsed, 'w') ?? 6)
  const separator = last(parsed, 's') ?? '\t'
  const increment = Number(last(parsed, 'i') ?? 1)
  const formatting = last(parsed, 'n') ?? 'rn'
  if (!['ln', 'rn', 'rz'].includes(formatting))
    throw new CommandError("invalid line numbering format: '" + formatting + "'")
  const pattern = style.startsWith('p') ? posixRegExp(style.slice(1), false) : undefined
  let n = Number(last(parsed, 'v') ?? 1)
  const number = (value: number) => {
    const digits = String(value)
    if (formatting === 'ln') return digits.padEnd(width)
    if (formatting === 'rz')
      return value < 0 ? '-' + String(-value).padStart(width - 1, '0') : digits.padStart(width, '0')
    return digits.padStart(width)
  }
  return eachLine(
    ctx,
    parsed.operands,
    (line) => {
      const numbered =
        style === 'a' ||
        (style === 't' && line !== '') ||
        (pattern !== undefined && pattern.test(line))
      if (!numbered) return ' '.repeat(width + separator.length) + line
      const result = number(n) + separator + line
      n += increment
      return result
    },
    true,
  )
})

const paste: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 's',
    values: 'd',
    long: { serial: 's', delimiters: 'd' },
  })
  const [delimiters] = escapes(last(parsed, 'd') ?? '\t')
  const operands = parsed.operands.length ? parsed.operands : ['-']
  const delimiter = (index: number) => delimiters[index % Math.max(1, delimiters.length)] ?? ''
  if (parsed.flags.has('s')) {
    let status = 0
    let stdin = false
    for (const operand of operands) {
      let text = ''
      if (operand === '-') {
        text = stdin ? '' : ctx.stdin.read()
        stdin = true
      } else {
        try {
          text = await readInput(ctx, operand)
        } catch (error) {
          if (!(error instanceof FsError)) throw error
          ctx.stderr.write('paste: ' + operand + ': No such file or directory\n')
          status = 1
          continue
        }
      }
      let out = ''
      for (let start = 0, index = 0; start < text.length; index++) {
        let end = text.indexOf('\n', start)
        if (end < 0) end = text.length
        out += (index ? delimiter(index - 1) : '') + text.slice(start, end)
        start = end + 1
        if (out.length < 1 << 16) continue
        await put(ctx, out)
        out = ''
      }
      await put(ctx, out + '\n')
    }
    return status
  }
  const columns: string[][] = []
  let status = 0
  let stdin: string[] | undefined
  const dashes = operands.filter((operand) => operand === '-').length
  let dash = 0
  for (const operand of operands) {
    if (operand === '-') {
      stdin ??= lines(ctx.stdin.read())
      const offset = dash++
      columns.push(
        parsed.flags.has('s') || dashes === 1
          ? offset
            ? []
            : stdin
          : stdin.filter((_, index) => index % dashes === offset),
      )
      continue
    }
    try {
      columns.push(lines(decode(await ctx.fs.read(ctx.resolve(operand)))))
    } catch {
      ctx.stderr.write('paste: ' + operand + ': No such file or directory\n')
      status = 1
    }
  }
  const join = (values: string[]) =>
    values.reduce((out, value, index) => (index ? out + delimiter(index - 1) : '') + value, '')
  if (parsed.flags.has('s')) ctx.stdout.write(joinLines(columns.map(join)))
  else {
    const height = Math.max(0, ...columns.map((column) => column.length))
    ctx.stdout.write(
      joinLines(
        Array.from({ length: height }, (_, row) =>
          join(columns.map((column) => column[row] ?? '')),
        ),
      ),
    )
  }
  return status
}

const xargs: CommandHandler = streaming(async (ctx) => {
  const args = ctx.args
  let i = 0
  let max: number | undefined
  let maxLines: number | undefined
  let replace: string | undefined
  let delimiter: string | undefined
  let skipEmpty = false
  let trace = false
  let file: string | undefined
  let eof: string | undefined
  const value = (arg: string, short: string, long: string): string | undefined => {
    if (arg === short || arg === long) return args[++i]
    if (arg.startsWith(long + '=')) return arg.slice(long.length + 1)
    if (arg.startsWith(short) && short.length === 2 && !arg.startsWith('--')) return arg.slice(2)
    return undefined
  }
  for (; i < args.length && args[i].startsWith('-') && args[i] !== '-'; i++) {
    const arg = args[i]
    if (arg === '--') {
      i++
      break
    }
    let v: string | undefined
    if (arg === '-0' || arg === '--null') delimiter = '\0'
    else if (arg === '-r' || arg === '--no-run-if-empty') skipEmpty = true
    else if (arg === '-t' || arg === '--verbose') trace = true
    else if (
      arg === '-x' ||
      arg === '--exit' ||
      arg === '-p' ||
      arg === '--interactive' ||
      arg === '--open-tty' ||
      arg === '-o'
    )
      continue
    else if (arg === '-i' || arg === '--replace') replace = '{}'
    else if (arg.startsWith('-i') || arg.startsWith('--replace='))
      replace = arg.startsWith('-i') ? arg.slice(2) : arg.slice(10)
    else if ((v = value(arg, '-I', '-I')) !== undefined) replace = v
    else if ((v = value(arg, '-n', '--max-args')) !== undefined) max = Number(v)
    else if ((v = value(arg, '-L', '--max-lines')) !== undefined) maxLines = Number(v)
    else if (arg === '-l') maxLines = 1
    else if ((v = value(arg, '-d', '--delimiter')) !== undefined) delimiter = escapes(v)[0]
    else if ((v = value(arg, '-a', '--arg-file')) !== undefined) file = v
    else if ((v = value(arg, '-E', '--eof')) !== undefined) eof = v
    else if (arg.startsWith('-e')) eof = arg.slice(2) || undefined
    else if (
      value(arg, '-P', '--max-procs') !== undefined ||
      value(arg, '-s', '--max-chars') !== undefined ||
      value(arg, '-S', '--process-slot-var') !== undefined
    )
      continue
    else throw new CommandError("invalid option -- '" + arg.slice(1) + "'", 1)
    if (max !== undefined && (!Number.isInteger(max) || max < 1))
      throw new CommandError('value ' + max + ' for -n option should be >= 1', 1)
  }
  const command = args.slice(i).length ? args.slice(i) : ['echo']
  let next: () => Promise<string | null>
  if (file !== undefined) {
    let input: string | null
    try {
      input = await readInput(ctx, file)
    } catch {
      throw new CommandError("Cannot open input file '" + file + "': No such file or directory", 1)
    }
    next = async () => {
      const text = input
      input = null
      return text
    }
  } else next = batches(ctx.stdin, delimiter ?? '\n')
  const unquote = (text: string): string[] => {
    const out: string[] = []
    for (const match of text.matchAll(/(?:"([^"]*)"|'([^']*)'|\\([\s\S])|([^\s"'\\]+))+|\s+/g)) {
      if (/^\s+$/.test(match[0])) continue
      out.push(
        match[0].replace(
          /"([^"]*)"|'([^']*)'|\\([\s\S])/g,
          (_, a: string | undefined, b: string | undefined, c: string | undefined) =>
            a ?? b ?? c ?? '',
        ),
      )
    }
    return out
  }
  let status = 0
  let ran = 0
  let stopped = false
  const execute = async (group: string[]): Promise<number | undefined> => {
    ran++
    const argv =
      replace !== undefined
        ? command.map((word) => word.split(replace!).join(group[0] ?? ''))
        : [...command, ...group]
    if (trace) ctx.stderr.write(argv.join(' ') + '\n')
    let code: number
    try {
      code = await ctx.run(argv, '')
    } catch (error) {
      if (!(error instanceof PipeError)) throw error
      code = 141
    }
    if (code === 141) {
      ctx.stderr.write('xargs: ' + argv[0] + ': terminated by signal 13\n')
      return 125
    }
    if (code === 255) {
      ctx.stderr.write('xargs: ' + argv[0] + ': exited with status 255; aborting\n')
      return 124
    }
    if (code === 127 || code === 126) return code
    if (code !== 0) status = 123
    return undefined
  }
  const base = command.reduce((sum, word) => sum + word.length + 1, 0)
  let pending: string[] = []
  let length = base
  let current: string[] = []
  let count = 0
  let text = await next()
  while (text !== null && !stopped) {
    const following = await next()
    const final = following === null
    const groups: string[][] = []
    if (replace !== undefined) {
      const items =
        delimiter !== undefined
          ? text.split(delimiter)
          : text.split('\n').map((line) => line.replace(/^[ \t]+/, ''))
      if (items[items.length - 1] === '') items.pop()
      for (const item of items) {
        if (delimiter === undefined && item === '') continue
        if (eof !== undefined && item === eof) {
          stopped = true
          break
        }
        groups.push([item])
      }
    } else if (maxLines !== undefined && delimiter === undefined) {
      const parts = text.split('\n')
      if (parts[parts.length - 1] === '' && parts.length > 1) parts.pop()
      for (const line of parts) {
        const words = unquote(line)
        if (eof !== undefined && words[0] === eof) {
          stopped = true
          break
        }
        if (!words.length) continue
        for (const word of words) current.push(word)
        if (/[ \t]$/.test(line)) continue
        if (++count >= maxLines) {
          groups.push(current)
          current = []
          count = 0
        }
      }
    } else {
      let items: string[]
      if (delimiter !== undefined) {
        items = text.split(delimiter)
        if (
          items[items.length - 1] === '' ||
          (final && delimiter !== '\n' && items[items.length - 1] === '\n' && delimiter !== '\0')
        )
          items.pop()
      } else items = unquote(text)
      if (eof !== undefined && delimiter === undefined) {
        const stop = items.indexOf(eof)
        if (stop >= 0) {
          items = items.slice(0, stop)
          stopped = true
        }
      }
      const size = max ?? maxLines
      for (const item of items) {
        if (size === undefined && pending.length && length + item.length + 1 > 131072) {
          groups.push(pending)
          pending = []
          length = base
        }
        pending.push(item)
        length += item.length + 1
        if (size !== undefined && pending.length >= Math.max(1, size)) {
          groups.push(pending)
          pending = []
        }
      }
    }
    for (const group of groups) {
      const code = await execute(group)
      if (code !== undefined) return code
    }
    text = following
  }
  const rest = current.length ? current : pending
  if (rest.length) {
    const code = await execute(rest)
    if (code !== undefined) return code
  }
  if (!ran) {
    if (skipEmpty || replace !== undefined) return 0
    const code = await execute([])
    if (code !== undefined) return code
  }
  return status
})

const STRFTIME_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const STRFTIME_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export function strftime(spec: string, date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const start = Date.UTC(date.getUTCFullYear(), 0, 1)
  const day = Math.floor((date.getTime() - start) / 86400000) + 1
  return spec.replace(/%([-_0]?)([a-zA-Z%+])/g, (whole, pad: string, c: string) => {
    let value: string
    switch (c) {
      case 'Y':
        value = String(date.getUTCFullYear())
        break
      case 'y':
        value = two(date.getUTCFullYear() % 100)
        break
      case 'C':
        value = two(Math.floor(date.getUTCFullYear() / 100))
        break
      case 'm':
        value = two(date.getUTCMonth() + 1)
        break
      case 'd':
        value = two(date.getUTCDate())
        break
      case 'e':
        value = String(date.getUTCDate()).padStart(2, ' ')
        break
      case 'H':
        value = two(date.getUTCHours())
        break
      case 'k':
        value = String(date.getUTCHours()).padStart(2, ' ')
        break
      case 'I':
        value = two(date.getUTCHours() % 12 || 12)
        break
      case 'l':
        value = String(date.getUTCHours() % 12 || 12).padStart(2, ' ')
        break
      case 'M':
        value = two(date.getUTCMinutes())
        break
      case 'S':
        value = two(date.getUTCSeconds())
        break
      case 'N':
        value = String(date.getUTCMilliseconds() * 1000000).padStart(9, '0')
        break
      case 's':
        value = String(Math.floor(date.getTime() / 1000))
        break
      case 'p':
        value = date.getUTCHours() < 12 ? 'AM' : 'PM'
        break
      case 'P':
        value = date.getUTCHours() < 12 ? 'am' : 'pm'
        break
      case 'a':
        value = STRFTIME_DAYS[date.getUTCDay()].slice(0, 3)
        break
      case 'A':
        value = STRFTIME_DAYS[date.getUTCDay()]
        break
      case 'b':
      case 'h':
        value = STRFTIME_MONTHS[date.getUTCMonth()].slice(0, 3)
        break
      case 'B':
        value = STRFTIME_MONTHS[date.getUTCMonth()]
        break
      case 'j':
        value = String(day).padStart(3, '0')
        break
      case 'u':
        value = String(date.getUTCDay() || 7)
        break
      case 'w':
        value = String(date.getUTCDay())
        break
      case 'U':
        value = two(Math.floor((day - 1 + 7 - date.getUTCDay()) / 7))
        break
      case 'W':
        value = two(Math.floor((day - 1 + 7 - ((date.getUTCDay() + 6) % 7)) / 7))
        break
      case 'V':
      case 'G':
      case 'g': {
        const target = new Date(
          Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
        )
        target.setUTCDate(target.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7))
        const year = target.getUTCFullYear()
        const week = Math.ceil(((target.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7)
        value = c === 'V' ? two(week) : c === 'G' ? String(year) : two(year % 100)
        break
      }
      case 'Z':
        value = 'UTC'
        break
      case 'z':
        value = '+0000'
        break
      case 'F':
        value = strftime('%Y-%m-%d', date)
        break
      case 'T':
        value = strftime('%H:%M:%S', date)
        break
      case 'R':
        value = strftime('%H:%M', date)
        break
      case 'D':
        value = strftime('%m/%d/%y', date)
        break
      case 'c':
        value = strftime('%a %b %e %H:%M:%S %Y', date)
        break
      case 'x':
        value = strftime('%m/%d/%y', date)
        break
      case 'X':
        value = strftime('%H:%M:%S', date)
        break
      case 'n':
        value = '\n'
        break
      case 't':
        value = '\t'
        break
      case '%':
        value = '%'
        break
      case '+':
        value = strftime('%a %b %e %H:%M:%S %Z %Y', date)
        break
      default:
        return whole
    }
    if (pad === '-') value = value.replace(/^[0 ]+(?=.)/, '')
    else if (pad === '_') value = value.replace(/^0+(?=.)/, (match) => ' '.repeat(match.length))
    return value
  })
}

const UNITS: Record<string, number> = {
  second: 1000,
  sec: 1000,
  minute: 60000,
  min: 60000,
  hour: 3600000,
  day: 86400000,
  week: 604800000,
  fortnight: 1209600000,
}

function absolute(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === 'now' || trimmed === 'today')
    return trimmed === 'today' ? Date.now() : Date.now()
  if (trimmed === 'yesterday') return Date.now() - 86400000
  if (trimmed === 'tomorrow') return Date.now() + 86400000
  if (/^@-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed.slice(1)) * 1000
  const iso = trimmed.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i,
  )
  if (iso) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', fraction = '', zone = ''] = iso
    let ms = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
      Math.round(Number(fraction || 0) * 1000),
    )
    const offset = zone.match(/^([+-])(\d{2}):?(\d{2})$/)
    if (offset)
      ms -= (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60000
    return ms
  }
  const time = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (time) {
    const now = new Date()
    return Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      Number(time[1]),
      Number(time[2]),
      Number(time[3] ?? 0),
    )
  }
  const parsed = Date.parse(
    /[a-z]{3}/i.test(trimmed) && !/(Z|GMT|UTC|[+-]\d{4})$/i.test(trimmed)
      ? trimmed + ' UTC'
      : trimmed,
  )
  return Number.isNaN(parsed) ? undefined : parsed
}

export function parseDate(input: string): number | undefined {
  let rest = input.trim()
  const shifts: [number, string][] = []
  for (;;) {
    const match = rest.match(
      /(?:^|\s+)([+-]?\s*\d+)?\s*(second|sec|minute|min|hour|day|week|fortnight|month|year)s?(\s+ago)?$/i,
    )
    if (!match) break
    const amount =
      (match[1] === undefined ? 1 : Number(match[1].replace(/\s+/g, ''))) * (match[3] ? -1 : 1)
    shifts.unshift([amount, match[2]!.toLowerCase()])
    rest = rest.slice(0, rest.length - match[0].length).trim()
    if (!rest) break
  }
  const relativeDay = rest.match(/^(next|last)\s+(second|minute|hour|day|week|month|year)$/i)
  if (relativeDay) {
    shifts.unshift([
      relativeDay[1]!.toLowerCase() === 'next' ? 1 : -1,
      relativeDay[2]!.toLowerCase(),
    ])
    rest = ''
  }
  const start = absolute(rest)
  if (start === undefined) return undefined
  const date = new Date(start)
  for (const [amount, unit] of shifts) {
    if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + amount)
    else if (unit === 'year') date.setUTCFullYear(date.getUTCFullYear() + amount)
    else date.setTime(date.getTime() + amount * UNITS[unit]!)
  }
  return date.getTime()
}

const date: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'uRI',
    values: 'dr',
    long: {
      utc: 'u',
      universal: 'u',
      date: 'd',
      'rfc-email': 'R',
      'iso-8601': 'iso',
      reference: 'r',
    },
  })
  let when = new Date()
  const reference = last(parsed, 'r')
  if (reference !== undefined) {
    const stat = await ctx.fs.stat(ctx.resolve(reference))
    if (!stat) throw new CommandError(reference + ': No such file or directory')
    when = new Date(stat.mtime)
  }
  const input = last(parsed, 'd')
  if (input !== undefined) {
    const parsedDate = parseDate(input)
    if (parsedDate === undefined) throw new CommandError("invalid date '" + input + "'")
    when = new Date(parsedDate)
  }
  const spec = parsed.operands.find((operand) => operand.startsWith('+'))
  if (spec) ctx.stdout.write(strftime(spec.slice(1), when) + '\n')
  else if (parsed.flags.has('R'))
    ctx.stdout.write(strftime('%a, %d %b %Y %H:%M:%S +0000', when) + '\n')
  else if (parsed.flags.has('I') || parsed.values.has('iso')) {
    const precision = last(parsed, 'iso')
    ctx.stdout.write(
      (precision && precision !== 'date'
        ? when.toISOString().replace(/\.\d+Z$/, '+00:00')
        : strftime('%F', when)) + '\n',
    )
  } else ctx.stdout.write(strftime('%a %b %e %H:%M:%S %Z %Y', when) + '\n')
  return 0
}

const sleep: CommandHandler = async (ctx) => {
  if (!ctx.args.length) throw new CommandError('missing operand')
  let total = 0
  for (const arg of ctx.args) {
    const match = arg.match(/^(\d*\.?\d+)([smhd]?)$/)
    if (!match) throw new CommandError("invalid time interval '" + arg + "'")
    total += Number(match[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]]! * 1000
  }
  await ctx.sleep(total)
  return 0
}

const base64: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'di',
    values: 'w',
    long: { decode: 'd', 'ignore-garbage': 'i', wrap: 'w' },
  })
  const operand = parsed.operands[0] ?? '-'
  const bytes = operand === '-' ? encode(ctx.stdin.read()) : await ctx.fs.read(ctx.resolve(operand))
  if (parsed.flags.has('d')) {
    const raw = decode(bytes)
    const text = (
      parsed.flags.has('i')
        ? raw.replace(/[^A-Za-z0-9+/=_-]/g, '')
        : raw.replaceAll('\r', '').replaceAll('\n', '')
    )
      .replaceAll('-', '+')
      .replaceAll('_', '/')
    const bad = text.search(/[^A-Za-z0-9+/=]/)
    const valid = bad < 0 ? text : text.slice(0, bad)
    const padding = valid.indexOf('=')
    const body = padding < 0 ? valid : valid.slice(0, padding)
    const whole = body.length - (body.length % 4)
    const partial = body.length % 4 >= 2 ? body.slice(whole) : ''
    let decoded: Uint8Array
    try {
      decoded = fromBase64(body.slice(0, whole) + (partial ? partial.padEnd(4, '=') : ''))
    } catch {
      decoded = new Uint8Array(0)
    }
    ctx.stdout.write(decode(decoded))
    const trailing = padding < 0 ? '' : valid.slice(padding)
    const complete =
      bad < 0 && body.length % 4 === 0
        ? trailing === ''
        : bad < 0 &&
          ((body.length % 4 === 2 && /^==$/.test(trailing)) ||
            (body.length % 4 === 3 && trailing === '=') ||
            (trailing === '' && body.length % 4 === 0))
    if (!complete) throw new CommandError('invalid input')
    return 0
  }
  budget(ctx.limits, 4 * bytes.length, 'base64: its input')
  const encoded = toBase64(bytes)
  const wrap = Number(last(parsed, 'w') ?? 76)
  if (!(wrap > 0)) {
    await put(ctx, encoded + '\n')
    return 0
  }
  let out = ''
  for (let start = 0; start < encoded.length; start += wrap) {
    out += encoded.slice(start, start + wrap) + '\n'
    if (out.length < 1 << 16) continue
    await put(ctx, out)
    out = ''
  }
  await put(ctx, encoded.length ? out : '\n')
  return 0
}

function digest(algorithm: string): CommandHandler {
  return checksum(
    async (bytes) =>
      [...new Uint8Array(await crypto.subtle.digest(algorithm, bytes as Uint8Array<ArrayBuffer>))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    algorithm.replace('-', ''),
  )
}

export function checksum(
  hash: (bytes: Uint8Array) => Promise<string> | string,
  tag: string,
): CommandHandler {
  return async (ctx) => {
    const parsed = options(ctx.args, {
      flags: 'bctwz',
      long: {
        binary: 'b',
        check: 'c',
        text: 't',
        tag: 'T',
        warn: 'w',
        quiet: 'q',
        status: 's',
        strict: 'S',
        'ignore-missing': 'i',
        zero: 'z',
      },
    })
    const f = parsed.flags
    const read = async (operand: string): Promise<Uint8Array> =>
      operand === '-' ? encode(ctx.stdin.read()) : await ctx.fs.read(ctx.resolve(operand))
    let status = 0
    if (!f.has('c')) {
      for (const operand of parsed.operands.length ? parsed.operands : ['-']) {
        let bytes: Uint8Array
        try {
          bytes = await read(operand)
        } catch (error) {
          ctx.stderr.write(
            ctx.name +
              ': ' +
              operand +
              ': ' +
              (error instanceof FsError && error.code === 'EISDIR'
                ? 'Is a directory'
                : 'No such file or directory') +
              '\n',
          )
          status = 1
          continue
        }
        const value = await hash(bytes)
        ctx.stdout.write(
          (f.has('T')
            ? tag + ' (' + operand + ') = ' + value
            : value + (f.has('b') ? ' *' : '  ') + operand) + (f.has('z') ? '\0' : '\n'),
        )
      }
      return status
    }
    let failed = 0
    let unreadable = 0
    let malformed = 0
    for (const operand of parsed.operands.length ? parsed.operands : ['-']) {
      let text: string
      try {
        text = await readInput(ctx, operand)
      } catch {
        ctx.stderr.write(ctx.name + ': ' + operand + ': No such file or directory\n')
        status = 1
        continue
      }
      let valid = 0
      for (const line of lines(text)) {
        const match =
          line.match(/^\\?([0-9a-fA-F]+) [ *](.+)$/) ??
          line.match(/^\w+ \((.+)\) = ([0-9a-fA-F]+)$/)
        if (!match) {
          if (line.trim() !== '' && !line.startsWith('#')) malformed++
          continue
        }
        valid++
        const [expected, name] =
          line.startsWith(tag + ' (') || /^\w+ \(/.test(line)
            ? [match[2]!, match[1]!]
            : [match[1]!, match[2]!]
        let bytes: Uint8Array
        try {
          bytes = await read(name)
        } catch {
          if (f.has('i')) continue
          ctx.stderr.write(ctx.name + ': ' + name + ': No such file or directory\n')
          if (!f.has('s')) ctx.stdout.write(name + ': FAILED open or read\n')
          unreadable++
          continue
        }
        const ok = (await hash(bytes)) === expected.toLowerCase()
        if (!ok) failed++
        if (!f.has('s') && (!ok || !f.has('q')))
          ctx.stdout.write(name + ': ' + (ok ? 'OK' : 'FAILED') + '\n')
      }
      if (!valid) {
        ctx.stderr.write(
          ctx.name +
            ': ' +
            (operand === '-' ? 'standard input' : operand) +
            ': no properly formatted checksum lines found\n',
        )
        status = 1
      }
    }
    if (!f.has('s')) {
      if (malformed && f.has('w'))
        ctx.stderr.write(
          ctx.name +
            ': WARNING: ' +
            malformed +
            ' line' +
            (malformed === 1 ? ' is' : 's are') +
            ' improperly formatted\n',
        )
      if (unreadable)
        ctx.stderr.write(
          ctx.name +
            ': WARNING: ' +
            unreadable +
            ' listed file' +
            (unreadable === 1 ? '' : 's') +
            ' could not be read\n',
        )
      if (failed)
        ctx.stderr.write(
          ctx.name +
            ': WARNING: ' +
            failed +
            ' computed checksum' +
            (failed === 1 ? '' : 's') +
            ' did NOT match\n',
        )
    }
    return failed || unreadable || (malformed && f.has('S')) ? 1 : status
  }
}

const expr: CommandHandler = (ctx) => {
  const tokens = ctx.args
  let pos = 0
  const isNumber = (value: string) => /^-?\d+$/.test(value)
  const primary = (): string => {
    const token = tokens[pos++]
    if (token === undefined) throw new CommandError('syntax error: missing argument', 2)
    if (token === '(') {
      const value = or()
      pos++
      return value
    }
    if (token === 'length') return String(primary().length)
    if (token === 'substr') {
      const text = primary()
      const start = Number(primary())
      const length = Number(primary())
      return text.substr(start - 1, length)
    }
    if (token === 'index') {
      const text = primary()
      const chars = primary()
      const index = [...text].findIndex((c) => chars.includes(c))
      return String(index + 1)
    }
    if (token === 'match') {
      const text = primary()
      return match(text, primary())
    }
    return token
  }
  const match = (text: string, pattern: string): string => {
    const result = text.match(posixRegExp('^' + pattern.replace(/^\^/, ''), false))
    if (!result) return /\\\(/.test(pattern) ? '' : '0'
    return result[1] ?? String(result[0].length)
  }
  const colon = (): string => {
    let value = primary()
    while (tokens[pos] === ':') {
      pos++
      value = match(value, primary())
    }
    return value
  }
  const mul = (): string => {
    let value = colon()
    while (['*', '/', '%'].includes(tokens[pos])) {
      const op = tokens[pos++]
      const right = colon()
      if (!isNumber(value) || !isNumber(right)) throw new CommandError('non-integer argument', 2)
      if (op !== '*' && Number(right) === 0) throw new CommandError('division by zero', 2)
      value = String(
        op === '*'
          ? Number(value) * Number(right)
          : op === '/'
            ? Math.trunc(Number(value) / Number(right))
            : Number(value) % Number(right),
      )
    }
    return value
  }
  const add = (): string => {
    let value = mul()
    while (tokens[pos] === '+' || tokens[pos] === '-') {
      const op = tokens[pos++]
      const right = mul()
      if (!isNumber(value) || !isNumber(right)) throw new CommandError('non-integer argument', 2)
      value = String(op === '+' ? Number(value) + Number(right) : Number(value) - Number(right))
    }
    return value
  }
  const cmp = (): string => {
    let value = add()
    while (['=', '==', '!=', '<', '<=', '>', '>='].includes(tokens[pos])) {
      const op = tokens[pos++]
      const right = add()
      const numeric = isNumber(value) && isNumber(right)
      const a: number | string = numeric ? Number(value) : value
      const b: number | string = numeric ? Number(right) : right
      const result =
        op === '=' || op === '=='
          ? a === b
          : op === '!='
            ? a !== b
            : op === '<'
              ? a < b
              : op === '<='
                ? a <= b
                : op === '>'
                  ? a > b
                  : a >= b
      value = result ? '1' : '0'
    }
    return value
  }
  const and = (): string => {
    let value = cmp()
    while (tokens[pos] === '&') {
      pos++
      const right = cmp()
      value = value !== '' && value !== '0' && right !== '' && right !== '0' ? value : '0'
    }
    return value
  }
  const or = (): string => {
    let value = and()
    while (tokens[pos] === '|') {
      pos++
      const right = and()
      value = value !== '' && value !== '0' ? value : right !== '' && right !== '0' ? right : '0'
    }
    return value
  }
  const value = or()
  ctx.stdout.write(value + '\n')
  return value === '' || value === '0' ? 1 : 0
}

const fold: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'sb',
    values: 'w',
    numeric: true,
    long: { width: 'w', spaces: 's' },
  })
  const width = Number(last(parsed, 'w') ?? last(parsed, 'n') ?? 80)
  const { text, status } = await allInput(ctx, parsed.operands)
  const out = text.split('\n').map((line) => {
    const parts: string[] = []
    let rest = line
    while (rest.length > width) {
      let cut = width
      if (parsed.flags.has('s')) {
        const space = rest.lastIndexOf(' ', width - 1)
        if (space > 0) cut = space + 1
      }
      parts.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    parts.push(rest)
    return parts.join('\n')
  })
  ctx.stdout.write(out.join('\n'))
  return status
}

const column: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'tnxeL',
    values: 'soc',
    long: {
      table: 't',
      separator: 's',
      'output-separator': 'o',
      fillrows: 'x',
      'output-width': 'c',
    },
  })
  const { text, status } = await allInput(ctx, parsed.operands)
  const rows = lines(text)
  if (!parsed.flags.has('t')) {
    const entries = rows.filter((row) => row !== '')
    if (!entries.length) return status
    const width = Number(last(parsed, 'c') ?? ctx.env['COLUMNS'] ?? 80)
    const longest = Math.max(...entries.map((entry) => [...entry].length))
    const column = (longest + 8) & ~7
    const columns = Math.max(1, Math.floor(width / column))
    const height = Math.ceil(entries.length / columns)
    const across = parsed.flags.has('x')
    let out = ''
    for (let row = 0; row < height; row++) {
      const cells: string[] = []
      for (let col = 0; col < columns; col++) {
        const index = across ? row * columns + col : col * height + row
        if (index < entries.length && (across ? col < columns : true)) cells.push(entries[index]!)
      }
      cells.forEach((cell, index) => {
        out += cell
        if (index === cells.length - 1) return
        let count = [...cell].length
        while (count < column) {
          out += '\t'
          count = (count + 8) & ~7
        }
      })
      out += '\n'
    }
    ctx.stdout.write(out)
    return status
  }
  const separator = last(parsed, 's')
  const cells = rows
    .filter((row) => row.trim() !== '')
    .map((row) =>
      separator
        ? row.split(new RegExp('[' + separator.replace(/[\]\\^-]/g, '\\$&') + ']'))
        : row.trim().split(/\s+/),
    )
  const widths: number[] = []
  for (const row of cells)
    row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)))
  const gap = last(parsed, 'o') ?? '  '
  ctx.stdout.write(
    joinLines(
      cells.map((row) =>
        row
          .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index])))
          .join(gap),
      ),
    ),
  )
  return status
}

type Edit = { op: ' ' | '-' | '+'; a: number; b: number }

function myers(a: string[], b: string[]): Edit[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const x0 = a.slice(head, a.length - tail)
  const y0 = b.slice(head, b.length - tail)
  const n = x0.length
  const m = y0.length
  const max = n + m
  const middle: Edit[] = []
  if (n === 0 || m === 0) {
    for (let i = 0; i < n; i++) middle.push({ op: '-', a: head + i, b: head })
    for (let j = 0; j < m; j++) middle.push({ op: '+', a: head + n, b: head + j })
  } else {
    const offset = max + 1
    const v = new Int32Array(2 * max + 3)
    const trace: Int32Array[] = []
    let budget = 0
    let done = false
    for (let d = 0; d <= max && !done; d++) {
      budget += 2 * d + 1
      if (budget > 40_000_000) throw new CommandError('inputs too large to compare', 2)
      trace.push(v.slice(offset - d, offset + d + 1))
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
            ? v[offset + k + 1]!
            : v[offset + k - 1]! + 1
        let y = x - k
        while (x < n && y < m && x0[x] === y0[y]) {
          x++
          y++
        }
        v[offset + k] = x
        if (x >= n && y >= m) {
          done = true
          break
        }
      }
    }
    let x = n
    let y = m
    const reversed: Edit[] = []
    for (let d = trace.length - 1; d > 0; d--) {
      const row = trace[d]!
      const at = (k: number) => row[k + d]!
      const k = x - y
      const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
      const prevK = down ? k + 1 : k - 1
      const prevX = at(prevK)
      const prevY = prevX - prevK
      while (x > prevX && y > prevY) {
        reversed.push({ op: ' ', a: head + x - 1, b: head + y - 1 })
        x--
        y--
      }
      if (down) reversed.push({ op: '+', a: head + x, b: head + y - 1 })
      else reversed.push({ op: '-', a: head + x - 1, b: head + y })
      x = prevX
      y = prevY
    }
    while (x > 0 && y > 0) {
      reversed.push({ op: ' ', a: head + x - 1, b: head + y - 1 })
      x--
      y--
    }
    for (const item of reversed.reverse()) middle.push(item)
  }
  const out: Edit[] = []
  for (let i = 0; i < head; i++) out.push({ op: ' ', a: i, b: i })
  for (let i = 0; i < middle.length; ) {
    if (middle[i]!.op === ' ') {
      out.push(middle[i++]!)
      continue
    }
    const block: Edit[] = []
    while (i < middle.length && middle[i]!.op !== ' ') block.push(middle[i++]!)
    out.push(...block.filter((edit) => edit.op === '-'), ...block.filter((edit) => edit.op === '+'))
  }
  for (let i = 0; i < tail; i++)
    out.push({ op: ' ', a: a.length - tail + i, b: b.length - tail + i })
  return out
}

function stamp(mtime: number): string {
  const date = new Date(mtime)
  const two = (n: number) => String(n).padStart(2, '0')
  return (
    date.getUTCFullYear() +
    '-' +
    two(date.getUTCMonth() + 1) +
    '-' +
    two(date.getUTCDate()) +
    ' ' +
    two(date.getUTCHours()) +
    ':' +
    two(date.getUTCMinutes()) +
    ':' +
    two(date.getUTCSeconds()) +
    '.' +
    String(date.getUTCMilliseconds()).padStart(3, '0') +
    '000000 +0000'
  )
}

const NO_NEWLINE = '\\ No newline at end of file'

const diff: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'uqiwbBNrsatTpdEcyYl',
    values: 'UxXLCW',
    long: {
      'side-by-side': 'y',
      'suppress-common-lines': 'Y',
      'left-column': 'l',
      width: 'W',
      context: 'c',
      unified: 'U',
      brief: 'q',
      'ignore-case': 'i',
      'ignore-all-space': 'w',
      'ignore-space-change': 'b',
      'ignore-blank-lines': 'B',
      'new-file': 'N',
      recursive: 'r',
      'report-identical-files': 's',
      text: 'a',
      exclude: 'x',
      'exclude-from': 'X',
      label: 'L',
      'strip-trailing-cr': 'Z',
      'ignore-tab-expansion': 'E',
      'show-c-function': 'p',
      minimal: 'd',
      'expand-tabs': 't',
      color: '',
      'no-dereference': '',
      'speed-large-files': '',
    },
  })
  const f = parsed.flags
  const [left, right] = parsed.operands
  if (left === undefined || right === undefined)
    throw new CommandError(
      left === undefined ? "missing operand after 'diff'" : "missing operand after '" + left + "'",
      2,
    )
  if (parsed.operands.length > 2)
    throw new CommandError("extra operand '" + parsed.operands[2] + "'", 2)
  const unified = f.has('u') || parsed.values.has('U')
  const context = !unified && (f.has('c') || parsed.values.has('C'))
  const sideBySide = f.has('y')
  const contextLines = Number(last(parsed, 'U') ?? last(parsed, 'C') ?? 3)
  const labels = parsed.values.get('L') ?? []
  const switches = ctx.args
    .filter((arg) => arg.startsWith('-') && arg !== '-' && arg !== '--')
    .join(' ')
  const excludes = (parsed.values.get('x') ?? []).map((glob) => globRegExp(glob))
  let status = 0
  const trouble = (message: string) => {
    ctx.stderr.write('diff: ' + message + '\n')
    status = 2
  }
  const normal = (line: string) => {
    let value = line
    if (f.has('Z')) value = value.replace(/\r$/, '')
    if (f.has('i')) value = value.toLowerCase()
    if (f.has('w')) value = value.replace(/\s+/g, '')
    else if (f.has('b')) value = value.replace(/\s+/g, ' ').replace(/ $/, '')
    return value
  }
  const split = (text: string): string[] => {
    const all = lines(text)
    if (text !== '' && !text.endsWith('\n')) all[all.length - 1] += '\u0000'
    return all
  }
  const show = (line: string) =>
    line.endsWith('\u0000') ? line.slice(0, -1) + '\n' + NO_NEWLINE : line
  const compare = async (
    a: { name: string; text: string; mtime: number },
    b: { name: string; text: string; mtime: number },
    header: boolean,
  ): Promise<void> => {
    if (a.text === b.text && !sideBySide) {
      if (f.has('s')) ctx.stdout.write('Files ' + a.name + ' and ' + b.name + ' are identical\n')
      return
    }
    if (!f.has('a') && (a.text.includes('\0') || b.text.includes('\0'))) {
      ctx.stdout.write(
        (f.has('q') ? 'Files ' : 'Binary files ') + a.name + ' and ' + b.name + ' differ\n',
      )
      status = Math.max(status, 1)
      return
    }
    const x = split(a.text)
    const y = split(b.text)
    const edits = myers(x.map(normal), y.map(normal))
    const same = edits.every((edit) => edit.op === ' ')
    if (same && !sideBySide) return
    if (f.has('B')) {
      const changed = edits.filter((edit) => edit.op !== ' ')
      if (
        changed.every(
          (edit) => (edit.op === '-' ? x[edit.a] : y[edit.b])!.replace(/\u0000$/, '').trim() === '',
        )
      )
        return
    }
    if (!same) status = Math.max(status, 1)
    if (f.has('q')) {
      ctx.stdout.write('Files ' + a.name + ' and ' + b.name + ' differ\n')
      return
    }
    if (header)
      ctx.stdout.write('diff ' + (switches ? switches + ' ' : '') + a.name + ' ' + b.name + '\n')
    const line = (edit: Edit) => show(edit.op === '+' ? y[edit.b]! : x[edit.a]!)
    if (sideBySide) {
      const width = Number(last(parsed, 'W') ?? 130)
      const offset = Math.floor((width + 8 + 3) / 16) * 8
      const half = Math.max(0, Math.min(offset - 3, width - offset))
      const column = half ? offset : width
      const pad = (from: number, to: number) => {
        let text = ''
        let at = from
        while (at + 8 - (at % 8) <= to) {
          text += '\t'
          at += 8 - (at % 8)
        }
        return text + ' '.repeat(Math.max(0, to - at))
      }
      const clip = (text: string, size: number) => {
        let out = ''
        let at = 0
        for (const c of text.replace(/\u0000$/, '')) {
          const next = c === '\t' ? at + 8 - (at % 8) : at + 1
          if (next > size) break
          out += c
          at = next
        }
        return { text: out, at }
      }
      const row = (left: string | undefined, separator: string, right: string | undefined) => {
        const l = clip(left ?? '', half)
        if (separator === ' ') {
          if (right === undefined || (f.has('l') && left !== undefined))
            return l.text + (f.has('l') ? pad(l.at, half + 1) + '(' : '') + '\n'
          return l.text + pad(l.at, column) + clip(right, width - column).text + '\n'
        }
        let text = l.text + pad(l.at, half + 1) + separator
        if (right !== undefined) text += pad(half + 2, column) + clip(right, width - column).text
        return text + '\n'
      }
      let i = 0
      while (i < edits.length) {
        const edit = edits[i]!
        if (edit.op === ' ') {
          if (!f.has('Y')) ctx.stdout.write(row(x[edit.a], ' ', y[edit.b]))
          i++
          continue
        }
        let end = i
        while (end < edits.length && edits[end]!.op !== ' ') end++
        const removed = edits.slice(i, end).filter((item) => item.op === '-')
        const added = edits.slice(i, end).filter((item) => item.op === '+')
        for (let k = 0; k < Math.max(removed.length, added.length); k++) {
          const left = removed[k]
          const right = added[k]
          ctx.stdout.write(
            row(
              left ? x[left.a] : undefined,
              left && right ? '|' : left ? '<' : '>',
              right ? y[right.b] : undefined,
            ),
          )
        }
        i = end
      }
      return
    }
    if (context) {
      ctx.stdout.write(
        '*** ' +
          (labels[0] ?? a.name + '\t' + stamp(a.mtime)) +
          '\n--- ' +
          (labels[1] ?? b.name + '\t' + stamp(b.mtime)) +
          '\n',
      )
      let i = 0
      while (i < edits.length) {
        if (edits[i]!.op === ' ') {
          i++
          continue
        }
        const start = Math.max(0, i - contextLines)
        let end = i
        while (end < edits.length) {
          if (edits[end]!.op !== ' ') {
            end++
            continue
          }
          let run = end
          while (run < edits.length && edits[run]!.op === ' ') run++
          if (run - end > contextLines * 2 || run === edits.length) {
            end = Math.min(edits.length, end + contextLines)
            break
          }
          end = run
        }
        const hunk = edits.slice(start, end)
        const marks = new Map<Edit, string>()
        for (let k = 0; k < hunk.length; ) {
          if (hunk[k]!.op === ' ') {
            k++
            continue
          }
          let stop = k
          while (stop < hunk.length && hunk[stop]!.op !== ' ') stop++
          const block = hunk.slice(k, stop)
          const changed =
            block.some((item) => item.op === '-') && block.some((item) => item.op === '+')
          for (const item of block) marks.set(item, changed ? '! ' : item.op === '-' ? '- ' : '+ ')
          k = stop
        }
        const olds = hunk.filter((edit) => edit.op !== '+')
        const news = hunk.filter((edit) => edit.op !== '-')
        const range = (items: Edit[], key: 'a' | 'b') => {
          if (!items.length) return String(hunk[0]![key])
          const first = items[0]![key] + 1
          const lastLine = items[items.length - 1]![key] + 1
          return first === lastLine ? String(first) : first + ',' + lastLine
        }
        ctx.stdout.write('***************\n*** ' + range(olds, 'a') + ' ****\n')
        if (olds.some((edit) => edit.op === '-'))
          for (const edit of olds) ctx.stdout.write((marks.get(edit) ?? '  ') + line(edit) + '\n')
        ctx.stdout.write('--- ' + range(news, 'b') + ' ----\n')
        if (news.some((edit) => edit.op === '+'))
          for (const edit of news) ctx.stdout.write((marks.get(edit) ?? '  ') + line(edit) + '\n')
        i = end
      }
      return
    }
    if (unified) {
      ctx.stdout.write(
        '--- ' +
          (labels[0] ?? a.name + '\t' + stamp(a.mtime)) +
          '\n+++ ' +
          (labels[1] ?? b.name + '\t' + stamp(b.mtime)) +
          '\n',
      )
      let i = 0
      while (i < edits.length) {
        if (edits[i]!.op === ' ') {
          i++
          continue
        }
        const start = Math.max(0, i - contextLines)
        let end = i
        while (end < edits.length) {
          if (edits[end]!.op !== ' ') {
            end++
            continue
          }
          let run = end
          while (run < edits.length && edits[run]!.op === ' ') run++
          if (run - end > contextLines * 2 || run === edits.length) {
            end = Math.min(edits.length, end + contextLines)
            break
          }
          end = run
        }
        const hunk = edits.slice(start, end)
        const aCount = hunk.filter((edit) => edit.op !== '+').length
        const bCount = hunk.filter((edit) => edit.op !== '-').length
        const firstA = hunk.find((edit) => edit.op !== '+')?.a ?? hunk[0]!.a
        const firstB = hunk.find((edit) => edit.op !== '-')?.b ?? hunk[0]!.b
        const range = (first: number, count: number) =>
          count === 1 ? String(first + 1) : (count ? first + 1 : first) + ',' + count
        ctx.stdout.write('@@ -' + range(firstA, aCount) + ' +' + range(firstB, bCount) + ' @@\n')
        for (const edit of hunk) ctx.stdout.write(edit.op + line(edit) + '\n')
        i = end
      }
      return
    }
    let i = 0
    while (i < edits.length) {
      if (edits[i]!.op === ' ') {
        i++
        continue
      }
      let end = i
      while (end < edits.length && edits[end]!.op !== ' ') end++
      const block = edits.slice(i, end)
      const removed = block.filter((edit) => edit.op === '-')
      const added = block.filter((edit) => edit.op === '+')
      const range = (from: number, count: number) =>
        count > 1 ? from + 1 + ',' + (from + count) : String(from + (count ? 1 : 0))
      const kind = removed.length && added.length ? 'c' : removed.length ? 'd' : 'a'
      const aFrom = removed.length ? removed[0]!.a : block[0]!.a
      const bFrom = added.length ? added[0]!.b : block[0]!.b
      ctx.stdout.write(range(aFrom, removed.length) + kind + range(bFrom, added.length) + '\n')
      for (const edit of removed) ctx.stdout.write('< ' + line(edit) + '\n')
      if (kind === 'c') ctx.stdout.write('---\n')
      for (const edit of added) ctx.stdout.write('> ' + line(edit) + '\n')
      i = end
    }
  }
  const load = async (
    name: string,
    path: string,
  ): Promise<{ name: string; text: string; mtime: number } | undefined> => {
    if (name === '-') return { name, text: ctx.stdin.read(), mtime: Date.now() }
    const special = device(path)
    const stat = await ctx.fs.stat(path)
    if (!stat && special !== undefined)
      return { name, text: special === '' ? '' : special, mtime: 0 }
    if (!stat) return undefined
    return { name, text: decode(await ctx.fs.read(path)), mtime: stat.mtime }
  }
  const join = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : dir + '/' + name)
  const walk = async (a: string, b: string, aPath: string, bPath: string): Promise<void> => {
    const names = [
      ...new Set([...(await ctx.fs.list(aPath)), ...(await ctx.fs.list(bPath))]),
    ].sort()
    for (const name of names) {
      if (excludes.some((glob) => glob.test(name))) continue
      const aChild = join(aPath, name)
      const bChild = join(bPath, name)
      const aStat = await ctx.fs.stat(aChild)
      const bStat = await ctx.fs.stat(bChild)
      const aName = join(a, name)
      const bName = join(b, name)
      if (!aStat || !bStat) {
        if (f.has('N') && (aStat ?? bStat)!.kind === 'file') {
          const empty = { text: '', mtime: 0 }
          await compare(
            aStat ? (await load(aName, aChild))! : { name: aName, ...empty },
            bStat ? (await load(bName, bChild))! : { name: bName, ...empty },
            true,
          )
          continue
        }
        ctx.stdout.write('Only in ' + (aStat ? a : b) + ': ' + name + '\n')
        status = Math.max(status, 1)
        continue
      }
      if (aStat.kind === 'directory' && bStat.kind === 'directory') {
        if (f.has('r')) await walk(aName, bName, aChild, bChild)
        else ctx.stdout.write('Common subdirectories: ' + aName + ' and ' + bName + '\n')
        continue
      }
      if (aStat.kind !== bStat.kind) {
        ctx.stdout.write(
          'File ' +
            aName +
            ' is a ' +
            (aStat.kind === 'file' ? 'regular file' : 'directory') +
            ' while file ' +
            bName +
            ' is a ' +
            (bStat.kind === 'file' ? 'regular file' : 'directory') +
            '\n',
        )
        status = Math.max(status, 1)
        continue
      }
      await compare((await load(aName, aChild))!, (await load(bName, bChild))!, true)
    }
  }
  const aPath = left === '-' ? '' : ctx.resolve(left)
  const bPath = right === '-' ? '' : ctx.resolve(right)
  const aStat = left === '-' ? null : await ctx.fs.stat(aPath)
  const bStat = right === '-' ? null : await ctx.fs.stat(bPath)
  if (aStat?.kind === 'directory' && bStat?.kind === 'directory') {
    await walk(left, right, aPath, bPath)
    return status
  }
  let aName = left
  let bName = right
  let aFile = aPath
  let bFile = bPath
  if (aStat?.kind === 'directory' && right !== '-') {
    aName = join(left, baseOf(bPath))
    aFile = join(aPath, baseOf(bPath))
  } else if (bStat?.kind === 'directory' && left !== '-') {
    bName = join(right, baseOf(aPath))
    bFile = join(bPath, baseOf(aPath))
  }
  let a = await load(aName, aFile)
  let b = await load(bName, bFile)
  if (!a && f.has('N') && b) a = { name: aName, text: '', mtime: 0 }
  if (!b && f.has('N') && a) b = { name: bName, text: '', mtime: 0 }
  if (!a) trouble(aName + ': No such file or directory')
  if (!b) trouble(bName + ': No such file or directory')
  if (!a || !b) return 2
  await compare(a, b, false)
  return status
}

const comm: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, { flags: '123' })
  const [left, right] = parsed.operands
  if (left === undefined || right === undefined) throw new CommandError('missing operand')
  const read = async (name: string) =>
    lines(name === '-' ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(name))))
  const [a, b] = [await read(left), await read(right)]
  const show = [!parsed.flags.has('1'), !parsed.flags.has('2'), !parsed.flags.has('3')]
  const write = (column: number, line: string) => {
    if (!show[column]) return
    ctx.stdout.write('\t'.repeat(show.slice(0, column).filter(Boolean).length) + line + '\n')
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) write(0, a[i++])
    else if (i >= a.length || b[j] < a[i]) write(1, b[j++])
    else {
      write(2, a[i])
      i++
      j++
    }
  }
  return 0
}

export const textCommands: Record<string, CommandHandler> = {
  echo,
  printf,
  head: streaming((ctx) => headTail(ctx, false)),
  tail: streaming((ctx) => headTail(ctx, true)),
  wc,
  grep,
  egrep: (ctx) => grep({ ...ctx, args: ['-E', ...ctx.args] }),
  fgrep: (ctx) => grep({ ...ctx, args: ['-F', ...ctx.args] }),
  sort,
  uniq,
  cut,
  tr,
  seq,
  rev,
  tac,
  nl,
  paste,
  xargs,
  date,
  sleep,
  base64,
  sha256sum: digest('SHA-256'),
  sha1sum: digest('SHA-1'),
  sha512sum: digest('SHA-512'),
  expr,
  fold,
  column,
  diff,
  comm,
  whoami: (ctx) => void ctx.stdout.write((ctx.env.USER ?? 'user') + '\n'),
  hostname: (ctx) => void ctx.stdout.write('localhost\n'),
  uname: (ctx) =>
    void ctx.stdout.write(
      (ctx.args.includes('-a')
        ? 'Linux localhost 6.0.0 #1 SMP x86_64 GNU/Linux'
        : ctx.args.includes('-m')
          ? 'x86_64'
          : 'Linux') + '\n',
    ),
  nproc: (ctx) => void ctx.stdout.write('1\n'),
  clear: () => 0,
}

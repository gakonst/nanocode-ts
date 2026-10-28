import { CommandError, type CommandContext, type CommandHandler } from '../Shell.ts'
import { FsError } from '../../FileSystem.ts'
import { decode, encode, parentOf } from '../Fs.ts'
import { globRegExp } from '../Text.ts'
import { mkdirs } from './files.ts'
import { lstatOf, pause } from './util.ts'

type ZipEntry = {
  name: string
  method: number
  crc: number
  compressed: number
  size: number
  offset: number
  mtime: number
  mode: number
  directory: boolean
  comment: string
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

async function transform(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const output = new Blob([data.slice()]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(output).arrayBuffer())
}

const inflate = (data: Uint8Array) => transform(data, new DecompressionStream('deflate-raw'))

const deflate = (data: Uint8Array) => transform(data, new CompressionStream('deflate-raw'))

function dosTime(ms: number): [number, number] {
  const date = new Date(ms)
  const year = Math.max(1980, date.getFullYear())
  return [
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  ]
}

function fromDos(time: number, date: number): number {
  return new Date(
    ((date >> 9) & 0x7f) + 1980,
    ((date >> 5) & 0xf) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  ).getTime()
}

function readEntries(data: Uint8Array): { entries: ZipEntry[]; comment: string } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0)
    throw new CommandError(
      'End-of-central-directory signature not found. Either this file is not a zipfile, or it constitutes one disk of a multi-part archive.',
      9,
    )
  let count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  const comment = decode(data.subarray(end + 22, end + 22 + view.getUint16(end + 20, true)))
  if (
    (count === 0xffff || offset === 0xffffffff) &&
    end >= 20 &&
    view.getUint32(end - 20, true) === 0x07064b50
  ) {
    const record = Number(view.getBigUint64(end - 12, true))
    if (view.getUint32(record, true) === 0x06064b50) {
      count = Number(view.getBigUint64(record + 32, true))
      offset = Number(view.getBigUint64(record + 48, true))
    }
  }
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > data.length || view.getUint32(offset, true) !== 0x02014b50)
      throw new CommandError('bad zipfile offset (central directory)', 3)
    const flags = view.getUint16(offset + 8, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const nameBytes = data.subarray(offset + 46, offset + 46 + nameLength)
    const name = flags & 0x800 ? decode(nameBytes) : decode(nameBytes)
    let compressed = view.getUint32(offset + 20, true)
    let size = view.getUint32(offset + 24, true)
    let local = view.getUint32(offset + 42, true)
    let extra = offset + 46 + nameLength
    const extraEnd = extra + extraLength
    while (extra + 4 <= extraEnd) {
      const id = view.getUint16(extra, true)
      const length = view.getUint16(extra + 2, true)
      if (id === 0x0001) {
        let at = extra + 4
        if (size === 0xffffffff) {
          size = Number(view.getBigUint64(at, true))
          at += 8
        }
        if (compressed === 0xffffffff) {
          compressed = Number(view.getBigUint64(at, true))
          at += 8
        }
        if (local === 0xffffffff) local = Number(view.getBigUint64(at, true))
      }
      extra += 4 + length
    }
    const external = view.getUint32(offset + 38, true)
    const system = view.getUint8(offset + 5)
    const unixMode = system === 3 ? external >>> 16 : 0
    entries.push({
      name,
      method: view.getUint16(offset + 10, true),
      crc: view.getUint32(offset + 16, true),
      compressed,
      size,
      offset: local,
      mtime: fromDos(view.getUint16(offset + 12, true), view.getUint16(offset + 14, true)),
      mode: unixMode & 0o7777,
      directory:
        name.endsWith('/') || (unixMode & 0o170000) === 0o040000 || (external & 0x10) !== 0,
      comment: decode(data.subarray(extraEnd, extraEnd + commentLength)),
    })
    if (flags & 1) entries[entries.length - 1].method = -1
    offset = extraEnd + commentLength
  }
  return { entries, comment }
}

async function contents(data: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(entry.offset, true) !== 0x04034b50)
    throw new CommandError('bad zipfile offset (local header sig): ' + entry.name, 3)
  const start =
    entry.offset +
    30 +
    view.getUint16(entry.offset + 26, true) +
    view.getUint16(entry.offset + 28, true)
  const raw = data.subarray(start, start + entry.compressed)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflate(raw)
  if (entry.method === -1)
    throw new CommandError('skipping: ' + entry.name + ' (encrypted entries are not supported)', 81)
  throw new CommandError(
    'skipping: ' + entry.name + ' (unsupported compression method ' + entry.method + ')',
    81,
  )
}

function date(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  )
}

function unsafe(name: string): boolean {
  return name.startsWith('/') || name.split('/').includes('..')
}

export const unzip: CommandHandler = async (ctx) => {
  const flags = new Set<string>()
  let dest: string | undefined
  let password = false
  const operands: string[] = []
  const excludes: string[] = []
  let excluding = false
  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i]
    if (arg === '-d') {
      dest = ctx.args[++i]
      if (dest === undefined)
        throw new CommandError(
          'error:  must specify directory to which to extract with -d option',
          10,
        )
      continue
    }
    if (arg === '-x') {
      excluding = true
      continue
    }
    if (arg === '-P') {
      i++
      password = true
      continue
    }
    if (arg.startsWith('-') && arg.length > 1 && !excluding) {
      for (const c of arg.slice(1)) {
        if (!'lvtopnqjfuCLaXKDZ'.includes(c))
          throw new CommandError('error: unrecognized option -' + c, 10)
        flags.add(c)
      }
      continue
    }
    if (arg.startsWith('-d') && arg.length > 2) {
      dest = arg.slice(2)
      continue
    }
    ;(excluding ? excludes : operands).push(arg)
  }
  if (password) throw new CommandError('encrypted archives are not supported', 81)
  const archive = operands.shift()
  if (archive === undefined) {
    ctx.stdout.write(
      'UnZip 6.00 (nanocode-ts)\nUsage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]\n  -p  extract files to pipe, no messages     -l  list files (short format)\n  -t  test compressed archive data           -o  overwrite files WITHOUT prompting\n  -n  never overwrite existing files         -j  junk paths (do not make directories)\n  -q  quiet mode                             -d  extract files into exdir\n',
    )
    return 0
  }
  let path = ctx.resolve(archive)
  let data: Uint8Array
  try {
    data = archive === '-' ? encode(ctx.stdin.read()) : await ctx.fs.read(path)
  } catch (error) {
    if (!(error instanceof FsError)) throw error
    try {
      path = ctx.resolve(archive + '.zip')
      data = await ctx.fs.read(path)
    } catch {
      ctx.stderr.write(
        'unzip:  cannot find or open ' +
          archive +
          ', ' +
          archive +
          '.zip or ' +
          archive +
          '.ZIP.\n',
      )
      return 9
    }
  }
  const { entries, comment } = readEntries(data)
  const caseless = flags.has('C')
  const matches = (patterns: string[], name: string) =>
    patterns.some((pattern) => globRegExp(pattern, caseless ? 'i' : '').test(name))
  const selected = entries.filter(
    (entry) =>
      (!operands.length || matches(operands, entry.name)) && !matches(excludes, entry.name),
  )
  for (const pattern of operands)
    if (!entries.some((entry) => matches([pattern], entry.name)))
      ctx.stderr.write('caution: filename not matched:  ' + pattern + '\n')
  const quiet = flags.has('q')
  if (flags.has('Z') || flags.has('l') || flags.has('v')) {
    if (flags.has('Z')) {
      for (const entry of selected) ctx.stdout.write(entry.name + '\n')
      return 0
    }
    ctx.stdout.write('Archive:  ' + archive + '\n')
    if (flags.has('v')) {
      ctx.stdout.write(
        ' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name\n--------  ------  ------- ---- ---------- ----- --------  ----\n',
      )
      let total = 0
      let packed = 0
      for (const entry of selected) {
        total += entry.size
        packed += entry.compressed
        const ratio = entry.size ? Math.round((1 - entry.compressed / entry.size) * 100) : 0
        ctx.stdout.write(
          String(entry.size).padStart(8) +
            '  ' +
            (entry.method === 8 ? 'Defl:N' : 'Stored').padEnd(6) +
            ' ' +
            String(entry.compressed).padStart(7) +
            ' ' +
            (ratio + '%').padStart(4) +
            ' ' +
            date(entry.mtime) +
            ' ' +
            entry.crc.toString(16).padStart(8, '0') +
            '  ' +
            entry.name +
            '\n',
        )
      }
      ctx.stdout.write(
        '--------          -------  ---                            -------\n' +
          String(total).padStart(8) +
          '         ' +
          String(packed).padStart(7) +
          ' ' +
          ((total ? Math.round((1 - packed / total) * 100) : 0) + '%').padStart(4) +
          '                            ' +
          selected.length +
          ' file' +
          (selected.length === 1 ? '' : 's') +
          '\n',
      )
      return 0
    }
    ctx.stdout.write('  Length      Date    Time    Name\n---------  ---------- -----   ----\n')
    let total = 0
    for (const entry of selected) {
      total += entry.size
      ctx.stdout.write(
        String(entry.size).padStart(9) + '  ' + date(entry.mtime) + '   ' + entry.name + '\n',
      )
      await pause(ctx)
    }
    ctx.stdout.write(
      '---------                     -------\n' +
        String(total).padStart(9) +
        '                     ' +
        selected.length +
        ' file' +
        (selected.length === 1 ? '' : 's') +
        '\n',
    )
    return 0
  }
  if (!quiet && !flags.has('p'))
    ctx.stdout.write('Archive:  ' + archive + '\n' + (comment ? comment + '\n' : ''))
  let status = operands.length && !selected.length ? 11 : 0
  let errors = 0
  for (const entry of selected) {
    if (flags.has('t')) {
      if (entry.directory) continue
      const bytes = await contents(data, entry).catch(() => undefined)
      const ok = bytes !== undefined && crc32(bytes) === entry.crc
      if (!ok) errors++
      if (!quiet)
        ctx.stdout.write(
          '    testing: ' + entry.name.padEnd(23) + (ok ? '  OK' : '  bad CRC') + '\n',
        )
      continue
    }
    if (flags.has('p')) {
      if (entry.directory) continue
      ctx.stdout.write(decode(await contents(data, entry)))
      continue
    }
    if (unsafe(entry.name)) {
      ctx.stderr.write('warning:  skipped "../" path component(s) in ' + entry.name + '\n')
      status = Math.max(status, 1)
      continue
    }
    const relative = flags.has('j')
      ? (entry.name.split('/').filter(Boolean).pop() ?? '')
      : entry.name.replace(/\/+$/, '')
    if (!relative || (flags.has('j') && entry.directory)) continue
    const target = ctx.resolve(
      (dest !== undefined ? dest.replace(/\/+$/, '') + '/' : '') + relative,
    )
    if (entry.directory) {
      await mkdirs(ctx.fs, target)
      if (!quiet)
        ctx.stdout.write(
          '   creating: ' +
            (dest !== undefined ? dest.replace(/\/+$/, '') + '/' : '') +
            entry.name +
            '\n',
        )
      continue
    }
    const existing = await lstatOf(ctx, target)
    if (existing) {
      if (flags.has('n')) continue
      if (flags.has('u') && existing.mtime >= entry.mtime) continue
      if (!flags.has('o') && !flags.has('f') && !flags.has('u')) {
        ctx.stderr.write(
          'replace ' +
            relative +
            '? [y]es, [n]o, [A]ll, [N]one, [r]ename: NULL\n(EOF or read error, treating as "[N]one" ...)\n',
        )
        status = Math.max(status, 1)
        break
      }
    }
    let bytes: Uint8Array
    try {
      bytes = await contents(data, entry)
    } catch (error) {
      if (!(error instanceof CommandError)) throw error
      ctx.stderr.write(error.message + '\n')
      status = Math.max(status, 1)
      continue
    }
    if (crc32(bytes) !== entry.crc) {
      ctx.stderr.write(
        relative +
          '  bad CRC ' +
          crc32(bytes).toString(16).padStart(8, '0') +
          '  (should be ' +
          entry.crc.toString(16).padStart(8, '0') +
          ')\n',
      )
      status = Math.max(status, 2)
    }
    await mkdirs(ctx.fs, parentOf(target))
    await ctx.fs.write(target, bytes)
    if (entry.mode && ctx.fs.chmod) await ctx.fs.chmod(target, entry.mode & 0o777)
    if (!quiet)
      ctx.stdout.write(
        '  inflating: ' +
          (dest !== undefined ? dest.replace(/\/+$/, '') + '/' : '') +
          relative +
          '\n',
      )
    await pause(ctx)
  }
  if (flags.has('t')) {
    if (errors) {
      ctx.stdout.write('At least one error was detected in ' + archive + '.\n')
      return 2
    }
    if (!quiet) ctx.stdout.write('No errors detected in compressed data of ' + archive + '.\n')
    else ctx.stdout.write('No errors detected in compressed data of ' + archive + '.\n')
  }
  return status
}

type Pending = { name: string; data: Uint8Array | undefined; mtime: number; mode: number }

async function gather(
  ctx: CommandContext,
  operand: string,
  recurse: boolean,
  junk: boolean,
  out: Pending[],
  excluded: (name: string) => boolean,
): Promise<boolean> {
  const path = ctx.resolve(operand)
  const stat = await ctx.fs.stat(path)
  if (!stat) return false
  const name = (
    junk
      ? (operand.split('/').filter(Boolean).pop() ?? operand)
      : operand.replace(/^(\.\/)+/, '').replace(/^\/+/, '')
  ).replace(/\/+$/, '')
  if (stat.kind === 'file') {
    if (!excluded(name))
      out.push({ name, data: await ctx.fs.read(path), mtime: stat.mtime, mode: stat.mode })
    return true
  }
  if (!junk && name && name !== '.' && !excluded(name + '/'))
    out.push({ name: name + '/', data: undefined, mtime: stat.mtime, mode: stat.mode })
  if (!recurse) return true
  for (const child of await ctx.fs.list(path))
    await gather(
      ctx,
      (operand.replace(/\/+$/, '') || '/') + '/' + child,
      recurse,
      junk,
      out,
      excluded,
    )
  return true
}

export const zip: CommandHandler = async (ctx) => {
  const flags = new Set<string>()
  const excludes: string[] = []
  const operands: string[] = []
  let level = 6
  let mode: 'x' | 'i' | undefined
  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i]
    if (arg === '-x' || arg === '--exclude') {
      mode = 'x'
      continue
    }
    if (arg === '-r' || arg === '--recurse-paths') {
      flags.add('r')
      continue
    }
    if (arg.startsWith('--')) {
      if (arg === '--quiet') flags.add('q')
      else if (arg === '--junk-paths') flags.add('j')
      else if (arg === '--delete') flags.add('d')
      continue
    }
    if (arg.startsWith('-') && arg.length > 1 && mode !== 'x') {
      for (const c of arg.slice(1)) {
        if (/[0-9]/.test(c)) level = Number(c)
        else if ('rqjdmuvXyDTlAoFS@'.includes(c)) flags.add(c)
        else
          throw new CommandError(
            "zip error: Invalid command arguments (short option '" + c + "' not supported)",
            16,
          )
      }
      continue
    }
    if (mode === 'x') excludes.push(arg)
    else operands.push(arg)
  }
  let archive = operands.shift()
  if (archive === undefined) {
    ctx.stdout.write(
      "Zip 3.0 (nanocode-ts)\nUsage: zip [-options] [-b path] [-t mmddyyyy] [-n suffixes] [zipfile list] [-xi list]\n  -r   recurse into directories   -j   junk (don't record) directory names\n  -0   store only                 -9   compress better\n  -q   quiet operation            -d   delete entries in zipfile\n  -x   exclude the following names\n",
    )
    return 0
  }
  if (archive !== '-' && !/\.[^/]*$/.test(archive.split('/').pop() ?? '')) archive += '.zip'
  const path = ctx.resolve(archive)
  const quiet = flags.has('q')
  const excluded = (name: string) =>
    excludes.some(
      (pattern) =>
        globRegExp(pattern).test(name) || globRegExp(pattern).test(name.replace(/\/$/, '')),
    )
  const existing = new Map<
    string,
    Pending & { raw?: Uint8Array; method?: number; crc?: number; size?: number }
  >()
  if (archive !== '-') {
    const old = await ctx.fs.read(path).catch(() => undefined)
    if (old?.length) {
      const { entries } = readEntries(old)
      for (const entry of entries) {
        const view = new DataView(old.buffer, old.byteOffset, old.byteLength)
        const start =
          entry.offset +
          30 +
          view.getUint16(entry.offset + 26, true) +
          view.getUint16(entry.offset + 28, true)
        existing.set(entry.name, {
          name: entry.name,
          data: undefined,
          mtime: entry.mtime,
          mode: entry.mode,
          raw: old.slice(start, start + entry.compressed),
          method: entry.method,
          crc: entry.crc,
          size: entry.size,
        })
      }
    }
  }
  if (flags.has('d')) {
    let deleted = 0
    for (const name of [...existing.keys()]) {
      if (operands.some((pattern) => globRegExp(pattern).test(name))) {
        existing.delete(name)
        deleted++
        if (!quiet) ctx.stdout.write('deleting: ' + name + '\n')
      }
    }
    if (!deleted) {
      ctx.stderr.write('zip warning: name not matched: ' + operands.join(' ') + '\n')
      return 12
    }
  } else {
    const added: Pending[] = []
    let missing = 0
    for (const operand of operands) {
      if (operand === '-@') continue
      if (!(await gather(ctx, operand, flags.has('r'), flags.has('j'), added, excluded))) {
        ctx.stderr.write('\tzip warning: name not matched: ' + operand + '\n')
        missing++
      }
    }
    if (!added.length && !existing.size) {
      ctx.stderr.write('\nzip error: Nothing to do! (' + archive + ')\n')
      return 12
    }
    for (const entry of added) {
      const replaced = existing.has(entry.name)
      existing.set(entry.name, entry)
      if (!quiet)
        ctx.stdout.write(
          (replaced ? 'updating: ' : '  adding: ') +
            entry.name +
            (entry.data === undefined ? ' (stored 0%)' : '') +
            '\n',
        )
    }
    if (missing && !added.length) return 12
  }
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of existing.values()) {
    const name = encode(entry.name)
    let method: number
    let crc: number
    let size: number
    let body: Uint8Array
    if ('raw' in entry && entry.raw !== undefined && entry.data === undefined) {
      method = entry.method ?? 0
      crc = entry.crc ?? 0
      size = entry.size ?? 0
      body = entry.raw
    } else {
      const data = entry.data ?? new Uint8Array()
      crc = crc32(data)
      size = data.length
      const packed = level > 0 && data.length ? await deflate(data) : data
      method = packed.length < data.length ? 8 : 0
      body = method === 8 ? packed : data
    }
    if (offset > 0xffffffff || body.length > 0xffffffff)
      throw new CommandError('zip error: archives larger than 4 GiB are not supported', 16)
    const [time, day] = dosTime(entry.mtime)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x800, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, time, true)
    lv.setUint16(12, day, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const record = new Uint8Array(46 + name.length)
    const cv = new DataView(record.buffer)
    const directory = entry.name.endsWith('/')
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, (3 << 8) | 30, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x800, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, day, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(
      38,
      ((((directory ? 0o040000 : 0o100000) | (entry.mode || (directory ? 0o755 : 0o644))) << 16) |
        (directory ? 0x10 : 0)) >>>
        0,
      true,
    )
    cv.setUint32(42, offset, true)
    record.set(name, 46)
    chunks.push(local, body)
    central.push(record)
    offset += local.length + body.length
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const total = new Uint8Array(offset + centralSize + 22)
  let at = 0
  for (const part of [...chunks, ...central, end]) {
    total.set(part, at)
    at += part.length
  }
  if (archive === '-') ctx.stdout.write(decode(total))
  else await ctx.fs.write(path, total)
  return 0
}

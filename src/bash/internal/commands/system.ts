/**
 * System commands, such as `dd`, `df`, `ps`, and `printenv`.
 *
 * @module
 */
import { CommandError, budget, type CommandContext, type CommandHandler } from '../Shell.ts'
import { decode, encode } from '../Fs.ts'
import { device, options, put } from './util.ts'
import { mkdirs } from './files.ts'
import { parentOf } from '../Fs.ts'

const DEVICE_CHUNK = 1 << 20

function size(text: string, what: string): number {
  const match = /^(\d+)(c|w|b|kB|K|k|MB|M|m|GB|G|g)?$/.exec(text)
  if (!match) throw new CommandError("invalid number: '" + text + "' for " + what, 1)
  const unit = {
    '': 1,
    c: 1,
    w: 2,
    b: 512,
    kB: 1000,
    K: 1024,
    k: 1024,
    MB: 1e6,
    M: 1 << 20,
    m: 1 << 20,
    GB: 1e9,
    G: 1 << 30,
    g: 1 << 30,
  }[match[2] ?? '']!
  return Number(match[1]) * unit
}

const dd: CommandHandler = async (ctx) => {
  const operands: Record<string, string> = {}
  for (const arg of ctx.args) {
    const index = arg.indexOf('=')
    if (index <= 0) throw new CommandError("unrecognized operand '" + arg + "'", 1)
    operands[arg.slice(0, index)] = arg.slice(index + 1)
  }
  const block = size(operands.bs ?? operands.ibs ?? '512', 'bs')
  if (block <= 0) throw new CommandError("invalid number: '" + (operands.bs ?? '') + "'", 1)
  const count = operands.count === undefined ? Infinity : size(operands.count, 'count')
  const skip = operands.skip === undefined ? 0 : size(operands.skip, 'skip') * block
  const seek = operands.seek === undefined ? 0 : size(operands.seek, 'seek') * block
  const conv = new Set((operands.conv ?? '').split(',').filter(Boolean))
  const started = performance.now()
  const input = operands.if === undefined ? undefined : ctx.resolve(operands.if)
  const special = input === undefined ? undefined : device(input, 0)
  let total = 0
  const chunks: Uint8Array[] = []
  const output = operands.of === undefined ? undefined : ctx.resolve(operands.of)
  let written = 0
  const emit = async (bytes: Uint8Array) => {
    total += bytes.length
    if (output === undefined) return put(ctx, decode(bytes))
    if (seek === 0 && !conv.has('notrunc')) {
      await ctx.fs.write(output, bytes, written > 0)
      written += bytes.length
      return
    }
    chunks.push(bytes)
  }
  if (output !== undefined) await mkdirs(ctx.fs, parentOf(output))
  if (special !== undefined) {
    if (count === Infinity && input !== '/dev/null')
      throw new CommandError(
        'reading ' + operands.if + ' without count= never ends; add count=N',
        1,
      )
    const want = input === '/dev/null' ? 0 : count * block
    budget(ctx.limits, Math.min(want, DEVICE_CHUNK) * 3, 'dd')
    for (let done = 0; done < want; done += DEVICE_CHUNK)
      await emit(encode(device(input!, Math.min(DEVICE_CHUNK, want - done))!))
  } else {
    let data: Uint8Array
    if (input === undefined) data = encode(await ctx.stdin.text())
    else {
      const stat = await ctx.fs.stat(input)
      if (!stat)
        throw new CommandError("failed to open '" + operands.if + "': No such file or directory", 1)
      budget(ctx.limits, 2 * stat.size, 'dd: ' + operands.if)
      data = await ctx.fs.read(input)
    }
    const end = count === Infinity ? data.length : Math.min(data.length, skip + count * block)
    for (let at = skip; at < end; at += DEVICE_CHUNK)
      await emit(data.subarray(at, Math.min(end, at + DEVICE_CHUNK)))
  }
  if (output !== undefined && (seek > 0 || conv.has('notrunc'))) {
    const stat = await ctx.fs.stat(output)
    const old = stat ? await ctx.fs.read(output) : new Uint8Array(0)
    const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let at = 0
    for (const chunk of chunks) {
      body.set(chunk, at)
      at += chunk.length
    }
    const length = conv.has('notrunc')
      ? Math.max(old.length, seek + body.length)
      : seek + body.length
    const next = new Uint8Array(length)
    next.set(old.subarray(0, Math.min(old.length, length)))
    next.set(body, seek)
    await ctx.fs.write(output, next)
  } else if (output !== undefined && written === 0) await ctx.fs.write(output, new Uint8Array(0))
  if (operands.status !== 'none') {
    const records = Math.floor(total / block)
    const partial = total % block ? 1 : 0
    const seconds = Math.max((performance.now() - started) / 1000, 0.000001)
    ctx.stderr.write(
      records +
        '+' +
        partial +
        ' records in\n' +
        records +
        '+' +
        partial +
        ' records out\n' +
        total +
        ' bytes (' +
        human(total) +
        ') copied, ' +
        seconds.toFixed(4) +
        ' s, ' +
        human(total / seconds) +
        '/s\n',
    )
  }
  return 0
}

function human(bytes: number): string {
  if (bytes < 1000) return Math.round(bytes) + ' B'
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return value.toFixed(1) + ' ' + units[unit]
}

const printenv: CommandHandler = (ctx) => {
  const names = ctx.args.filter((arg) => !arg.startsWith('-'))
  if (!names.length) {
    for (const [name, value] of Object.entries(ctx.env).sort())
      ctx.stdout.write(name + '=' + value + '\n')
    return 0
  }
  let status = 0
  for (const name of names) {
    const value = ctx.env[name]
    if (value === undefined) status = 1
    else ctx.stdout.write(value + '\n')
  }
  return status
}

const nohup: CommandHandler = async (ctx) => {
  if (!ctx.args.length) throw new CommandError('missing operand', 125)
  return ctx.run(ctx.args)
}

const pager: CommandHandler = async (ctx) =>
  ctx.run(['cat', ...ctx.args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('+'))])

const sponge: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, { flags: 'a' })
  const text = await ctx.stdin.text()
  const target = parsed.operands[0]
  if (target === undefined) return void ctx.stdout.write(text)
  const path = ctx.resolve(target)
  await ctx.fs.write(path, encode(text), parsed.flags.has('a'))
  return 0
}

const uuidgen: CommandHandler = (ctx) => void ctx.stdout.write(crypto.randomUUID() + '\n')

const df: CommandHandler = (ctx) => {
  const human = ctx.args.some((arg) => /^-\w*h/.test(arg))
  ctx.stdout.write(
    human
      ? 'Filesystem      Size  Used Avail Use% Mounted on\nworkspace       1.0G     0  1.0G   0% /\n'
      : 'Filesystem     1K-blocks  Used Available Use% Mounted on\nworkspace        1048576     0   1048576   0% /\n',
  )
  return 0
}

const free: CommandHandler = (ctx) => {
  const total = Math.floor(ctx.limits.maxMemoryBytes / 1024)
  ctx.stdout.write(
    '               total        used        free      shared  buff/cache   available\nMem:      ' +
      String(total).padStart(10) +
      '           0 ' +
      String(total).padStart(11) +
      '           0           0 ' +
      String(total).padStart(11) +
      '\nSwap:              0           0           0\n',
  )
  return 0
}

const ps: CommandHandler = (ctx) => {
  ctx.stdout.write('    PID TTY          TIME CMD\n      1 ?        00:00:00 bash\n')
  return 0
}

const factor: CommandHandler = async (ctx) => {
  const numbers = ctx.args.length ? ctx.args : (await ctx.stdin.text()).split(/\s+/).filter(Boolean)
  let status = 0
  for (const text of numbers) {
    if (!/^\d+$/.test(text)) {
      ctx.stderr.write("factor: '" + text + "' is not a valid positive integer\n")
      status = 1
      continue
    }
    let n = BigInt(text)
    const factors: bigint[] = []
    for (const p of [2n, 3n])
      while (n > 1n && n % p === 0n) {
        factors.push(p)
        n /= p
      }
    for (let p = 5n; p * p <= n; p += 6n) {
      for (const q of [p, p + 2n])
        while (n % q === 0n) {
          factors.push(q)
          n /= q
        }
      if (p % 6000001n === 5n) await ctx.sleep(0)
    }
    if (n > 1n) factors.push(n)
    ctx.stdout.write(text + ':' + factors.map((f) => ' ' + f).join('') + '\n')
  }
  return status
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const base32: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'di',
    values: 'w',
    long: { decode: 'd', 'ignore-garbage': 'i', wrap: 'w' },
  })
  const operand = parsed.operands[0]
  const data =
    operand === undefined || operand === '-'
      ? encode(await ctx.stdin.text())
      : await ctx.fs.read(ctx.resolve(operand))
  if (parsed.flags.has('d')) {
    const text = decode(data).replace(/[\s=]/g, '').toUpperCase()
    const out: number[] = []
    let bits = 0
    let value = 0
    for (const char of text) {
      const index = BASE32.indexOf(char)
      if (index < 0) {
        if (parsed.flags.has('i')) continue
        throw new CommandError('invalid input', 1)
      }
      value = (value << 5) | index
      bits += 5
      if (bits >= 8) {
        bits -= 8
        out.push((value >> bits) & 0xff)
      }
    }
    await put(ctx, decode(Uint8Array.from(out)))
    return 0
  }
  let text = ''
  let bits = 0
  let value = 0
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      text += BASE32[(value >> bits) & 31]
    }
    value &= 0xff
  }
  if (bits > 0) text += BASE32[(value << (5 - bits)) & 31]
  while (text.length % 8) text += '='
  const wrap = Number(parsed.values.get('w')?.at(-1) ?? 76)
  await put(
    ctx,
    (wrap > 0 ? (text.match(new RegExp('.{1,' + wrap + '}', 'g'))?.join('\n') ?? '') : text) + '\n',
  )
  return 0
}

export const systemCommands: Record<string, CommandHandler> = {
  base32,
  dd,
  df,
  factor,
  free,
  less: pager,
  more: pager,
  nohup,
  printenv,
  ps,
  sponge,
  uuidgen,
}

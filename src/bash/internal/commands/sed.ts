/**
 * The `sed` command.
 *
 * @module
 */
import { CommandError, budget, flatten, streaming, type CommandHandler } from '../Shell.ts'
import { FsError } from '../../FileSystem.ts'
import { decode, encode } from '../Fs.ts'
import { posixRegExp } from '../Text.ts'
import { options, put } from './util.ts'

type Address =
  | { kind: 'line'; line: number }
  | { kind: 'last' }
  | { kind: 'regex'; regex: RegExp | null }
  | { kind: 'step'; first: number; step: number }
  | { kind: 'relative'; count: number }

type SedCommand = {
  name: string
  from?: Address
  to?: Address
  negate: boolean
  regex?: RegExp | null
  replacement?: string
  global?: boolean
  occurrence?: number
  print?: boolean
  text?: string
  label?: string
  file?: string
  code?: number
  source?: string
  target?: string
  block?: number
  range?: { active: boolean; end: number }
}

class Parser {
  src: string
  pos = 0
  extended: boolean

  constructor(src: string, extended: boolean) {
    this.src = src
    this.extended = extended
  }

  fail(message: string): never {
    throw new CommandError('-e expression #1, char ' + (this.pos + 1) + ': ' + message)
  }

  blanks() {
    while (this.pos < this.src.length && /[ \t]/.test(this.src[this.pos])) this.pos++
  }

  delimited(delimiter: string): string {
    let out = ''
    while (this.pos < this.src.length && this.src[this.pos] !== delimiter) {
      if (this.src[this.pos] === '\\' && this.pos + 1 < this.src.length) {
        const next = this.src[this.pos + 1]
        if (next === delimiter) out += delimiter === '&' ? '\\&' : next
        else if (next === 'n') out += '\n'
        else out += '\\' + next
        this.pos += 2
        continue
      }
      if (this.src[this.pos] === '[') {
        const end = this.src.slice(this.pos).match(/^\[\^?\]?(\[:\w+:\]|[^\]])*\]/)
        if (end) {
          out += end[0]
          this.pos += end[0].length
          continue
        }
      }
      out += this.src[this.pos++]
    }
    if (this.pos >= this.src.length) this.fail("unterminated `s' command")
    this.pos++
    return out
  }

  regex(source: string, flags: string): RegExp | null {
    if (source === '') return null
    try {
      return posixRegExp(source, this.extended, flags)
    } catch (error) {
      this.fail('invalid regular expression: ' + (error as Error).message)
    }
  }

  address(): Address | undefined {
    const c = this.src[this.pos]
    if (c === undefined) return undefined
    if (/\d/.test(c)) {
      const match = this.src.slice(this.pos).match(/^(\d+)(?:~(\d+))?/)!
      this.pos += match[0].length
      if (match[2] !== undefined)
        return { kind: 'step', first: Number(match[1]), step: Number(match[2]) }
      return { kind: 'line', line: Number(match[1]) }
    }
    if (c === '$') {
      this.pos++
      return { kind: 'last' }
    }
    if (c === '/' || c === '\\') {
      let delimiter = '/'
      if (c === '\\') {
        delimiter = this.src[this.pos + 1]
        this.pos++
      }
      this.pos++
      const source = this.delimited(delimiter)
      let flags = ''
      while (this.src[this.pos] === 'I' || this.src[this.pos] === 'M')
        flags += this.src[this.pos++] === 'I' ? 'i' : 'm'
      return { kind: 'regex', regex: this.regex(source, flags) }
    }
    if (c === '+' || c === '~') {
      const match = this.src.slice(this.pos + 1).match(/^\d+/)
      if (!match) return undefined
      this.pos += 1 + match[0].length
      return { kind: 'relative', count: Number(match[0]) }
    }
    return undefined
  }

  text(): string {
    this.blanks()
    if (this.src[this.pos] === '\\') {
      this.pos++
      if (this.src[this.pos] === '\n') this.pos++
    }
    let out = ''
    while (this.pos < this.src.length && this.src[this.pos] !== '\n') {
      if (this.src[this.pos] === '\\' && this.pos + 1 < this.src.length) {
        const next = this.src[this.pos + 1]
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next
        this.pos += 2
        continue
      }
      out += this.src[this.pos++]
    }
    return out
  }

  word(): string {
    this.blanks()
    const match = this.src.slice(this.pos).match(/^[^;\n}]*/)![0]
    this.pos += match.length
    return match.trim()
  }

  parse(): SedCommand[] {
    const commands: SedCommand[] = []
    const blocks: number[] = []
    for (;;) {
      while (this.pos < this.src.length && /[\s;]/.test(this.src[this.pos])) this.pos++
      if (this.pos >= this.src.length) break
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++
        continue
      }
      const command: SedCommand = { name: '', negate: false }
      command.from = this.address()
      if (command.from && this.src[this.pos] === ',') {
        this.pos++
        command.to = this.address()
        if (!command.to) this.fail("unexpected `,'")
        command.range = { active: false, end: 0 }
      }
      this.blanks()
      while (this.src[this.pos] === '!') {
        command.negate = true
        this.pos++
        this.blanks()
      }
      const name = this.src[this.pos++]
      if (name === undefined) this.fail('missing command')
      command.name = name
      switch (name) {
        case '{':
          blocks.push(commands.length)
          break
        case '}': {
          const open = blocks.pop()
          if (open === undefined) this.fail("unexpected `}'")
          commands[open].block = commands.length
          break
        }
        case 's': {
          const delimiter = this.src[this.pos++]
          if (!delimiter || delimiter === '\n' || delimiter === '\\')
            this.fail("unterminated `s' command")
          const source = this.delimited(delimiter)
          command.replacement = this.delimited(delimiter)
          let flags = ''
          for (;;) {
            const c = this.src[this.pos]
            if (c === 'g') command.global = true
            else if (c === 'p') command.print = true
            else if (c === 'i' || c === 'I') flags += 'i'
            else if (c === 'm' || c === 'M') flags += 'm'
            else if (c !== undefined && /\d/.test(c)) {
              const match = this.src.slice(this.pos).match(/^\d+/)![0]
              command.occurrence = Number(match)
              this.pos += match.length - 1
            } else if (c === 'w') {
              this.pos++
              command.file = this.word()
              break
            } else break
            this.pos++
          }
          command.regex = this.regex(source, flags)
          break
        }
        case 'y': {
          const delimiter = this.src[this.pos++]
          command.source = this.delimited(delimiter)
          command.target = this.delimited(delimiter)
          if ([...command.source].length !== [...command.target].length)
            this.fail("strings for `y' command are different lengths")
          break
        }
        case 'a':
        case 'i':
        case 'c':
          command.text = this.text()
          break
        case 'b':
        case 't':
        case 'T':
        case ':': {
          const label = this.word()
          if (name === ':' && !label) this.fail('":" lacks a label')
          command.label = label
          break
        }
        case 'r':
        case 'R':
        case 'w':
        case 'W':
          command.file = this.word()
          break
        case 'q':
        case 'Q': {
          this.blanks()
          const match = this.src.slice(this.pos).match(/^\d+/)
          if (match) {
            command.code = Number(match[0])
            this.pos += match[0].length
          }
          break
        }
        case 'p':
        case 'P':
        case 'd':
        case 'D':
        case 'n':
        case 'N':
        case 'g':
        case 'G':
        case 'h':
        case 'H':
        case 'x':
        case '=':
        case 'l':
        case 'z':
        case 'F':
          break
        default:
          this.pos--
          this.fail('unknown command: `' + name + "'")
      }
      commands.push(command)
    }
    if (blocks.length) this.fail("unmatched `{'")
    return commands
  }
}

function substitute(template: string, match: string[]): string {
  let out = ''
  let mode: '' | 'U' | 'L' = ''
  let once: '' | 'u' | 'l' = ''
  const add = (text: string) => {
    for (const c of text) {
      let value = mode === 'U' ? c.toUpperCase() : mode === 'L' ? c.toLowerCase() : c
      if (once) {
        value = once === 'u' ? value.toUpperCase() : value.toLowerCase()
        once = ''
      }
      out += value
    }
  }
  for (let i = 0; i < template.length; i++) {
    const c = template[i]
    if (c === '&') add(match[0])
    else if (c === '\\' && i + 1 < template.length) {
      const next = template[++i]
      if (/\d/.test(next)) add(match[Number(next)] ?? '')
      else if (next === 'n') add('\n')
      else if (next === 't') add('\t')
      else if (next === 'U' || next === 'L') mode = next
      else if (next === 'E') mode = ''
      else if (next === 'u' || next === 'l') once = next
      else add(next)
    } else add(c)
  }
  return out
}

const templates = new Map<string, (match: RegExpExecArray) => string>()

function template(text: string): (match: RegExpExecArray) => string {
  let compiled = templates.get(text)
  if (compiled) return compiled
  const pieces: (string | number)[] = []
  let literal = ''
  let simple = true
  for (let i = 0; i < text.length && simple; i++) {
    const c = text[i]
    if (c === '&') {
      pieces.push(literal, 0)
      literal = ''
    } else if (c === '\\' && i + 1 < text.length) {
      const next = text[++i]
      if (/\d/.test(next)) {
        pieces.push(literal, Number(next))
        literal = ''
      } else if (next === 'n') literal += '\n'
      else if (next === 't') literal += '\t'
      else if ('ULEul'.includes(next)) simple = false
      else literal += next
    } else literal += c
  }
  pieces.push(literal)
  compiled = simple
    ? (match: RegExpExecArray) => {
        let out = ''
        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i]
          out += typeof piece === 'string' ? piece : (match[piece] ?? '')
        }
        return out
      }
    : (match: RegExpExecArray) =>
        substitute(
          text,
          [...match].map((group) => group ?? ''),
        )
  if (templates.size > 256) templates.clear()
  templates.set(text, compiled)
  return compiled
}

const replacers = new WeakMap<
  RegExp,
  Map<string, ((match: string, ...groups: unknown[]) => string) | null>
>()

function replacer(
  regex: RegExp,
  text: string,
): ((match: string, ...groups: unknown[]) => string) | null {
  let byText = replacers.get(regex)
  if (!byText) {
    byText = new Map()
    replacers.set(regex, byText)
  }
  let compiled = byText.get(text)
  if (compiled !== undefined) return compiled
  compiled = null
  const empty =
    new RegExp(regex.source, regex.flags.replace('g', '')).test('') ||
    /\\b|\\B|\(\?[=!<]/.test(regex.source)
  const groups =
    (new RegExp(regex.source + '|', regex.flags.replace('g', '')).exec('')?.length ?? 1) - 1
  const pieces: (string | number)[] = []
  let literal = ''
  let simple = !empty
  for (let i = 0; i < text.length && simple; i++) {
    const c = text[i]
    if (c === '&') {
      pieces.push(literal, 0)
      literal = ''
    } else if (c === '\\' && i + 1 < text.length) {
      const next = text[++i]
      if (/\d/.test(next)) {
        if (Number(next) > groups) simple = false
        pieces.push(literal, Number(next))
        literal = ''
      } else if (next === 'n') literal += '\n'
      else if (next === 't') literal += '\t'
      else if ('ULEul'.includes(next)) simple = false
      else literal += next
    } else literal += c
  }
  pieces.push(literal)
  if (simple)
    compiled = (match: string, ...rest: unknown[]) => {
      let out = ''
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]
        out +=
          typeof piece === 'string'
            ? piece
            : piece === 0
              ? match
              : ((rest[piece - 1] as string | undefined) ?? '')
      }
      return out
    }
  byText.set(text, compiled)
  return compiled
}

const globals = new WeakMap<RegExp, RegExp>()

function globalOf(regex: RegExp): RegExp {
  let global = globals.get(regex)
  if (!global) {
    global = new RegExp(regex.source, regex.flags.replace('g', '') + 'g')
    globals.set(regex, global)
  }
  return global
}

export const sed: CommandHandler = streaming(async (ctx) => {
  let suffix = ''
  const args = ctx.args.map((arg) => {
    const match = arg.match(/^(?:-([nErsuz]*)i|--in-place=)(.*)$/)
    if (!match) return arg
    suffix = match[2]
    return '-' + (match[1] ?? '') + 'i'
  })
  const parsed = options(args, {
    flags: 'nErsuziV',
    values: 'efl',
    long: {
      quiet: 'n',
      silent: 'n',
      'regexp-extended': 'E',
      expression: 'e',
      file: 'f',
      separate: 's',
      'in-place': 'i',
      posix: '',
      debug: '',
      'null-data': 'z',
      'line-length': 'l',
      version: 'V',
      help: 'V',
      sandbox: '',
      'follow-symlinks': '',
    },
  })
  if (parsed.flags.has('V')) {
    ctx.stdout.write('sed (GNU sed) 4.9\n')
    return 0
  }
  const inPlace = parsed.flags.has('i')
  const scripts = [...(parsed.values.get('e') ?? [])]
  for (const file of parsed.values.get('f') ?? [])
    scripts.push(decode(await ctx.fs.read(ctx.resolve(file))))
  const operands = [...parsed.operands]
  if (!scripts.length) {
    if (!operands.length) throw new CommandError('no script specified', 1)
    scripts.push(operands.shift()!)
  }
  const extended = parsed.flags.has('E') || parsed.flags.has('r')
  const commands = new Parser(scripts.join('\n'), extended).parse()
  const labels = new Map<string, number>()
  commands.forEach((command, index) => {
    if (command.name === ':') labels.set(command.label!, index)
  })
  for (const command of commands)
    if (
      (command.name === 'b' || command.name === 't' || command.name === 'T') &&
      command.label &&
      !labels.has(command.label)
    )
      throw new CommandError("can't find label for jump to `" + command.label + "'")
  const quiet = parsed.flags.has('n')
  const separator = parsed.flags.has('z') ? '\0' : '\n'
  const writes = new Map<string, string>()
  let lastRegex: RegExp | null = null
  let exitCode = 0
  let quit = false
  const run = async (
    read: () => Promise<string | null>,
    write: (text: string) => Promise<void>,
  ): Promise<void> => {
    let input: string[] = []
    let trailing = true
    let ended = false
    let carry = ''
    let out = ''
    let index = 0
    const fill = async () => {
      while (!ended && input.length - index < 2) {
        const chunk = await read()
        if (chunk === null) {
          ended = true
          if (carry) {
            input.push(carry)
            trailing = false
            carry = ''
          }
          break
        }
        const parts = (carry + chunk).split(separator)
        carry = parts.pop()!
        if (index > 1024) {
          input = input.slice(index)
          index = 0
        }
        for (const part of parts) input.push(part)
      }
    }
    let lineNumber = 0
    let hold = ''
    const grow = (text: string, before: number): string => {
      if (text.length >>> 20 !== before >>> 20)
        budget(ctx.limits, 4 * text.length, 'sed: the pattern and hold space')
      if (text.length > 4096 && Math.clz32(text.length) < Math.clz32(before)) flatten(text)
      return text
    }
    for (const command of commands)
      if (command.range)
        command.range = {
          active:
            command.from?.kind === 'line' &&
            command.from.line === 0 &&
            command.to?.kind === 'regex',
          end: 0,
        }
    const isLast = () => index >= input.length
    const chunks: string[] = []
    const emit = (value: string) => {
      out += value + separator
      if (out.length > 65536) {
        chunks.push(out)
        out = ''
      }
    }
    const pick = (regex: RegExp | null | undefined): RegExp => {
      const value = regex ?? lastRegex
      if (!value) throw new CommandError('no previous regular expression')
      lastRegex = value
      return value
    }
    const matchAddress = (address: Address, space: string): boolean => {
      switch (address.kind) {
        case 'line':
          return lineNumber === address.line
        case 'last':
          return isLast()
        case 'step':
          return address.step <= 0
            ? lineNumber === address.first
            : lineNumber >= address.first && (lineNumber - address.first) % address.step === 0
        case 'regex': {
          const regex = pick(address.regex)
          regex.lastIndex = 0
          return regex.test(space)
        }
        default:
          return false
      }
    }
    const selected = (command: SedCommand, space: string): boolean => {
      let hit: boolean
      if (!command.from) hit = true
      else if (!command.to) hit = matchAddress(command.from, space)
      else {
        const range = command.range!
        if (range.active) {
          hit = true
          const to = command.to
          if (to.kind === 'line') {
            if (lineNumber >= to.line) range.active = false
          } else if (to.kind === 'relative') {
            if (lineNumber >= range.end) range.active = false
          } else if (matchAddress(to, space)) range.active = false
        } else if (matchAddress(command.from, space)) {
          hit = true
          const to = command.to
          if (to.kind === 'line') range.active = to.line > lineNumber
          else if (to.kind === 'relative') {
            range.end = lineNumber + to.count
            range.active = to.count > 0
          } else range.active = to.kind === 'last' ? !isLast() : true
        } else hit = false
      }
      return hit !== command.negate
    }
    for (;;) {
      await fill()
      if (index >= input.length || quit) break
      let space = input[index++]
      lineNumber++
      let appended = ''
      let substituted = false
      let deleted = false
      let restart = false
      let pc = 0
      while (pc < commands.length) {
        const command = commands[pc]
        if (!selected(command, space)) {
          pc = command.name === '{' ? command.block! + 1 : pc + 1
          continue
        }
        pc++
        switch (command.name) {
          case 's': {
            const regex = pick(command.regex)
            const global = globalOf(regex)
            const fast =
              command.global && (command.occurrence ?? 1) === 1
                ? replacer(regex, command.replacement!)
                : null
            if (fast) {
              global.lastIndex = 0
              if (global.test(space)) {
                space = space.replace(global, fast)
                substituted = true
                if (command.print) emit(space)
                if (command.file)
                  writes.set(command.file, (writes.get(command.file) ?? '') + space + '\n')
              }
              break
            }
            const replacement = template(command.replacement!)
            const target = command.occurrence ?? 1
            let count = 0
            let changed = false
            let result = ''
            let last = 0
            let previous = -1
            for (let position = 0; position <= space.length; ) {
              global.lastIndex = position
              const match = global.exec(space)
              if (!match) break
              if (match[0] === '' && match.index === previous) {
                position = match.index + 1
                continue
              }
              count++
              const replace = count === target || (command.global && count > target)
              if (replace) changed = true
              result += space.slice(last, match.index) + (replace ? replacement(match) : match[0])
              last = match.index + match[0].length
              previous = last
              position = match[0] === '' ? last + 1 : last
              if (count >= target && !command.global) break
            }
            result += space.slice(last)
            if (changed) {
              substituted = true
              space = result
              if (command.print) emit(space)
              if (command.file)
                writes.set(command.file, (writes.get(command.file) ?? '') + space + '\n')
            }
            break
          }
          case 'y': {
            const from = [...command.source!]
            const to = [...command.target!]
            space = [...space]
              .map((c) => {
                const position = from.indexOf(c)
                return position < 0 ? c : to[position]
              })
              .join('')
            break
          }
          case 'p':
            emit(space)
            break
          case 'P':
            emit(space.split('\n')[0])
            break
          case 'd':
            deleted = true
            pc = commands.length
            break
          case 'D':
            if (!space.includes('\n')) {
              deleted = true
              pc = commands.length
            } else {
              space = space.slice(space.indexOf('\n') + 1)
              restart = true
              pc = commands.length
            }
            break
          case 'n':
            if (!quiet) emit(space)
            await fill()
            if (isLast()) {
              deleted = true
              pc = commands.length
              break
            }
            space = input[index++]
            lineNumber++
            break
          case 'N':
            await fill()
            if (isLast()) {
              pc = commands.length
              break
            }
            space = grow(space + '\n' + input[index++], space.length)
            lineNumber++
            break
          case 'g':
            space = hold
            break
          case 'G':
            space = grow(space + '\n' + hold, space.length)
            break
          case 'h':
            hold = space
            break
          case 'H':
            hold = grow(hold + '\n' + space, hold.length)
            break
          case 'x':
            ;[space, hold] = [hold, space]
            break
          case 'a':
            appended += command.text + '\n'
            break
          case 'i':
            out += command.text + '\n'
            break
          case 'c':
            if (!command.range || !command.range.active) out += command.text + '\n'
            deleted = true
            pc = commands.length
            break
          case '=':
            out += lineNumber + '\n'
            break
          case 'l':
            out += JSON.stringify(space).slice(1, -1).replace(/\\"/g, '"') + '$\n'
            break
          case 'z':
            space = ''
            break
          case 'F':
            out += '-\n'
            break
          case 'r':
          case 'R':
            appended += await ctx.fs.read(ctx.resolve(command.file!)).then(decode, () => '')
            break
          case 'w':
          case 'W':
            writes.set(
              command.file!,
              (writes.get(command.file!) ?? '') +
                (command.name === 'W' ? space.split('\n')[0] : space) +
                '\n',
            )
            break
          case 'b':
            pc = command.label ? labels.get(command.label)! : commands.length
            break
          case 't':
            if (substituted) {
              substituted = false
              pc = command.label ? labels.get(command.label)! : commands.length
            }
            break
          case 'T':
            if (!substituted) pc = command.label ? labels.get(command.label)! : commands.length
            else substituted = false
            break
          case 'q':
            quit = true
            exitCode = command.code ?? 0
            pc = commands.length
            break
          case 'Q':
            quit = true
            exitCode = command.code ?? 0
            deleted = true
            pc = commands.length
            break
        }
      }
      if (!deleted && !restart && !quiet)
        out += space + (isLast() && !trailing && !appended ? '' : separator)
      out += appended
      if (out.length > 65536) {
        chunks.push(out)
        out = ''
      }
      if (chunks.length) {
        await write(chunks.join(''))
        chunks.length = 0
      }
      if (restart && !quit) {
        input[--index] = space
        lineNumber--
      }
    }
    chunks.push(out)
    await write(chunks.join(''))
  }
  const whole = (text: string) => {
    let done = false
    return async () => {
      if (done) return null
      done = true
      return text
    }
  }
  let status = 0
  if (inPlace) {
    for (const operand of operands) {
      const path = ctx.resolve(operand)
      try {
        const original = decode(await ctx.fs.read(path))
        let result = ''
        await run(whole(original), async (text) => void (result += text))
        quit = false
        if (suffix)
          await ctx.fs.write(
            suffix.includes('*')
              ? ctx.resolve(suffix.replace(/\*/g, operand.split('/').pop()!))
              : path + suffix,
            encode(original),
          )
        await ctx.fs.write(path, encode(result))
      } catch (error) {
        if (!(error instanceof FsError)) throw error
        ctx.stderr.write("sed: can't read " + operand + ': No such file or directory\n')
        status = 2
      }
    }
  } else {
    const inputs = operands.length ? operands : ['-']
    let i = 0
    let stream: (() => Promise<string | null>) | undefined
    let ending = ''
    const read = async (): Promise<string | null> => {
      for (;;) {
        if (stream) {
          const chunk = await stream()
          if (chunk !== null) {
            if (chunk) ending = chunk
            return chunk
          }
          stream = undefined
          if (ending && !ending.endsWith('\n') && i < inputs.length) {
            ending = '\n'
            return '\n'
          }
          continue
        }
        if (i >= inputs.length) return null
        const operand = inputs[i++]
        ending = ''
        if (operand === '-') {
          const input = ctx.stdin
          stream = () => input.chunk()
          continue
        }
        try {
          stream = whole(decode(await ctx.fs.read(ctx.resolve(operand))))
        } catch (error) {
          if (!(error instanceof FsError)) throw error
          ctx.stderr.write("sed: can't read " + operand + ': No such file or directory\n')
          status = 2
        }
      }
    }
    await run(read, (text) => put(ctx, text))
  }
  for (const [file, content] of writes) {
    if (file === '/dev/stdout') ctx.stdout.write(content)
    else await ctx.fs.write(ctx.resolve(file), encode(content))
  }
  return exitCode || status
})

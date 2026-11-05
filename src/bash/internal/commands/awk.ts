import {
  CommandError,
  budget,
  flatten,
  streaming,
  type CommandContext,
  type CommandHandler,
  type Limits,
} from '../Shell.ts'
import { FsError } from '../../FileSystem.ts'
import { decode, encode } from '../Fs.ts'
import { CLASSES, format, formatNumber } from '../Text.ts'
import { strftime } from './text.ts'
import { batches, pause } from './util.ts'

type Token = { type: string; value: string; line: number }

const KEYWORDS = new Set([
  'BEGIN',
  'END',
  'function',
  'if',
  'else',
  'while',
  'for',
  'do',
  'break',
  'continue',
  'next',
  'nextfile',
  'exit',
  'return',
  'delete',
  'in',
  'getline',
  'print',
  'printf',
])
const BUILTINS = new Set([
  'length',
  'substr',
  'index',
  'split',
  'sub',
  'gsub',
  'match',
  'sprintf',
  'sin',
  'cos',
  'atan2',
  'exp',
  'log',
  'sqrt',
  'int',
  'rand',
  'srand',
  'tolower',
  'toupper',
  'system',
  'close',
  'fflush',
  'systime',
  'strftime',
  'mktime',
])
const ARITY: Record<string, [number, number]> = {
  substr: [2, 3],
  index: [2, 2],
  sprintf: [1, 255],
  sin: [1, 1],
  cos: [1, 1],
  atan2: [2, 2],
  exp: [1, 1],
  log: [1, 1],
  int: [1, 1],
  sqrt: [1, 1],
  rand: [0, 0],
  srand: [0, 1],
  close: [1, 1],
  system: [1, 1],
  toupper: [1, 1],
  tolower: [1, 1],
  fflush: [0, 1],
  systime: [0, 0],
  mktime: [1, 1],
  strftime: [0, 3],
}
const PUNCT = [
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '^=',
  '==',
  '<=',
  '>=',
  '!=',
  '++',
  '--',
  '&&',
  '||',
  '>>',
  '!~',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ';',
  ',',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '!',
  '>',
  '<',
  '|',
  '?',
  ':',
  '~',
  '$',
  '=',
]

class AwkError extends Error {}

const ASCII = /^[^\u0080-\uffff]*$/

function binary(data: Uint8Array): string {
  let out = ''
  for (let i = 0; i < data.length; i += 8192)
    out += String.fromCharCode.apply(null, data.subarray(i, i + 8192) as unknown as number[])
  return out
}

function bytes(text: string): string {
  return ASCII.test(text) ? text : binary(encode(text))
}

function raw(text: string): Uint8Array {
  const data = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i)
  return data
}

function chars(text: string): string {
  return ASCII.test(text) ? text : decode(raw(text))
}

function runaway(head: string, rest: string): AwkError {
  const end = rest.indexOf('\n')
  return new AwkError(head + rest.slice(0, end < 0 ? undefined : end).slice(0, 10) + ' ...')
}

function lex(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  let parens = 0
  const operand = () => {
    const last = tokens[tokens.length - 1]
    if (!last) return false
    return (
      ['number', 'string', 'regex', 'name', 'builtin'].includes(last.type) ||
      ([')', ']', '$', '++', '--'].includes(last.value) && last.type === 'punct')
    )
  }
  while (i < source.length) {
    const c = source[i]
    if (c === '\\' && source[i + 1] === '\n') {
      i += 2
      line++
      continue
    }
    if (c === '\\' && source[i + 1] === '\r' && source[i + 2] === '\n') {
      i += 3
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
    if (c === '\n') {
      tokens.push({ type: 'newline', value: '\n', line: line++ })
      i++
      continue
    }
    if (c === '"') {
      let value = ''
      const start = line
      const from = ++i
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\n')
          throw runaway('line ' + start + ': runaway string constant "', source.slice(from))
        if (source[i] === '\\' && i + 1 < source.length) {
          const n = source[++i]
          const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            '"': '"',
            a: '\x07',
            b: '\b',
            f: '\f',
            v: '\v',
          }
          if (n in map) value += map[n]
          else if (/[0-7]/.test(n)) {
            const oct = source.slice(i).match(/^[0-7]{1,3}/)![0]
            value += String.fromCharCode(parseInt(oct, 8) & 0xff)
            i += oct.length - 1
          } else if (n === 'x' && /[0-9a-fA-F]/.test(source[i + 1] ?? '')) {
            const hex = source.slice(i + 1).match(/^[0-9a-fA-F]{1,2}/)![0]
            value += String.fromCharCode(parseInt(hex, 16))
            i += hex.length
          } else if (n === '\n') line++
          else value += '\\' + n
          i++
          continue
        }
        value += source[i++]
      }
      if (i >= source.length)
        throw runaway('line ' + start + ': runaway string constant "', source.slice(from))
      i++
      tokens.push({ type: 'string', value, line })
      continue
    }
    if (c === '/' && !operand()) {
      let value = ''
      const from = ++i
      let boxed = 0
      let first = -1
      while (i < source.length && (source[i] !== '/' || boxed)) {
        if (source[i] === '\n')
          throw runaway('line ' + line + ': runaway regular expression /', source.slice(from))
        if (source[i] === '\\' && i + 1 < source.length) {
          if (source[i + 1] !== '\n') value += source[i + 1] === '/' ? '/' : source.slice(i, i + 2)
          i += 2
          continue
        }
        if (source[i] === '^' && value.length === first && value[first - 1] === '[')
          first = value.length + 1
        else if (source[i] === '[') {
          if (!boxed++) first = value.length + 1
          else if (source[i + 1] !== ':') boxed--
        } else if (source[i] === ']' && boxed && value.length !== first) boxed--
        value += source[i++]
      }
      if (i >= source.length)
        throw runaway('line ' + line + ': runaway regular expression /', source.slice(from))
      i++
      tokens.push({ type: 'regex', value, line })
      continue
    }
    const number = source.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/)
    if (number) {
      const n = Number(number[0])
      if (!Number.isFinite(n) || (n === 0 ? /[1-9]/.test(number[1]) : n < SMALLEST))
        throw new AwkError(
          'line ' + line + ': ' + number[0] + ' : decimal ' + (n === 0 ? 'under' : 'over') + 'flow',
        )
      tokens.push({ type: 'number', value: number[0], line })
      i += number[0].length
      continue
    }
    const name = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)
    if (name) {
      const word = name[0]
      i += word.length
      if (KEYWORDS.has(word)) tokens.push({ type: word, value: word, line })
      else if (BUILTINS.has(word)) tokens.push({ type: 'builtin', value: word, line })
      else if (source[i] === '(') tokens.push({ type: 'funcname', value: word, line })
      else tokens.push({ type: 'name', value: word, line })
      continue
    }
    const punct = PUNCT.find((p) => source.startsWith(p, i))
    if (!punct) {
      const code = c.charCodeAt(0)
      throw new AwkError(
        line +
          ': unexpected character ' +
          (code > 32 && code < 127 ? "'" + c + "'" : '0x' + code.toString(16).padStart(2, '0')),
      )
    }
    if (punct === '(') parens++
    else if (punct === ')' && !parens--) throw new AwkError('line ' + line + ": extra ')'")
    tokens.push({ type: 'punct', value: punct, line })
    i += punct.length
  }
  tokens.push({ type: 'eof', value: '', line: line + 1 })
  return tokens
}

type Expr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 're'; v: RegExp }
  | { k: 'var'; name: string }
  | { k: 'field'; index: Expr }
  | { k: 'index'; name: string; subs: Expr[] }
  | { k: 'assign'; op: string; target: Expr; value: Expr }
  | { k: 'cond'; test: Expr; yes: Expr; no: Expr }
  | { k: 'bin'; op: string; left: Expr; right: Expr }
  | { k: 'and' | 'or'; left: Expr; right: Expr }
  | { k: 'not' | 'neg' | 'plus'; e: Expr }
  | { k: 'match'; negate: boolean; left: Expr; right: Expr }
  | { k: 'in'; subs: Expr[]; name: string }
  | { k: 'incr'; prefix: boolean; op: string; target: Expr }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'builtin'; name: string; args: Expr[] }
  | { k: 'group'; list: Expr[] }
  | { k: 'getline'; target?: Expr; file?: Expr; command?: Expr }
  | { k: 'concat'; left: Expr; right: Expr }

type Stmt =
  | { k: 'expr'; e: Expr }
  | { k: 'print' | 'printf'; args: Expr[]; redirect?: { op: string; target: Expr } }
  | { k: 'if'; test: Expr; yes: Stmt; no?: Stmt }
  | { k: 'while'; test: Expr; body: Stmt }
  | { k: 'do'; test: Expr; body: Stmt }
  | { k: 'for'; init?: Stmt; test?: Expr; step?: Stmt; body: Stmt }
  | { k: 'forin'; name: string; array: string; body: Stmt }
  | { k: 'block'; body: Stmt[] }
  | { k: 'next' | 'nextfile' | 'break' | 'continue' }
  | { k: 'exit' | 'return'; e?: Expr }
  | { k: 'delete'; name: string; subs?: Expr[] }

type Rule = { pattern?: Expr; end?: Expr; action?: Stmt[]; active: boolean }

type Program = {
  begin: Stmt[][]
  end: Stmt[][]
  rules: Rule[]
  functions: Map<string, { params: string[]; body: Stmt[] }>
}

class Parser {
  tokens: Token[]
  pos = 0
  loops = 0
  scope = 'main'
  calls: { name: string; count: number; line: number }[] = []
  types = new Map<string, string>()
  params: string[] = []
  bare = -1

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]
  }

  is(value: string, type = 'punct'): boolean {
    const token = this.peek()
    return token.type === type && token.value === value
  }

  take(value: string, type = 'punct'): Token {
    if (!this.is(value, type)) this.fail()
    return this.tokens[this.pos++]
  }

  fail(): never {
    const token = this.peek()
    const near =
      token.type === 'eof'
        ? 'end of file'
        : token.type === 'newline'
          ? 'end of line'
          : token.type === 'regex'
            ? '/' + token.value + '/'
            : token.value
    let parens = 0
    let braces = 0
    for (let i = 0; i < this.pos; i++) {
      const value = this.tokens[i].type === 'punct' ? this.tokens[i].value : ''
      if (value === '(') parens++
      else if (value === ')') parens--
      else if (value === '{') braces++
      else if (value === '}') braces--
    }
    if (
      parens > 0 &&
      (token.type === 'eof' || token.type === 'newline' || this.is(';') || this.is('}'))
    )
      this.error(token, 'missing ) near ' + near)
    if (braces > 0 && (token.type === 'eof' || token.type === 'BEGIN' || token.type === 'END'))
      this.error(token, 'missing } near ' + near)
    this.error(token, 'syntax error at or near ' + near)
  }

  error(token: Token, message: string): never {
    throw new AwkError('line ' + token.line + ': ' + message)
  }

  use(token: Token, kind: string) {
    if (this.params.includes(token.value)) return
    const known = this.types.get(token.value)
    if (known && known !== kind)
      this.error(
        token,
        'illegal reference to ' + (known === 'array' ? 'array ' : 'variable ') + token.value,
      )
    this.types.set(token.value, kind)
  }

  argument(): Expr {
    this.bare = this.pos
    return this.expr()
  }

  newlines() {
    while (this.peek().type === 'newline') this.pos++
  }

  terminators() {
    while (this.peek().type === 'newline' || this.is(';')) this.pos++
  }

  program(): Program {
    const program: Program = { begin: [], end: [], rules: [], functions: new Map() }
    this.terminators()
    while (this.peek().type !== 'eof') {
      const token = this.peek()
      if (this.is('}')) {
        const next = this.peek(1)
        if (next.type !== 'eof' && next.type !== 'newline') this.error(token, "extra '}'")
        this.error(
          token,
          "extra '}'\nawk: line " + token.line + ': syntax error at or near end of line',
        )
      }
      if (token.type === 'BEGIN') {
        this.pos++
        this.newlines()
        this.scope = 'begin'
        program.begin.push(this.block())
      } else if (token.type === 'END') {
        this.pos++
        this.newlines()
        this.scope = 'end'
        program.end.push(this.block())
      } else if (token.type === 'function') {
        this.pos++
        const name = this.peek()
        if (name.type !== 'funcname' && name.type !== 'name') this.fail()
        if (program.functions.has(name.value)) this.error(name, 'redefinition of ' + name.value)
        this.pos++
        this.take('(')
        const params: string[] = []
        while (!this.is(')')) {
          const param = this.peek()
          if (param.type !== 'name') this.fail()
          if (params.includes(param.value))
            this.error(param, param.value + ' is duplicated in argument list')
          params.push(param.value)
          this.pos++
          if (this.is(',')) {
            this.pos++
            this.newlines()
          }
        }
        this.take(')')
        this.newlines()
        this.scope = 'function'
        this.params = params
        program.functions.set(name.value, { params, body: this.block() })
        this.params = []
      } else {
        const rule: Rule = { active: false }
        if (!this.is('{')) {
          rule.pattern = this.expr()
          if (this.is(',')) {
            this.pos++
            this.newlines()
            rule.end = this.expr()
          }
        }
        if (this.is('{')) rule.action = this.block()
        program.rules.push(rule)
      }
      this.scope = 'main'
      this.terminators()
    }
    const line = this.peek().line
    const errors = [...this.calls]
      .reverse()
      .map((call) => {
        const fn = program.functions.get(call.name)
        if (!fn) return 'line ' + line + ': function ' + call.name + ' never defined'
        if (call.count > fn.params.length)
          return 'line ' + call.line + ': too many arguments in call to ' + call.name
        return ''
      })
      .filter(Boolean)
    if (errors.length) throw new AwkError(errors.join('\nawk: '))
    return program
  }

  block(): Stmt[] {
    this.take('{')
    const body: Stmt[] = []
    this.terminators()
    while (!this.is('}')) {
      if (this.peek().type === 'eof') this.fail()
      body.push(this.statement())
      this.terminators()
    }
    this.take('}')
    return body
  }

  end() {
    if (this.is(';') || this.peek().type === 'newline') {
      this.pos++
      return
    }
    if (this.is('}') || this.peek().type === 'eof') return
    this.fail()
  }

  body(): Stmt {
    this.newlines()
    if (this.is(';')) {
      this.pos++
      return { k: 'block', body: [] }
    }
    return this.statement()
  }

  loop(): Stmt {
    this.loops++
    try {
      return this.body()
    } finally {
      this.loops--
    }
  }

  statement(): Stmt {
    const token = this.peek()
    if (this.is('{')) return { k: 'block', body: this.block() }
    switch (token.type) {
      case 'if': {
        this.pos++
        this.take('(')
        const test = this.expr()
        this.take(')')
        const yes = this.body()
        const save = this.pos
        this.terminators()
        if (this.peek().type === 'else') {
          this.pos++
          return { k: 'if', test, yes, no: this.body() }
        }
        this.pos = save
        return { k: 'if', test, yes }
      }
      case 'while': {
        this.pos++
        this.take('(')
        const test = this.expr()
        this.take(')')
        if (this.is(';')) {
          this.pos++
          return { k: 'while', test, body: { k: 'block', body: [] } }
        }
        return { k: 'while', test, body: this.loop() }
      }
      case 'do': {
        this.pos++
        const body = this.loop()
        this.terminators()
        this.take('while', 'while')
        this.take('(')
        const test = this.expr()
        this.take(')')
        this.end()
        return { k: 'do', test, body }
      }
      case 'for': {
        this.pos++
        this.take('(')
        if (
          this.peek().type === 'name' &&
          this.peek(1).type === 'in' &&
          this.peek(2).type === 'name' &&
          this.peek(3).value === ')'
        ) {
          const name = this.peek().value
          const array = this.peek(2).value
          this.use(this.peek(), 'scalar')
          this.use(this.peek(2), 'array')
          this.pos += 4
          return { k: 'forin', name, array, body: this.loop() }
        }
        const init = this.is(';') ? undefined : this.simple()
        this.take(';')
        this.newlines()
        const test = this.is(';') ? undefined : this.expr()
        this.take(';')
        this.newlines()
        const step = this.is(')') ? undefined : this.simple()
        this.take(')')
        return { k: 'for', init, test, step, body: this.loop() }
      }
      case 'next':
      case 'nextfile':
      case 'break':
      case 'continue':
        if ((token.type === 'break' || token.type === 'continue') && !this.loops)
          this.error(token, token.type + ' statement outside of loop')
        if ((token.type === 'next' || token.type === 'nextfile') && this.scope !== 'main')
          this.error(token, 'improper use of ' + token.type)
        this.pos++
        this.end()
        return { k: token.type }
      case 'exit':
      case 'return': {
        if (token.type === 'return' && this.scope !== 'function')
          this.error(token, 'return outside function body')
        this.pos++
        const e =
          this.is(';') ||
          this.is('}') ||
          this.peek().type === 'newline' ||
          this.peek().type === 'eof'
            ? undefined
            : this.expr()
        this.end()
        return { k: token.type, e }
      }
      case 'delete': {
        this.pos++
        const name = this.peek()
        if (name.type !== 'name') this.fail()
        this.use(name, 'array')
        this.pos++
        let subs: Expr[] | undefined
        if (this.is('[')) {
          this.pos++
          subs = this.list(']')
          this.take(']')
        }
        this.end()
        return { k: 'delete', name: name.value, subs }
      }
    }
    const statement = this.simple()
    this.end()
    return statement
  }

  simple(): Stmt {
    const token = this.peek()
    if (token.type === 'print' || token.type === 'printf') {
      this.pos++
      let args: Expr[] = []
      if (this.is('(')) {
        const save = this.pos
        this.pos++
        const list = this.list(')')
        if (this.is(')')) {
          this.pos++
          const next = this.peek()
          if (
            next.type === 'newline' ||
            next.type === 'eof' ||
            (next.type === 'punct' && [';', '}', '>', '>>', '|'].includes(next.value))
          )
            args = list
          else this.pos = save
        } else this.pos = save
        if (this.pos === save) args = this.list('', true)
      } else if (
        !(
          this.is(';') ||
          this.is('}') ||
          this.is('>') ||
          this.is('>>') ||
          this.is('|') ||
          this.peek().type === 'newline' ||
          this.peek().type === 'eof'
        )
      )
        args = this.list('', true)
      let redirect: { op: string; target: Expr } | undefined
      if (this.is('>') || this.is('>>') || this.is('|')) {
        const op = this.tokens[this.pos++].value
        redirect = { op, target: this.concat(true) }
      }
      if (token.type === 'printf' && !args.length)
        this.error(token, 'no arguments in call to printf')
      return { k: token.type, args, redirect }
    }
    return { k: 'expr', e: this.expr() }
  }

  list(close: string, noGt = false): Expr[] {
    const list: Expr[] = []
    this.newlines()
    if (close && this.is(close)) return list
    for (;;) {
      list.push(this.expr(noGt))
      if (!this.is(',')) break
      this.pos++
      this.newlines()
    }
    if (close) this.newlines()
    return list
  }

  expr(noGt = false): Expr {
    return this.ternary(noGt)
  }

  ternary(noGt: boolean): Expr {
    const left = this.or(noGt)
    if (
      this.peek().type === 'punct' &&
      ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(this.peek().value) &&
      (left.k === 'var' || left.k === 'field' || left.k === 'index')
    ) {
      const op = this.tokens[this.pos++].value
      this.newlines()
      return { k: 'assign', op, target: left, value: this.ternary(noGt) }
    }
    if (this.is('?')) {
      this.pos++
      this.newlines()
      const yes = this.ternary(noGt)
      this.newlines()
      this.take(':')
      this.newlines()
      return { k: 'cond', test: left, yes, no: this.ternary(noGt) }
    }
    return left
  }

  or(noGt: boolean): Expr {
    let left = this.and(noGt)
    while (this.is('||')) {
      this.pos++
      this.newlines()
      left = { k: 'or', left, right: this.and(noGt) }
    }
    return left
  }

  and(noGt: boolean): Expr {
    let left = this.inExpr(noGt)
    while (this.is('&&')) {
      this.pos++
      this.newlines()
      left = { k: 'and', left, right: this.inExpr(noGt) }
    }
    return left
  }

  inExpr(noGt: boolean): Expr {
    let left = this.match(noGt)
    while (this.peek().type === 'in') {
      this.pos++
      const name = this.peek()
      if (name.type !== 'name') this.fail()
      this.use(name, 'array')
      this.pos++
      left = { k: 'in', subs: left.k === 'group' ? left.list : [left], name: name.value }
    }
    return left
  }

  match(noGt: boolean): Expr {
    let left = this.relation(noGt)
    while (this.is('~') || this.is('!~')) {
      const negate = this.tokens[this.pos++].value === '!~'
      const token = this.peek()
      left = { k: 'match', negate, left, right: this.pattern(this.relation(noGt), token) }
    }
    return left
  }

  pattern(e: Expr, token: Token, split = false): Expr {
    if (e.k !== 'str' || (split && e.v.length < 2)) return e
    try {
      return { k: 're', v: regex(e.v) }
    } catch (error) {
      if (error instanceof AwkError) this.error(token, error.message)
      throw error
    }
  }

  relation(noGt: boolean): Expr {
    let left = this.concat(noGt)
    for (;;) {
      const token = this.peek()
      if (token.type === 'punct' && token.value === '|' && this.peek(1).type === 'getline') {
        this.pos += 2
        const target = this.optionalLvalue()
        left = { k: 'getline', command: left, target }
        continue
      }
      if (
        token.type === 'punct' &&
        ['<', '<=', '==', '!=', '>=', '>'].includes(token.value) &&
        !(noGt && token.value === '>')
      ) {
        this.pos++
        left = { k: 'bin', op: token.value, left, right: this.concat(noGt) }
        continue
      }
      return left
    }
  }

  startsOperand(): boolean {
    const token = this.peek()
    if (['number', 'string', 'regex', 'name', 'funcname', 'builtin'].includes(token.type))
      return true
    if (token.type === 'punct' && ['$', '(', '!', '++', '--', '-', '+'].includes(token.value))
      return token.value !== '-' && token.value !== '+' && token.value !== '!'
    return false
  }

  concat(_noGt: boolean): Expr {
    let left = this.additive()
    while (this.startsOperand()) left = { k: 'concat', left, right: this.additive() }
    return left
  }

  additive(): Expr {
    let left = this.multiplicative()
    while (this.is('+') || this.is('-')) {
      const op = this.tokens[this.pos++].value
      left = { k: 'bin', op, left, right: this.multiplicative() }
    }
    return left
  }

  multiplicative(): Expr {
    let left = this.unary()
    while (this.is('*') || this.is('/') || this.is('%')) {
      const op = this.tokens[this.pos++].value
      left = { k: 'bin', op, left, right: this.unary() }
    }
    return left
  }

  unary(): Expr {
    if (this.is('!')) {
      this.pos++
      return { k: 'not', e: this.unary() }
    }
    if (this.is('-')) {
      this.pos++
      return { k: 'neg', e: this.unary() }
    }
    if (this.is('+')) {
      this.pos++
      return { k: 'plus', e: this.unary() }
    }
    return this.power()
  }

  power(): Expr {
    const base = this.postfix()
    if (this.is('^')) {
      this.pos++
      const exponent = this.is('-') || this.is('+') || this.is('!') ? this.unary() : this.power()
      return { k: 'bin', op: '^', left: base, right: exponent }
    }
    return base
  }

  postfix(): Expr {
    const e = this.primary()
    if ((this.is('++') || this.is('--')) && (e.k === 'var' || e.k === 'field' || e.k === 'index')) {
      const op = this.tokens[this.pos++].value
      return { k: 'incr', prefix: false, op, target: e }
    }
    return e
  }

  optionalLvalue(): Expr | undefined {
    const token = this.peek()
    if (token.type === 'name') return this.primary()
    if (token.type === 'punct' && token.value === '$') return this.primary()
    return undefined
  }

  primary(): Expr {
    const token = this.peek()
    switch (token.type) {
      case 'number':
        this.pos++
        return {
          k: 'num',
          v:
            token.value.startsWith('0x') || token.value.startsWith('0X')
              ? parseInt(token.value, 16)
              : Number(token.value),
        }
      case 'string':
        this.pos++
        return { k: 'str', v: token.value }
      case 'regex': {
        this.pos++
        try {
          return { k: 're', v: regex(token.value) }
        } catch (error) {
          if (error instanceof AwkError) this.error(token, error.message)
          throw error
        }
      }
      case 'name': {
        const start = this.pos++
        if (this.is('[')) {
          this.use(token, 'array')
          this.pos++
          const subs = this.list(']')
          this.take(']')
          return { k: 'index', name: token.value, subs }
        }
        if (start !== this.bare || !(this.is(',') || this.is(')'))) this.use(token, 'scalar')
        return { k: 'var', name: token.value }
      }
      case 'funcname': {
        this.pos++
        this.take('(')
        const args: Expr[] = []
        this.newlines()
        while (!this.is(')')) {
          args.push(this.argument())
          if (!this.is(',')) break
          this.pos++
          this.newlines()
        }
        this.newlines()
        this.take(')')
        this.calls.push({ name: token.value, count: args.length, line: token.line })
        return { k: 'call', name: token.value, args }
      }
      case 'builtin': {
        this.pos++
        const name = token.value
        if (name === 'length') {
          if (!this.is('(')) return { k: 'builtin', name, args: [] }
          this.pos++
          const args = this.is(')') ? [] : [this.argument()]
          this.take(')')
          return { k: 'builtin', name, args }
        }
        this.take('(')
        if (name === 'split' || name === 'sub' || name === 'gsub' || name === 'match') {
          const args = [this.expr()]
          this.newlines()
          this.take(',')
          this.newlines()
          const target = this.peek()
          if (name === 'split' && target.type !== 'name') this.fail()
          args.push(name === 'split' ? this.argument() : this.expr())
          if (name === 'split') this.use(target, 'array')
          if (name !== 'match' && this.is(',')) {
            this.pos++
            this.newlines()
            args.push(this.expr())
          }
          this.newlines()
          this.take(')')
          if (name === 'match') args[1] = this.pattern(args[1], token)
          else if (name !== 'split') args[0] = this.pattern(args[0], token)
          else if (args[2]) args[2] = this.pattern(args[2], token, true)
          return { k: 'builtin', name, args }
        }
        const args = this.list(')')
        this.take(')')
        const [min, max] = ARITY[name] ?? [0, 255]
        if (args.length < min || args.length > max)
          this.error(token, 'wrong number of arguments in call to ' + name)
        return { k: 'builtin', name, args }
      }
      case 'getline': {
        this.pos++
        const target = this.optionalLvalue()
        if (this.is('<')) {
          this.pos++
          return { k: 'getline', target, file: this.primary() }
        }
        return { k: 'getline', target }
      }
    }
    if (token.type === 'punct') {
      if (token.value === '$') {
        this.pos++
        if (this.is('++') || this.is('--')) {
          const op = this.tokens[this.pos++].value
          return { k: 'field', index: { k: 'incr', prefix: true, op, target: this.primary() } }
        }
        if (this.is('-')) {
          this.pos++
          return { k: 'field', index: { k: 'neg', e: this.primary() } }
        }
        return { k: 'field', index: this.primary() }
      }
      if (token.value === '++' || token.value === '--') {
        this.pos++
        const target = this.primary()
        if (target.k !== 'var' && target.k !== 'field' && target.k !== 'index') this.fail()
        return { k: 'incr', prefix: true, op: token.value, target }
      }
      if (token.value === '(') {
        this.pos++
        const list = this.list(')')
        this.take(')')
        if (list.length === 1) return { k: 'group', list }
        if (this.peek().type !== 'in') this.fail()
        return { k: 'group', list }
      }
      if (token.value === '-') {
        this.pos++
        return { k: 'neg', e: this.primary() }
      }
      if (token.value === '!') {
        this.pos++
        return { k: 'not', e: this.primary() }
      }
    }
    this.fail()
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  f: '\f',
  b: '\b',
  r: '\r',
  a: '\x07',
  v: '\v',
}

function unescape(source: string, i: number): [string, number] {
  const c = source[i]
  if (c === undefined) return ['\\', i]
  if (c in SIMPLE_ESCAPES) return [SIMPLE_ESCAPES[c], i + 1]
  const octal = /^[0-7]{1,3}/.exec(source.slice(i))
  if (octal) return [String.fromCharCode(parseInt(octal[0], 8) & 0xff), i + octal[0].length]
  if (c === 'x') {
    const hex = /^[0-9a-fA-F]{1,2}/.exec(source.slice(i + 1))
    return hex ? [String.fromCharCode(parseInt(hex[0], 16)), i + 1 + hex[0].length] : ['x', i + 1]
  }
  return [c, i + 1]
}

function literal(c: string, inClass = false): string {
  return (inClass ? /[\\\][^-]/ : /[\\^$.|?*+()[\]{}/]/).test(c) ? '\\' + c : c
}

function bracket(source: string, start: number): [string, number] {
  let p = start + 1
  if (source[p] === ']' || (source[p] === '[' && source[p + 1] !== ':')) p++
  else if (
    source[p] === '^' &&
    (source[p + 1] === ']' || (source[p + 1] === '[' && source[p + 2] !== ':'))
  )
    p += 2
  let q = p
  for (let level = 0; ; q++) {
    if (q >= source.length) throw new AwkError('bad class -- [], [^] or [')
    if (source[q] === '[' && source[q + 1] === ':') level++
    else if (source[q] === ']') {
      if (!level) break
      level--
    } else if (source[q] === '\\') q++
  }
  p = start + 1
  let out = '['
  if (source[p] === '^') {
    out += '^'
    p++
  }
  let prev = ''
  while (p < q) {
    const c = source[p]
    if (c === '\\') {
      ;[prev, p] = unescape(source, p + 1)
      out += literal(prev, true)
    } else if (c === '[' && source[p + 1] === ':') {
      const end = source.indexOf(':]', p + 2)
      out += CLASSES[source.slice(p + 2, end)] ?? ''
      p = end + 2
      prev = ''
    } else if (c === '-' && prev && p + 1 < q) {
      let [to, next] = [source[p + 1], p + 2]
      if (to === '\\') [to, next] = unescape(source, p + 2)
      if (prev <= to) {
        out += '-' + literal(to, true)
        prev = ''
        p = next
      } else {
        out += '\\-'
        prev = '-'
        p++
      }
    } else {
      prev = c
      out += literal(c, true)
      p++
    }
  }
  return [out + ']', q + 1]
}

function translate(source: string): string {
  let out = ''
  let atom = -1
  let small = false
  let quantified = false
  let anchor = false
  const groups: { start: number; literal: boolean; items: number; ops: boolean }[] = []
  const operator = () => {
    const group = groups[groups.length - 1]
    if (group) group.literal = !(group.ops = true)
  }
  const operand = (text: string, plain = false) => {
    const group = groups[groups.length - 1]
    if (group) {
      group.items++
      if (!plain) group.literal = false
    }
    atom = out.length
    out += text
    small = true
    quantified = anchor = false
  }
  for (let i = 0; i < source.length; ) {
    const c = source[i]
    if (c === '\\') {
      const [value, next] = unescape(source, i + 1)
      operand(literal(value), true)
      i = next
    } else if (c === '[') {
      const [text, next] = bracket(source, i)
      operand(text)
      i = next
    } else if (c === '.') {
      operand('[\\s\\S]')
      i++
    } else if (c === '(') {
      const group = groups[groups.length - 1]
      if (group) {
        group.items++
        group.literal = false
      }
      groups.push({ start: out.length, literal: true, items: 0, ops: false })
      out += '(?:'
      atom = -1
      anchor = false
      i++
    } else if (c === ')' && groups.length) {
      const group = groups.pop()!
      if (atom < 0) throw new AwkError('missing operand')
      out += ')'
      atom = group.start
      small = group.literal || (group.items === 1 && !group.ops)
      quantified = anchor = false
      i++
    } else if (c === '|') {
      if (atom < 0) throw new AwkError('missing operand')
      operator()
      out += '|'
      atom = -1
      anchor = false
      i++
    } else if (c === '*' || c === '+' || c === '?') {
      if (anchor && c !== '?') throw new AwkError('syntax error ^* or ^+')
      if (atom < 0) throw new AwkError('missing operand')
      if (quantified) out = out.slice(0, atom) + '(?:' + out.slice(atom) + ')'
      out += c
      quantified = true
      small = false
      operator()
      i++
    } else if (c === '{' && atom >= 0 && /^\{(\d*)(,(\d*))?\}/.test(source.slice(i))) {
      const [whole, low, comma, high] = /^\{(\d*)(,(\d*))?\}/.exec(source.slice(i))!
      const min = Number(low || 0)
      const max = comma ? (high ? Number(high) : -1) : min
      if ((!low && !high) || (max >= 0 && max < min)) throw new AwkError('bad interval expression')
      if (quantified) out = out.slice(0, atom) + '(?:' + out.slice(atom) + ')'
      out +=
        min < 2
          ? '{' + min + (max === min ? '' : ',' + (max < 0 ? '' : max)) + '}'
          : small
            ? '{' + min + '}'
            : '{1,' + (max < 0 ? '' : max) + '}'
      quantified = true
      small = false
      operator()
      i += whole.length
    } else if (c === '^' || c === '$') {
      operator()
      atom = out.length
      out += c
      quantified = true
      anchor = c === '^'
      i++
    } else {
      operand(literal(c), true)
      i++
    }
  }
  if (groups.length) throw new AwkError("missing ')'")
  if (atom < 0 && out) throw new AwkError('missing operand')
  return out
}

function regex(source: string): RegExp {
  try {
    return new RegExp(translate(source))
  } catch (error) {
    throw new AwkError(
      'regular expression compile failed (' +
        (error instanceof AwkError ? error.message : 'missing operand') +
        ')\n' +
        source,
    )
  }
}

class Strnum {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}

type Value = number | string | Strnum | undefined

class AwkArray extends Map<string, Value> {
  static limits: Limits | undefined
  parts: string[] | undefined

  fill(parts: string[]) {
    if (this.parts === undefined && super.size) super.clear()
    this.parts = parts
  }

  materialize() {
    const parts = this.parts
    if (!parts) return
    this.parts = undefined
    for (let i = 0; i < parts.length; i++)
      super.set(INDEXES[i] ?? String(i + 1), new Strnum(parts[i]))
  }

  position(key: string): number {
    const parts = this.parts!
    const n = +key
    if (!Number.isInteger(n) || n < 1 || n > parts.length || (INDEXES[n - 1] ?? String(n)) !== key)
      return -1
    return n - 1
  }

  override get(key: string): Value {
    if (!this.parts) return super.get(key)
    const i = this.position(key)
    return i < 0 ? undefined : new Strnum(this.parts[i])
  }

  override has(key: string): boolean {
    return this.parts ? this.position(key) >= 0 : super.has(key)
  }

  override set(key: string, value: Value): this {
    this.materialize()
    if ((super.size & 0xffff) === 0xffff && AwkArray.limits)
      budget(AwkArray.limits, 100 * super.size, 'awk: an array of ' + super.size + ' elements')
    return super.set(key, value)
  }

  override delete(key: string): boolean {
    this.materialize()
    return super.delete(key)
  }

  override clear() {
    this.parts = undefined
    super.clear()
  }

  override keys(): MapIterator<string> {
    this.materialize()
    return super.keys()
  }

  override values(): MapIterator<Value> {
    this.materialize()
    return super.values()
  }

  override entries(): MapIterator<[string, Value]> {
    this.materialize()
    return super.entries()
  }

  override forEach(
    callback: (value: Value, key: string, map: Map<string, Value>) => void,
    self?: unknown,
  ) {
    this.materialize()
    super.forEach(callback, self)
  }

  override [Symbol.iterator](): MapIterator<[string, Value]> {
    this.materialize()
    return super[Symbol.iterator]()
  }
}

const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!

Object.defineProperty(AwkArray.prototype, 'size', {
  get(this: AwkArray) {
    return this.parts ? this.parts.length : mapSize.call(this)
  },
})
type Cell = Value | Map<string, Value>

const NUMERIC = /^[ \t\n\v\f\r]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[ \t\n\v\f\r]*$/
const STRTOD =
  /^[ \t\n\v\f\r]*([+-]?)(?:0x(?=\.?[0-9a-f])([0-9a-f]*)(?:\.([0-9a-f]*))?(?:p([+-]?\d+))?|(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|(inf(?:inity)?|nan(?:\([0-9a-z_]*\))?))/i
const SMALLEST = 2.2250738585072014e-308

function strtod(text: string): [number, number] {
  const match = STRTOD.exec(text)
  if (!match) return [0, 0]
  const [whole, sign, int, fraction, exponent, decimal, special] = match
  const value =
    decimal !== undefined
      ? Number(decimal)
      : special !== undefined
        ? /^i/i.test(special)
          ? Infinity
          : NaN
        : (parseInt(int || '0', 16) +
            (fraction ? parseInt(fraction, 16) / 16 ** fraction.length : 0)) *
          2 ** Number(exponent ?? 0)
  return [sign === '-' ? -value : value, whole.length]
}

function looksNumeric(text: string): boolean {
  if (NUMERIC.test(text)) {
    const n = Number(text.trim())
    return n === 0
      ? !/[1-9]/.test(text.split(/[eE]/)[0])
      : Number.isFinite(n) && Math.abs(n) >= SMALLEST
  }
  const body = text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '')
  if (!/^[0-9+.-]/.test(body) || !/[0-9.]$/.test(body)) return false
  const [n, length] = strtod(body)
  return length === body.length && Number.isFinite(n)
}

function toNum(value: Value): number {
  if (typeof value === 'number') return value
  if (value === undefined) return 0
  const text = typeof value === 'string' ? value : value.text
  const first = text.charCodeAt(0)
  if (
    first >= 48 &&
    first <= 57 &&
    (first !== 48 || text.length === 1 || text.charCodeAt(1) === 46)
  ) {
    const quick = +text
    if (quick === quick) return quick
  }
  return strtod(text)[0]
}

function toInt(n: number): number {
  return n > -0x80000000 && n < 0x80000000 ? Math.trunc(n) : Number(BigInt.asIntN(32, toLong(n)))
}

const LONG = 2n ** 63n
const ULONG = 2n ** 64n - 1n

function toLong(n: number): bigint {
  if (n >= 2 ** 63) return LONG - 1n
  if (n < 0) return -n <= 2 ** 63 ? BigInt(Math.trunc(n)) : 1n - LONG
  return n === n ? BigInt(Math.trunc(n)) : -LONG
}

function toUlong(n: number): bigint {
  if (n >= 2 ** 64) return ULONG
  if (n < 0) return -n <= 2 ** 63 ? ULONG + 1n + BigInt(Math.trunc(n)) : -n < 2 ** 64 ? LONG : 1n
  return n === n ? BigInt(Math.trunc(n)) : LONG
}

function upper(text: string): string {
  return /[\xb5\xdf-\xff]/.test(text)
    ? text.replace(/[a-z]+/g, (letters) => letters.toUpperCase())
    : text.toUpperCase()
}

function lower(text: string): string {
  return /[\xc0-\xde]/.test(text)
    ? text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
    : text.toLowerCase()
}

function isNumberish(value: Value): boolean {
  if (typeof value === 'number' || value === undefined) return true
  if (value instanceof Strnum) return looksNumeric(value.text)
  return false
}

function truthy(value: Value): boolean {
  if (typeof value === 'number') return value !== 0
  if (value === undefined) return false
  if (typeof value === 'string') return value !== ''
  return looksNumeric(value.text) ? toNum(value) !== 0 : value.text !== ''
}

const INDEXES = Array.from({ length: 256 }, (_, i) => String(i + 1))

const FIELD0: Expr = { k: 'field', index: { k: 'num', v: 0 } }

class NextSignal {}
class NextFileSignal {}
class ExitSignal {
  readonly code: number
  constructor(code: number) {
    this.code = code
  }
}
class ReturnSignal {
  readonly value: Value
  constructor(value: Value) {
    this.value = value
  }
}
class LoopSignal {
  readonly kind: 'break' | 'continue'
  constructor(kind: 'break' | 'continue') {
    this.kind = kind
  }
}

type Conversion = {
  flags: string
  minimum: string
  digits: string | undefined
  size: string
  conv: string
  count: number
  plain: boolean
}

type Piece = string | Conversion

const CONVERSION = /%([-+ #0']*)(\*|\d*)(?:\.(\*|\d*))?([lh]*)([\s\S]?)/y

function compileFormat(spec: string): Piece[] {
  const pieces: Piece[] = []
  let literal = ''
  let count = 0
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i]
    if (c !== '%') {
      literal += c
      continue
    }
    count++
    if (spec[i + 1] === '%') {
      literal += '%'
      i++
      continue
    }
    CONVERSION.lastIndex = i
    const [whole, flags, width, precision, size, conv] = CONVERSION.exec(spec)!
    i += whole.length - 1
    if (literal) pieces.push(literal)
    literal = ''
    pieces.push({
      flags,
      minimum: width,
      digits: precision,
      size,
      conv,
      count,
      plain: whole.length === 2 && (conv === 's' || conv === 'd'),
    })
  }
  if (literal) pieces.push(literal)
  return pieces
}

type Field = {
  conv: string
  flags: string
  size?: string | undefined
  width?: number | undefined
  precision?: number | undefined
}

function padded(field: Field, body: string, prefix = ''): string {
  let width = field.width ?? 0
  let left = field.flags.includes('-')
  if (width < 0) {
    left = true
    width = -width
  }
  const fill = width - prefix.length - body.length
  if (fill <= 0) return prefix + body
  if (left) return prefix + body + ' '.repeat(fill)
  if (field.flags.includes('0') && /^[diouxX]$/.test(field.conv) && !((field.precision ?? -1) >= 0))
    return prefix + '0'.repeat(fill) + body
  return ' '.repeat(fill) + prefix + body
}

function formatText(text: string, field: Field): string {
  const precision = field.precision
  const body = precision === undefined ? text : precision < 0 ? '' : text.slice(0, precision)
  return (field.flags.includes(' ') && !body ? ' ' : '') + padded(field, body)
}

function formatInteger(value: bigint, field: Field): string {
  const { conv, flags, precision } = field
  const negative = value < 0n
  let digits = (negative ? -value : value).toString(
    conv === 'o' ? 8 : conv === 'x' || conv === 'X' ? 16 : 10,
  )
  if (conv === 'X') digits = digits.toUpperCase()
  if (precision !== undefined && precision >= 0)
    digits = precision === 0 && value === 0n ? '' : digits.padStart(precision, '0')
  if (conv === 'o' && flags.includes('#') && !digits.startsWith('0')) digits = '0' + digits
  const sign =
    conv === 'd' || conv === 'i'
      ? negative
        ? '-'
        : flags.includes('+')
          ? '+'
          : flags.includes(' ')
            ? ' '
            : ''
      : ''
  const prefix =
    sign + ((conv === 'x' || conv === 'X') && flags.includes('#') && value ? '0' + conv : '')
  return padded(field, digits, prefix)
}

function formatFloat(n: number, field: Field): string {
  const { conv, flags, width, precision } = field
  if (Number.isFinite(n)) {
    let spec = '%' + flags
    if (width !== undefined) spec += width < 0 ? '-' + -width : width
    if (precision !== undefined && precision >= 0) spec += '.' + precision
    return format(spec + conv, [n], false).text
  }
  const body = n !== n ? 'nan' : 'inf'
  const sign = n !== n || n < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : ''
  return padded(field, conv === 'E' || conv === 'G' ? body.toUpperCase() : body, sign)
}

type Fn = () => Value
type Run = () => number
type Sink = (text: string) => void

const BREAK = 1
const CONTINUE = 2
const RETURN = 3
const NEXT = 4

const COMPARISONS = new Set(['<', '<=', '>', '>=', '==', '!='])

function exprKids(e: Expr): Expr[] {
  switch (e.k) {
    case 'field':
      return [e.index]
    case 'index':
    case 'in':
      return e.subs
    case 'assign':
      return [e.target, e.value]
    case 'cond':
      return [e.test, e.yes, e.no]
    case 'bin':
    case 'and':
    case 'or':
    case 'match':
    case 'concat':
      return [e.left, e.right]
    case 'not':
    case 'neg':
    case 'plus':
      return [e.e]
    case 'incr':
      return [e.target]
    case 'call':
    case 'builtin':
      return e.args
    case 'group':
      return e.list
    case 'getline':
      return [e.target, e.file, e.command].filter((kid): kid is Expr => kid !== undefined)
    default:
      return []
  }
}

function stmtKids(s: Stmt): { stmts: Stmt[]; exprs: Expr[] } {
  switch (s.k) {
    case 'expr':
      return { stmts: [], exprs: [s.e] }
    case 'print':
    case 'printf':
      return { stmts: [], exprs: s.redirect ? [...s.args, s.redirect.target] : s.args }
    case 'if':
      return { stmts: s.no ? [s.yes, s.no] : [s.yes], exprs: [s.test] }
    case 'while':
    case 'do':
      return { stmts: [s.body], exprs: [s.test] }
    case 'for':
      return {
        stmts: [s.init, s.step, s.body].filter((kid): kid is Stmt => kid !== undefined),
        exprs: s.test ? [s.test] : [],
      }
    case 'forin':
      return { stmts: [s.body], exprs: [] }
    case 'block':
      return { stmts: s.body, exprs: [] }
    case 'exit':
    case 'return':
      return { stmts: [], exprs: s.e ? [s.e] : [] }
    case 'delete':
      return { stmts: [], exprs: s.subs ?? [] }
    default:
      return { stmts: [], exprs: [] }
  }
}

function substr(text: string, from: number, count?: number): string {
  const length = text.length
  let n = count === undefined ? length : toInt(count)
  let i = (toInt(from) - 1) | 0
  if (i > length) n = 0
  if (i < 0) {
    n = (n - i - 1) | 0
    i = 0
  }
  if (n > length - i) n = length - i
  return n <= 0 ? '' : text.slice(i, i + n)
}

class Interpreter {
  ctx: CommandContext
  program: Program
  globals = new Map<string, Cell>()
  frames: Map<string, Cell>[] = []
  fields: string[] = ['']
  count = 1
  nf = 0
  parsed = true
  offset = 0
  recordFS = ' '
  regexCache = new Map<string, RegExp>()
  formats = new Map<string, Piece[]>()
  globalCache = new WeakMap<RegExp, RegExp>()
  fastExprs = new Map<Expr, Fn>()
  fastStmts = new Map<Stmt, Run>()
  fastFns = new Map<string, Run>()
  asyncFns = new Set<string>()
  asyncMemo = new Map<Expr | Stmt, boolean>()
  returned: Value = undefined
  rules?: { rule: Rule; pattern: Fn | undefined; end: Fn | undefined; action: Run | undefined }[]
  outputs = new Map<string, { kind: 'file' | 'pipe'; text: string; append: boolean }>()
  readers = new Map<string, { lines: string[]; pos: number; status?: number }>()
  records: string[] | undefined
  source = ''
  cursor = 0
  buffer = ''
  advance?: () => Promise<boolean>
  open = false
  converting = false
  more?: () => Promise<string | null>
  skipped = false
  recordIndex = 0
  steps = 0
  depth = 0
  seed = 0
  exitCode = 0

  constructor(ctx: CommandContext, program: Program) {
    this.ctx = ctx
    this.program = program
    const set = (name: string, value: Value) => this.globals.set(name, value)
    set('FS', ' ')
    set('OFS', ' ')
    set('ORS', '\n')
    set('RS', '\n')
    set('NR', 0)
    set('NF', 0)
    set('FNR', 0)
    set('SUBSEP', '\x1c')
    set('CONVFMT', '%.6g')
    set('OFMT', '%.6g')
    set('FILENAME', '')
    const environ = new Map<string, Value>()
    for (const [key, value] of Object.entries(ctx.env))
      environ.set(bytes(key), new Strnum(bytes(value)))
    this.globals.set('ENVIRON', environ)
  }

  tick() {
    if (++this.steps % 1024 === 0 && this.ctx.signal.aborted)
      throw new CommandError('execution aborted', 124)
    if (this.steps > this.ctx.limits.maxCommands * 100)
      throw new CommandError('too many steps', 124)
  }

  str(value: Value, output = false): string {
    if (typeof value === 'string') return value
    if (value === undefined) return ''
    if (value instanceof Strnum) return value.text
    if (Number.isInteger(value)) {
      if (Math.abs(value) < 1e16) return String(value)
      if (value >= -(2 ** 63) && value <= 2 ** 64) {
        const big = BigInt(value)
        return String(big > ULONG ? ULONG : big)
      }
    }
    const fmt = this.str(this.scalar(output ? 'OFMT' : 'CONVFMT'))
    if (fmt !== '%.6g' && !this.converting) {
      this.converting = true
      try {
        return this.sprintf(fmt, { values: [value] })
      } finally {
        this.converting = false
      }
    }
    return Number.isFinite(value)
      ? formatNumber(value)
      : value !== value
        ? '-nan'
        : value < 0
          ? '-inf'
          : 'inf'
  }

  fatal(message: string): AwkError {
    const globals = this.globals
    return new AwkError(
      'run time error: ' +
        message +
        '\n\tFILENAME="' +
        this.str(globals.get('FILENAME') as Value) +
        '" FNR=' +
        Math.trunc(toNum(globals.get('FNR') as Value)) +
        ' NR=' +
        Math.trunc(toNum(globals.get('NR') as Value)),
    )
  }

  lookup(name: string): Map<string, Cell> {
    if (this.frames.length) {
      const frame = this.frames[this.frames.length - 1]
      if (frame.has(name)) return frame
    }
    return this.globals
  }

  scalar(name: string): Value {
    if (name === 'NF') {
      this.parse()
      return this.nf
    }
    const cell = this.lookup(name).get(name)
    if (cell instanceof Map)
      throw new AwkError('attempt to use array `' + name + "' in a scalar context")
    return cell
  }

  setScalar(name: string, value: Value) {
    if (name === 'NF') {
      const n = toInt(toNum(value))
      if (n < 0) throw this.fatal('negative value assigned to NF')
      this.setNF(n)
      return
    }
    const scope = this.lookup(name)
    if (scope.get(name) instanceof Map)
      throw new AwkError('attempt to use array `' + name + "' in a scalar context")
    scope.set(name, value)
  }

  array(name: string): Map<string, Value> {
    const scope = this.lookup(name)
    let cell = scope.get(name)
    if (cell === undefined) {
      cell = new AwkArray()
      scope.set(name, cell)
    }
    if (!(cell instanceof Map)) throw new AwkError("can't use scalar `" + name + "' as array")
    return cell
  }

  setRecord(text: string) {
    this.count = 1
    this.fields[0] = text
    this.recordFS = this.special('FS')
    this.parsed = false
    this.offset = 0
  }

  parse() {
    this.parseTo(Infinity)
  }

  parseTo(index: number) {
    if (this.parsed) return
    const text = this.fields[0] ?? ''
    const fields = this.fields
    const fs = this.recordFS
    const length = text.length
    let count = this.count
    let i = this.offset
    if (fs === ' ') {
      while (count <= index) {
        while (i < length) {
          const c = text.charCodeAt(i)
          if (c !== 32 && c !== 9 && c !== 10) break
          i++
        }
        if (i >= length) break
        const start = i
        while (i < length) {
          const c = text.charCodeAt(i)
          if (c === 32 || c === 9 || c === 10) break
          i++
        }
        fields[count++] = text.slice(start, i)
      }
      this.offset = i
      this.count = count
      if (count <= index) {
        this.parsed = true
        this.nf = count - 1
      }
      return
    }
    if (fs.length === 1) {
      if (length === 0) i = 1
      while (count <= index && i <= length) {
        const end = text.indexOf(fs, i)
        if (end < 0) {
          fields[count++] = text.slice(i)
          i = length + 1
        } else {
          fields[count++] = text.slice(i, end)
          i = end + 1
        }
      }
      this.offset = i
      this.count = count
      if (i > length) {
        this.parsed = true
        this.nf = count - 1
      }
      return
    }
    this.parsed = true
    const parts = this.splitFields(text, fs)
    for (const part of parts) fields[count++] = part
    this.count = count
    this.nf = parts.length
  }

  splitFields(text: string, fs: string): string[] {
    if (text === '') return []
    if (fs === ' ') {
      const trimmed = text.trim()
      return trimmed === '' ? [] : trimmed.split(/[ \t\n]+/)
    }
    if (fs === '') return text.split('')
    if (fs.length === 1) return text.split(fs)
    return separate(text, this.global(this.dynamic(fs)))
  }

  dynamic(source: string): RegExp {
    let re = this.regexCache.get(source)
    if (!re) {
      if (this.regexCache.size > 512) this.regexCache.clear()
      try {
        re = regex(source)
      } catch (error) {
        if (error instanceof AwkError) throw this.fatal(error.message)
        throw error
      }
      this.regexCache.set(source, re)
    }
    return re
  }

  rebuild() {
    this.parse()
    const ofs = this.str(this.scalar('OFS'))
    let text = ''
    for (let i = 1; i <= this.nf; i++) text += (i > 1 ? ofs : '') + (this.fields[i] ?? '')
    this.fields[0] = text
  }

  setNF(n: number) {
    this.parse()
    for (let i = this.nf + 1; i <= n; i++) this.fields[i] = ''
    this.count = n + 1
    this.nf = n
    this.rebuild()
  }

  getField(index: number): Value {
    if (index < 0) throw this.fatal('negative field index $' + index)
    return new Strnum(this.fieldText(index))
  }

  fieldText(index: number): string {
    if (index === 0) return this.fields[0] ?? ''
    this.parseTo(index)
    if (index >= this.count || (this.parsed && index > this.nf)) return ''
    return this.fields[index] ?? ''
  }

  special(name: string): string {
    const value = this.frames.length ? this.scalar(name) : this.globals.get(name)
    return typeof value === 'string' ? value : this.str(value as Value)
  }

  setField(index: number, value: Value) {
    if (index < 0) throw this.fatal('negative field index $' + index)
    if (index === 0) {
      this.setRecord(this.str(value))
      return
    }
    if (index > 100000) throw new AwkError('field index too large')
    this.parse()
    for (let i = this.nf + 1; i < index; i++) this.fields[i] = ''
    this.fields[index] = this.str(value)
    if (index > this.nf) {
      this.nf = index
      this.count = index + 1
    }
    this.rebuild()
  }

  async subscript(subs: Expr[]): Promise<string> {
    const parts: string[] = []
    for (const sub of subs) parts.push(this.str(await this.eval(sub)))
    return parts.join(this.str(this.scalar('SUBSEP')))
  }

  async assignTo(target: Expr, value: Value) {
    if (target.k === 'var') this.setScalar(target.name, value)
    else if (target.k === 'field')
      this.setField(Math.trunc(toNum(await this.eval(target.index))), value)
    else if (target.k === 'index')
      this.array(target.name).set(await this.subscript(target.subs), value)
    else if (target.k === 'group' && target.list.length === 1)
      await this.assignTo(target.list[0], value)
    else throw new AwkError('assignment to non-lvalue')
  }

  async toRegex(e: Expr): Promise<RegExp> {
    if (e.k === 're') return e.v
    return this.dynamic(this.str(await this.eval(e)))
  }

  compare(op: string, a: Value, b: Value): boolean {
    let result: number
    if (isNumberish(a) && isNumberish(b)) {
      const x = toNum(a)
      const y = toNum(b)
      result = x < y ? -1 : x > y ? 1 : 0
    } else {
      const x = this.str(a)
      const y = this.str(b)
      result = x < y ? -1 : x > y ? 1 : 0
    }
    switch (op) {
      case '<':
        return result < 0
      case '<=':
        return result <= 0
      case '>':
        return result > 0
      case '>=':
        return result >= 0
      case '==':
        return result === 0
      default:
        return result !== 0
    }
  }

  async eval(e: Expr): Promise<Value> {
    const fast = this.fastExprs.get(e)
    if (fast) return fast()
    switch (e.k) {
      case 'num':
        return e.v
      case 'str':
        return e.v
      case 're':
        e.v.lastIndex = 0
        return e.v.test(this.fields[0] ?? '') ? 1 : 0
      case 'var':
        return this.scalar(e.name)
      case 'field':
        return this.getField(Math.trunc(toNum(await this.eval(e.index))))
      case 'index': {
        const array = this.array(e.name)
        const key = await this.subscript(e.subs)
        if (!array.has(key)) array.set(key, undefined)
        return array.get(key)
      }
      case 'group':
        return this.eval(e.list[e.list.length - 1])
      case 'assign': {
        let value = await this.eval(e.value)
        if (e.op !== '=') {
          const current = toNum(await this.eval(e.target))
          value = this.arith(e.op.slice(0, -1), current, toNum(value))
        } else if (value instanceof Strnum) value = new Strnum(value.text)
        await this.assignTo(e.target, value)
        return value
      }
      case 'cond':
        return truthy(await this.eval(e.test)) ? this.eval(e.yes) : this.eval(e.no)
      case 'and':
        return truthy(await this.eval(e.left)) && truthy(await this.eval(e.right)) ? 1 : 0
      case 'or':
        return truthy(await this.eval(e.left)) || truthy(await this.eval(e.right)) ? 1 : 0
      case 'not':
        return truthy(await this.eval(e.e)) ? 0 : 1
      case 'neg':
        return -toNum(await this.eval(e.e))
      case 'plus':
        return toNum(await this.eval(e.e))
      case 'bin': {
        const left = await this.eval(e.left)
        const right = await this.eval(e.right)
        if (['<', '<=', '>', '>=', '==', '!='].includes(e.op))
          return this.compare(e.op, left, right) ? 1 : 0
        return this.arith(e.op, toNum(left), toNum(right))
      }
      case 'concat': {
        const left = this.str(await this.eval(e.left))
        return this.grown(left, left + this.str(await this.eval(e.right)))
      }
      case 'match': {
        const text = this.str(await this.eval(e.left))
        const re = await this.toRegex(e.right)
        re.lastIndex = 0
        return re.test(text) !== e.negate ? 1 : 0
      }
      case 'in': {
        const key = await this.subscript(e.subs)
        return this.array(e.name).has(key) ? 1 : 0
      }
      case 'incr': {
        const current = toNum(await this.eval(e.target))
        const next = current + (e.op === '++' ? 1 : -1)
        await this.assignTo(e.target, next)
        return e.prefix ? next : current
      }
      case 'call':
        return this.call(e.name, e.args)
      case 'builtin':
        return this.builtin(e.name, e.args)
      case 'getline':
        return this.getline(e)
    }
  }

  prepare() {
    const functions = this.program.functions
    for (let changed = true; changed; ) {
      changed = false
      for (const [name, fn] of functions) {
        if (this.asyncFns.has(name)) continue
        this.asyncMemo.clear()
        if (fn.body.some((s) => this.asyncStmt(s))) {
          this.asyncFns.add(name)
          changed = true
        }
      }
    }
    this.asyncMemo.clear()
    const none = new Set<string>()
    for (const block of [...this.program.begin, ...this.program.end])
      for (const s of block) this.visit(s, none)
    for (const rule of this.program.rules) {
      if (rule.pattern) this.visitExpr(rule.pattern, none)
      if (rule.end) this.visitExpr(rule.end, none)
      if (rule.action) for (const s of rule.action) this.visit(s, none)
    }
    for (const fn of functions.values()) {
      const scope = new Set(fn.params)
      for (const s of fn.body) this.visit(s, scope)
    }
    if (
      this.program.rules.every(
        (rule) =>
          (!rule.pattern || !this.asyncExpr(rule.pattern)) &&
          (!rule.end || !this.asyncExpr(rule.end)) &&
          (!rule.action || !rule.action.some((s) => this.asyncStmt(s))),
      )
    ) {
      this.rules = this.program.rules.map((rule) => ({
        rule,
        pattern: rule.pattern && this.expr(rule.pattern, none),
        end: rule.end && this.expr(rule.end, none),
        action: rule.action && this.block(rule.action, none),
      }))
    }
  }

  asyncExpr(e: Expr): boolean {
    let known = this.asyncMemo.get(e)
    if (known === undefined) {
      known =
        e.k === 'getline' ||
        (e.k === 'builtin' && (e.name === 'system' || e.name === 'close')) ||
        (e.k === 'call' && this.asyncFns.has(e.name)) ||
        exprKids(e).some((kid) => this.asyncExpr(kid))
      this.asyncMemo.set(e, known)
    }
    return known
  }

  asyncStmt(s: Stmt): boolean {
    let known = this.asyncMemo.get(s)
    if (known === undefined) {
      const kids = stmtKids(s)
      known =
        kids.exprs.some((kid) => this.asyncExpr(kid)) ||
        kids.stmts.some((kid) => this.asyncStmt(kid))
      this.asyncMemo.set(s, known)
    }
    return known
  }

  visit(s: Stmt, scope: Set<string>) {
    if (!this.asyncStmt(s)) {
      this.stmt(s, scope)
      return
    }
    const kids = stmtKids(s)
    for (const kid of kids.stmts) this.visit(kid, scope)
    for (const kid of kids.exprs) this.visitExpr(kid, scope)
  }

  visitExpr(e: Expr, scope: Set<string>) {
    if (!this.asyncExpr(e)) {
      this.expr(e, scope)
      return
    }
    for (const kid of exprKids(e)) this.visitExpr(kid, scope)
  }

  signal(status: number) {
    if (status === BREAK) throw new LoopSignal('break')
    if (status === CONTINUE) throw new LoopSignal('continue')
    if (status === NEXT) throw new NextSignal()
    if (status === RETURN) {
      const value = this.returned
      this.returned = undefined
      throw new ReturnSignal(value)
    }
  }

  expr(e: Expr, scope: Set<string>): Fn {
    let fn = this.fastExprs.get(e)
    if (!fn) {
      fn = this.build(e, scope)
      this.fastExprs.set(e, fn)
    }
    return fn
  }

  stmt(s: Stmt, scope: Set<string>): Run {
    let run = this.fastStmts.get(s)
    if (!run) {
      run = this.buildStmt(s, scope)
      this.fastStmts.set(s, run)
    }
    return run
  }

  block(list: Stmt[], scope: Set<string>): Run {
    const runs = list.map((s) => this.stmt(s, scope))
    if (runs.length === 1) return runs[0]
    return () => {
      for (let i = 0; i < runs.length; i++) {
        const status = runs[i]()
        if (status) return status
      }
      return 0
    }
  }

  key(subs: Expr[], scope: Set<string>): () => string {
    const fns = subs.map((sub) => this.expr(sub, scope))
    if (fns.length === 1) {
      const only = fns[0]
      return () => this.str(only())
    }
    return () => fns.map((fn) => this.str(fn())).join(this.str(this.scalar('SUBSEP')))
  }

  text(e: Expr, scope: Set<string>, output = false): () => string {
    if (e.k === 'field' && e.index.k === 'num' && e.index.v >= 0) {
      const n = Math.trunc(e.index.v)
      return () => this.fieldText(n)
    }
    if (e.k === 'str') {
      const value = e.v
      return () => value
    }
    if (e.k === 'group' && e.list.length === 1) return this.text(e.list[0], scope, output)
    if (e.k === 'concat') {
      const left = this.text(e.left, scope)
      const right = this.text(e.right, scope)
      return () => {
        const head = left()
        const text = head + right()
        return text.length > 4096 &&
          (Math.clz32(text.length) < Math.clz32(head.length) ||
            text.length >>> 20 !== head.length >>> 20)
          ? this.grown(head, text)
          : text
      }
    }
    const fn = this.expr(e, scope)
    return () => this.str(fn(), output)
  }

  grown(head: string, text: string): string {
    if (text.length >>> 20 !== head.length >>> 20)
      budget(this.ctx.limits, 4 * text.length, 'awk: a string of ' + text.length + ' characters')
    return text.length > 4096 && Math.clz32(text.length) < Math.clz32(head.length)
      ? flatten(text)
      : text
  }

  pattern(e: Expr, scope: Set<string>): () => RegExp {
    if (e.k === 're') {
      const re = e.v
      return () => re
    }
    const fn = this.expr(e, scope)
    return () => this.dynamic(this.str(fn()))
  }

  place(
    e: Expr,
    scope: Set<string>,
  ): {
    get: Fn
    set: (value: Value) => void
    update: (change: (current: Value) => Value) => Value
  } {
    if (e.k === 'group' && e.list.length === 1) return this.place(e.list[0], scope)
    if (e.k === 'var') {
      const name = e.name
      if (scope.has(name) || name === 'NF') {
        const get = () => this.scalar(name)
        const set = (value: Value) => this.setScalar(name, value)
        return {
          get,
          set,
          update: (change) => {
            const value = change(get())
            set(value)
            return value
          },
        }
      }
      const globals = this.globals
      const scalar = (): Value => {
        const cell = globals.get(name)
        if (cell instanceof Map)
          throw new AwkError('attempt to use array `' + name + "' in a scalar context")
        return cell
      }
      return {
        get: scalar,
        set: (value) => {
          scalar()
          globals.set(name, value)
        },
        update: (change) => {
          const value = change(scalar())
          globals.set(name, value)
          return value
        },
      }
    }
    if (e.k === 'field') {
      const source = e.index
      const index =
        source.k === 'num'
          ? (() => {
              const n = Math.trunc(source.v)
              return () => n
            })()
          : (() => {
              const fn = this.expr(source, scope)
              return () => Math.trunc(toNum(fn()))
            })()
      return {
        get: () => this.getField(index()),
        set: (value) => this.setField(index(), value),
        update: (change) => {
          const i = index()
          const value = change(this.getField(i))
          this.setField(i, value)
          return value
        },
      }
    }
    if (e.k === 'index') {
      const name = e.name
      const key = this.key(e.subs, scope)
      return {
        get: () => {
          const array = this.array(name)
          const k = key()
          const value = array.get(k)
          if (value === undefined && !array.has(k)) array.set(k, undefined)
          return value
        },
        set: (value) => {
          const array = this.array(name)
          array.set(key(), value)
        },
        update: (change) => {
          const array = this.array(name)
          const k = key()
          const value = change(array.get(k))
          array.set(k, value)
          return value
        },
      }
    }
    const get = this.expr(e, scope)
    const fail = (): never => {
      throw new AwkError('assignment to non-lvalue')
    }
    return { get, set: fail, update: fail }
  }

  build(e: Expr, scope: Set<string>): Fn {
    switch (e.k) {
      case 'num':
      case 'str': {
        const value = e.v
        return () => value
      }
      case 're': {
        const re = e.v
        return () => {
          re.lastIndex = 0
          return re.test(this.fields[0] ?? '') ? 1 : 0
        }
      }
      case 'var':
      case 'field':
      case 'index':
        return this.place(e, scope).get
      case 'group':
        return this.expr(e.list[e.list.length - 1], scope)
      case 'assign': {
        const target = this.place(e.target, scope)
        const value = this.expr(e.value, scope)
        if (e.op === '=')
          return () => {
            const v = value()
            target.set(v)
            return v
          }
        const op = e.op.slice(0, -1)
        return () => {
          const v = toNum(value())
          return target.update((current) => this.arith(op, toNum(current), v))
        }
      }
      case 'incr': {
        const target = this.place(e.target, scope)
        const delta = e.op === '++' ? 1 : -1
        if (e.prefix) return () => target.update((current) => toNum(current) + delta)
        return () => {
          let old = 0
          target.update((current) => {
            old = toNum(current)
            return old + delta
          })
          return old
        }
      }
      case 'cond': {
        const test = this.expr(e.test, scope)
        const yes = this.expr(e.yes, scope)
        const no = this.expr(e.no, scope)
        return () => (truthy(test()) ? yes() : no())
      }
      case 'and': {
        const left = this.expr(e.left, scope)
        const right = this.expr(e.right, scope)
        return () => (truthy(left()) && truthy(right()) ? 1 : 0)
      }
      case 'or': {
        const left = this.expr(e.left, scope)
        const right = this.expr(e.right, scope)
        return () => (truthy(left()) || truthy(right()) ? 1 : 0)
      }
      case 'not': {
        const inner = this.expr(e.e, scope)
        return () => (truthy(inner()) ? 0 : 1)
      }
      case 'neg': {
        const inner = this.expr(e.e, scope)
        return () => -toNum(inner())
      }
      case 'plus': {
        const inner = this.expr(e.e, scope)
        return () => toNum(inner())
      }
      case 'bin': {
        const left = this.expr(e.left, scope)
        const right = this.expr(e.right, scope)
        const op = e.op
        if (COMPARISONS.has(op)) return () => (this.compare(op, left(), right()) ? 1 : 0)
        if (op === '+') return () => toNum(left()) + toNum(right())
        if (op === '-') return () => toNum(left()) - toNum(right())
        if (op === '*') return () => toNum(left()) * toNum(right())
        return () => this.arith(op, toNum(left()), toNum(right()))
      }
      case 'concat':
        return this.text(e, scope)
      case 'match': {
        const left = this.expr(e.left, scope)
        const right = this.pattern(e.right, scope)
        const negate = e.negate
        return () => {
          const text = this.str(left())
          const re = right()
          re.lastIndex = 0
          return re.test(text) !== negate ? 1 : 0
        }
      }
      case 'in': {
        const key = this.key(e.subs, scope)
        const name = e.name
        return () => (this.array(name).has(key()) ? 1 : 0)
      }
      case 'call':
        return this.buildCall(e.name, e.args, scope)
      case 'builtin':
        return this.buildBuiltin(e.name, e.args, scope)
      case 'getline':
        throw new AwkError('getline cannot run synchronously')
    }
  }

  buildCall(name: string, args: Expr[], scope: Set<string>): Fn {
    const fn = this.program.functions.get(name)
    if (!fn)
      return () => {
        throw new AwkError('calling undefined function ' + name)
      }
    const values = args.map((arg) => this.expr(arg, scope))
    let body: Run | undefined
    return () => {
      body ??= this.fastFn(name)
      if (++this.depth > this.ctx.limits.maxCallDepth)
        throw new AwkError('function call nesting too deep')
      const frame = new Map<string, Cell>()
      const bindings: [string, Map<string, Value>][] = []
      for (let i = 0; i < fn.params.length; i++) {
        const arg = args[i]
        if (!arg) {
          frame.set(fn.params[i], undefined)
          continue
        }
        if (arg.k === 'var') {
          const scopeOf = this.lookup(arg.name)
          const cell = scopeOf.get(arg.name)
          if (cell instanceof Map) {
            frame.set(fn.params[i], cell)
            continue
          }
          if (cell === undefined && !scopeOf.has(arg.name)) {
            const fresh = new AwkArray()
            bindings.push([arg.name, fresh])
            frame.set(fn.params[i], fresh)
            continue
          }
        }
        frame.set(fn.params[i], values[i]())
      }
      this.frames.push(frame)
      try {
        const status = body()
        if (status === NEXT) throw new NextSignal()
        if (status === RETURN) {
          const value = this.returned
          this.returned = undefined
          return value
        }
        return undefined
      } finally {
        this.frames.pop()
        this.depth--
        for (const [variable, map] of bindings)
          if (map.size) this.lookup(variable).set(variable, map)
      }
    }
  }

  fastFn(name: string): Run {
    let run = this.fastFns.get(name)
    if (!run) {
      const fn = this.program.functions.get(name)!
      run = this.block(fn.body, new Set(fn.params))
      this.fastFns.set(name, run)
    }
    return run
  }

  buildBuiltin(name: string, args: Expr[], scope: Set<string>, counted = true): Fn {
    const missing = (count: number) => args.length < count
    const fail =
      (message: string): Fn =>
      () => {
        throw new AwkError(message)
      }
    switch (name) {
      case 'length': {
        const arg = args[0]
        if (!arg) return () => (this.fields[0] ?? '').length
        const fn = this.expr(arg, scope)
        if (arg.k === 'var') {
          const variable = arg.name
          return () => {
            const cell = this.lookup(variable).get(variable)
            return cell instanceof Map ? cell.size : this.str(fn()).length
          }
        }
        return () => this.str(fn()).length
      }
      case 'split': {
        const target = args[1]
        if (target?.k !== 'var') return fail('split: second argument is not an array')
        const source = this.expr(args[0], scope)
        const separator = args[2]
        const array = target.name
        if (!separator)
          return () => {
            const text = this.str(source())
            return this.split(text, this.array(array), this.str(this.scalar('FS')))
          }
        if (separator.k === 're') {
          const re = separator.v
          return () => {
            const text = this.str(source())
            return this.split(text, this.array(array), re)
          }
        }
        const sep = this.expr(separator, scope)
        return () => {
          const text = this.str(source())
          const map = this.array(array)
          return this.split(text, map, this.str(sep()))
        }
      }
      case 'sub':
      case 'gsub': {
        if (missing(2)) return fail(name + ': not enough arguments')
        const re = this.pattern(args[0], scope)
        const replacement = this.expr(args[1], scope)
        const target = this.place(args[2] ?? FIELD0, scope)
        const global = name === 'gsub'
        return () => {
          const pattern = re()
          const result = this.replace(
            this.str(target.get()),
            pattern,
            this.str(replacement()),
            global,
            counted,
          )
          if (result.count) target.set(result.text)
          return result.count
        }
      }
      case 'match': {
        if (missing(2)) return fail('match: not enough arguments')
        const source = this.expr(args[0], scope)
        const re = this.pattern(args[1], scope)
        const target = args[2]
        return () => {
          const text = this.str(source())
          return this.match(text, re(), target)
        }
      }
    }
    const fns = args.map((arg) => this.expr(arg, scope))
    if (fns.length === 1) {
      const only = fns[0]
      if (name === 'tolower') return () => lower(this.str(only()))
      if (name === 'toupper') return () => upper(this.str(only()))
      if (name === 'int') return () => Math.trunc(toNum(only()))
    }
    return () =>
      this.pure(
        name,
        fns.map((fn) => fn()),
      )
  }

  sink(redirect: { op: string; target: Expr } | undefined, scope: Set<string>): Sink {
    if (!redirect) return (text) => this.print(text)
    const target = this.expr(redirect.target, scope)
    const op = redirect.op
    return (text) => this.emit(text, op, this.str(target()))
  }

  buildStmt(s: Stmt, scope: Set<string>): Run {
    switch (s.k) {
      case 'expr': {
        const fn =
          s.e.k === 'builtin' && s.e.name === 'gsub'
            ? this.buildBuiltin(s.e.name, s.e.args, scope, false)
            : this.expr(s.e, scope)
        return () => {
          this.tick()
          fn()
          return 0
        }
      }
      case 'print': {
        const sink = this.sink(s.redirect, scope)
        const args = s.args.map((arg) => this.text(arg, scope, true))
        if (!args.length)
          return () => {
            this.tick()
            sink((this.fields[0] ?? '') + this.special('ORS'))
            return 0
          }
        if (args.length === 1) {
          const only = args[0]
          return () => {
            this.tick()
            sink(only() + this.special('ORS'))
            return 0
          }
        }
        return () => {
          this.tick()
          const ofs = this.special('OFS')
          let out = args[0]()
          for (let i = 1; i < args.length; i++) out += ofs + args[i]()
          sink(out + this.special('ORS'))
          return 0
        }
      }
      case 'printf': {
        const sink = this.sink(s.redirect, scope)
        const first = s.args[0]
        const pieces = first.k === 'str' ? compileFormat(first.v) : []
        const conversions = pieces.filter((piece) => typeof piece !== 'string')
        if (
          first.k === 'str' &&
          conversions.length < s.args.length &&
          conversions.every((piece) => piece.plain)
        ) {
          let used = 0
          const parts = pieces.map((piece): (() => string) => {
            if (typeof piece === 'string') return () => piece
            const arg = s.args[1 + used++]
            if (piece.conv === 's') return this.text(arg, scope)
            const fn = this.expr(arg, scope)
            return () => {
              const value = fn()
              const int = Math.trunc(toNum(value))
              return Math.abs(int) < 2 ** 53 ? String(int) : this.convert(value, piece)!
            }
          })
          return () => {
            this.tick()
            let out = ''
            for (let i = 0; i < parts.length; i++) out += parts[i]()
            sink(out)
            return 0
          }
        }
        const spec = this.expr(s.args[0], scope)
        const rest = s.args.slice(1).map((arg) => this.expr(arg, scope))
        return () => {
          this.tick()
          const values: Value[] = []
          for (let i = 0; i < rest.length; i++) values.push(rest[i]())
          sink(this.sprintf(this.str(spec()), { values, sink }))
          return 0
        }
      }
      case 'if': {
        const test = this.expr(s.test, scope)
        const yes = this.stmt(s.yes, scope)
        const no = s.no ? this.stmt(s.no, scope) : undefined
        return () => {
          this.tick()
          if (truthy(test())) return yes()
          return no ? no() : 0
        }
      }
      case 'while': {
        const test = this.expr(s.test, scope)
        const body = this.stmt(s.body, scope)
        return () => {
          this.tick()
          for (let n = 0; truthy(test()); n++) {
            this.loop(n)
            const status = body()
            if (status === BREAK) break
            if (status && status !== CONTINUE) return status
          }
          return 0
        }
      }
      case 'do': {
        const test = this.expr(s.test, scope)
        const body = this.stmt(s.body, scope)
        return () => {
          this.tick()
          let n = 0
          do {
            this.loop(n++)
            const status = body()
            if (status === BREAK) break
            if (status && status !== CONTINUE) return status
          } while (truthy(test()))
          return 0
        }
      }
      case 'for': {
        const init = s.init ? this.stmt(s.init, scope) : undefined
        const test = s.test ? this.expr(s.test, scope) : undefined
        const step = s.step ? this.stmt(s.step, scope) : undefined
        const body = this.stmt(s.body, scope)
        return () => {
          this.tick()
          if (init) init()
          for (let n = 0; !test || truthy(test()); n++) {
            this.loop(n)
            const status = body()
            if (status === BREAK) break
            if (status && status !== CONTINUE) return status
            if (step) step()
          }
          return 0
        }
      }
      case 'forin': {
        const body = this.stmt(s.body, scope)
        const name = s.name
        const source = s.array
        return () => {
          this.tick()
          const keys = [...this.array(source).keys()]
          for (let n = 0; n < keys.length; n++) {
            this.loop(n)
            this.setScalar(name, new Strnum(keys[n]))
            const status = body()
            if (status === BREAK) break
            if (status && status !== CONTINUE) return status
          }
          return 0
        }
      }
      case 'block':
        return this.block(s.body, scope)
      case 'next':
        return () => NEXT
      case 'nextfile':
        return () => {
          throw new NextFileSignal()
        }
      case 'break':
        return () => BREAK
      case 'continue':
        return () => CONTINUE
      case 'exit': {
        const code = s.e ? this.expr(s.e, scope) : undefined
        return () => {
          throw new ExitSignal(code ? toInt(toNum(code())) & 0xff : 0)
        }
      }
      case 'return': {
        const value = s.e ? this.expr(s.e, scope) : undefined
        return () => {
          this.returned = value ? value() : undefined
          return RETURN
        }
      }
      case 'delete': {
        const name = s.name
        const key = s.subs ? this.key(s.subs, scope) : undefined
        return () => {
          const array = this.array(name)
          if (key) array.delete(key())
          else array.clear()
          return 0
        }
      }
    }
  }

  load(text: string) {
    const rs = this.str(this.scalar('RS'))
    if (rs === '\n') {
      this.records = undefined
      this.source = text
      this.cursor = 0
      return
    }
    this.records = splitRecords(text, rs)
    this.recordIndex = 0
  }

  pending(): boolean {
    return this.records ? this.recordIndex < this.records.length : this.cursor < this.source.length
  }

  next(): string | undefined {
    if (this.records)
      return this.recordIndex < this.records.length ? this.records[this.recordIndex++] : undefined
    const source = this.source
    if (this.cursor >= source.length) return undefined
    const start = this.cursor
    const end = source.indexOf('\n', start)
    if (end < 0) {
      this.cursor = source.length
      return source.slice(start)
    }
    this.cursor = end + 1
    return source.slice(start, end)
  }

  print(text: string) {
    this.buffer += text
    if (this.buffer.length > 65536) this.flushOut()
  }

  flushOut() {
    if (!this.buffer) return
    const text = this.buffer
    this.buffer = ''
    this.ctx.stdout.write(chars(text))
  }

  scan(): boolean | 'pause' {
    const rules = this.rules!
    const stdout = this.ctx.stdout
    for (let n = 1; ; n++) {
      if ((n & 4095) === 0 && stdout.backlog) return 'pause'
      const record = this.next()
      if (record === undefined) break
      this.globals.set('NR', toNum(this.globals.get('NR') as Value) + 1)
      this.globals.set('FNR', toNum(this.globals.get('FNR') as Value) + 1)
      this.setRecord(record)
      this.tick()
      try {
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i]
          let matched: boolean
          if (!rule.pattern) matched = true
          else if (rule.end) {
            if (rule.rule.active) {
              matched = true
              if (truthy(rule.end())) rule.rule.active = false
            } else if (truthy(rule.pattern())) {
              matched = true
              rule.rule.active = !truthy(rule.end())
            } else matched = false
          } else matched = truthy(rule.pattern())
          if (!matched) continue
          if (rule.action) {
            if (rule.action() === NEXT) break
          } else this.print((this.fields[0] ?? '') + this.str(this.scalar('ORS')))
        }
      } catch (error) {
        if (error instanceof NextSignal) continue
        if (error instanceof NextFileSignal) {
          this.skipped = true
          break
        }
        if (error instanceof ExitSignal) {
          this.exitCode = error.code
          return true
        }
        throw error
      }
    }
    return false
  }

  arith(op: string, a: number, b: number): number {
    switch (op) {
      case '+':
        return a + b
      case '-':
        return a - b
      case '*':
        return a * b
      case '/':
        return a / b
      case '%':
        return a % b
      case '^':
        return a ** b
    }
    throw new AwkError('unknown operator ' + op)
  }

  async call(name: string, args: Expr[]): Promise<Value> {
    const fn = this.program.functions.get(name)
    if (!fn) throw new AwkError('calling undefined function ' + name)
    if (++this.depth > this.ctx.limits.maxCallDepth)
      throw new AwkError('function call nesting too deep')
    const frame = new Map<string, Cell>()
    const bindings: [string, Map<string, Value>][] = []
    for (let i = 0; i < fn.params.length; i++) {
      const arg = args[i]
      if (!arg) {
        frame.set(fn.params[i], undefined)
        continue
      }
      if (arg.k === 'var') {
        const cell = this.lookup(arg.name).get(arg.name)
        if (cell instanceof Map) {
          frame.set(fn.params[i], cell)
          continue
        }
        if (cell === undefined && !this.lookup(arg.name).has(arg.name)) {
          const fresh = new AwkArray()
          bindings.push([arg.name, fresh])
          frame.set(fn.params[i], fresh)
          continue
        }
      }
      frame.set(fn.params[i], await this.eval(arg))
    }
    this.frames.push(frame)
    try {
      await this.statements(fn.body)
      return undefined
    } catch (error) {
      if (error instanceof ReturnSignal) return error.value
      throw error
    } finally {
      this.frames.pop()
      this.depth--
      for (const [name, map] of bindings) if (map.size) this.lookup(name).set(name, map)
    }
  }

  replace(
    text: string,
    re: RegExp,
    replacement: string,
    global: boolean,
    counted = true,
  ): { text: string; count: number } {
    let count = 0
    const plain = !replacement.includes('&') && !replacement.includes('\\')
    if (plain && global && !counted && !re.test('')) {
      const pattern = this.global(re)
      pattern.lastIndex = 0
      if (!pattern.test(text)) return { text, count: 0 }
      return {
        text: text.replace(
          pattern,
          replacement.includes('$') ? replacement.replaceAll('$', '$$$$') : replacement,
        ),
        count: 1,
      }
    }
    let end = -1
    const result = text.replace(global ? this.global(re) : re, (match: string, offset: number) => {
      if (!match && offset === end) return ''
      end = offset + match.length
      count++
      if (plain) return replacement
      let out = ''
      for (let i = 0; i < replacement.length; i++) {
        const c = replacement[i]
        if (c === '\\' && replacement[i + 1] === '&') {
          out += '&'
          i++
        } else if (c === '\\' && replacement[i + 1] === '\\') {
          out += /^[\\&]*&/.test(replacement.slice(i + 2)) ? '\\' : '\\\\'
          i++
        } else if (c === '&') out += match
        else out += c
      }
      return out
    })
    return { text: result, count }
  }

  async builtin(name: string, args: Expr[]): Promise<Value> {
    switch (name) {
      case 'length': {
        const arg = args[0]
        if (!arg) return (this.fields[0] ?? '').length
        if (arg.k === 'var') {
          const cell = this.lookup(arg.name).get(arg.name)
          if (cell instanceof Map) return cell.size
        }
        return this.str(await this.eval(arg)).length
      }
      case 'split': {
        const target = args[1]
        if (target?.k !== 'var') throw new AwkError('split: second argument is not an array')
        const source = this.str(await this.eval(args[0]))
        const separator = args[2]
        const sep =
          separator === undefined
            ? this.str(this.scalar('FS'))
            : separator.k === 're'
              ? separator.v
              : this.str(await this.eval(separator))
        return this.split(source, this.array(target.name), sep)
      }
      case 'sub':
      case 'gsub': {
        const re = await this.toRegex(args[0])
        const replacement = this.str(await this.eval(args[1]))
        const target: Expr = args[2] ?? FIELD0
        const result = this.replace(
          this.str(await this.eval(target)),
          re,
          replacement,
          name === 'gsub',
        )
        if (result.count) await this.assignTo(target, result.text)
        return result.count
      }
      case 'match': {
        const source = this.str(await this.eval(args[0]))
        return this.match(source, await this.toRegex(args[1]), args[2])
      }
      case 'system': {
        await this.flushAll()
        const result = await this.ctx.exec(chars(this.str(await this.eval(args[0]))))
        this.print(bytes(result.stdout))
        return result.status
      }
      case 'close': {
        const key = this.str(await this.eval(args[0]))
        const reader = this.readers.get(key)
        this.readers.delete(key)
        const output = this.outputs.get(key)
        if (!output) return reader ? (reader.status ?? 0) : -1
        await this.flush(key, output)
        this.outputs.delete(key)
        return 0
      }
    }
    const values: Value[] = []
    for (const arg of args) values.push(await this.eval(arg))
    return this.pure(name, values)
  }

  pure(name: string, values: Value[]): Value {
    const text = (index: number) => this.str(values[index])
    const num = (index: number) => toNum(values[index])
    switch (name) {
      case 'length':
        return text(0).length
      case 'substr':
        return text(0) ? substr(text(0), num(1), values.length > 2 ? num(2) : undefined) : ''
      case 'index':
        return text(0).indexOf(text(1)) + 1
      case 'sprintf':
        return this.sprintf(text(0), { values: values.slice(1) })
      case 'sin':
        return Math.sin(num(0))
      case 'cos':
        return Math.cos(num(0))
      case 'atan2':
        return Math.atan2(num(0), num(1))
      case 'exp':
        return Math.exp(num(0))
      case 'log':
        return Math.log(num(0))
      case 'sqrt':
        return Math.sqrt(num(0))
      case 'int':
        return Math.trunc(num(0))
      case 'rand':
        return Math.random()
      case 'srand': {
        const previous = this.seed
        this.seed = values.length ? num(0) : Math.floor(Date.now() / 1000)
        return previous
      }
      case 'tolower':
        return lower(text(0))
      case 'toupper':
        return upper(text(0))
      case 'systime':
        return Math.floor(Date.now() / 1000)
      case 'mktime': {
        const fields = text(0).trim().split(/\s+/)
        if (fields.length < 6 || !fields.slice(0, 6).every((field) => /^[+-]?\d+$/.test(field)))
          return -1
        const [year, month, day, hour, minute, second] = fields.map(Number)
        const date = new Date(0)
        date.setUTCFullYear(year, month - 1, day)
        date.setUTCHours(hour, minute, second)
        return Math.floor(date.getTime() / 1000)
      }
      case 'strftime':
        return bytes(
          strftime(
            values.length ? chars(text(0)) : '%c',
            new Date(values.length > 1 ? num(1) * 1000 : Date.now()),
          ),
        )
      case 'fflush':
        return !values.length ||
          ['/dev/stdout', '/dev/stderr', '-'].includes(text(0)) ||
          this.outputs.has(text(0))
          ? 0
          : -1
    }
    throw new AwkError('function ' + name + ' never defined')
  }

  split(source: string, array: Map<string, Value>, separator: string | RegExp): number {
    const parts =
      source === ''
        ? []
        : separator === ' '
          ? this.words(source)
          : typeof separator === 'string'
            ? this.splitFields(source, separator)
            : separate(source, this.global(separator))
    const n = parts.length
    if (array instanceof AwkArray) {
      array.fill(parts)
      return n
    }
    const size = array.size
    let exact = size <= INDEXES.length
    for (let i = 0; exact && i < size; i++) exact = array.has(INDEXES[i])
    if (!exact) array.clear()
    else for (let i = n; i < size; i++) array.delete(INDEXES[i])
    for (let i = 0; i < n; i++) array.set(INDEXES[i] ?? String(i + 1), new Strnum(parts[i]))
    return n
  }

  words(text: string): string[] {
    if (!text.includes('\t') && !text.includes('\n')) {
      const pieces: string[] = []
      const length = text.length
      for (let i = 0; i < length; ) {
        if (text.charCodeAt(i) === 32) {
          i++
          continue
        }
        let end = text.indexOf(' ', i)
        if (end < 0) end = length
        pieces.push(text.slice(i, end))
        i = end + 1
      }
      return pieces
    }
    const parts: string[] = []
    const length = text.length
    let i = 0
    for (;;) {
      while (i < length) {
        const c = text.charCodeAt(i)
        if (c !== 32 && c !== 9 && c !== 10) break
        i++
      }
      if (i >= length) break
      const start = i
      while (i < length) {
        const c = text.charCodeAt(i)
        if (c === 32 || c === 9 || c === 10) break
        i++
      }
      parts.push(text.slice(start, i))
    }
    return parts
  }

  match(source: string, re: RegExp, target: Expr | undefined): number {
    re.lastIndex = 0
    const found = re.exec(source)
    const start = found ? found.index + 1 : 0
    const length = found ? found[0].length : -1
    this.globals.set('RSTART', start)
    this.globals.set('RLENGTH', length)
    if (target?.k === 'var' && found) {
      const array = this.array(target.name)
      array.clear()
      found.forEach((group, index) => array.set(String(index), group ?? ''))
    }
    return start
  }

  global(re: RegExp): RegExp {
    let global = this.globalCache.get(re)
    if (!global) {
      global = new RegExp(re.source, re.flags.replace('g', '') + 'g')
      this.globalCache.set(re, global)
    }
    return global
  }

  pieces(spec: string): Piece[] {
    let pieces = this.formats.get(spec)
    if (pieces === undefined) {
      pieces = compileFormat(spec)
      if (this.formats.size > 256) this.formats.clear()
      this.formats.set(spec, pieces)
    }
    return pieces
  }

  sprintf(spec: string, options: Interpreter.Printf): string {
    const { values, sink } = options
    let out = ''
    let used = 0
    const fail = (message: string): never => {
      sink?.(out)
      throw this.fatal(message + (sink ? 'printf' : 'sprintf') + '("' + spec + '")')
    }
    for (const piece of this.pieces(spec)) {
      if (typeof piece === 'string') {
        out += piece
        continue
      }
      const width =
        piece.minimum === '*'
          ? toInt(toNum(values[used++]))
          : piece.minimum
            ? Number(piece.minimum)
            : undefined
      const precision =
        piece.digits === '*'
          ? toInt(toNum(values[used++]))
          : piece.digits === undefined
            ? undefined
            : Number(piece.digits || 0)
      if (used >= values.length) fail('not enough arguments passed to ')
      const text = this.convert(values[used++], { ...piece, width, precision })
      if (text === undefined) fail('improper conversion(number ' + piece.count + ') in ')
      out += text
    }
    return out
  }

  convert(value: Value, field: Field): string | undefined {
    const conv = field.conv
    if (!/^[diouxX]$/.test(conv) && (field.size || !/^[sceEfgG]$/.test(conv))) return undefined
    switch (conv) {
      case 's':
        return formatText(this.str(value), field)
      case 'c': {
        const code =
          typeof value === 'number'
            ? Number(toLong(value) & 0xffn)
            : value === undefined
              ? 0
              : typeof value === 'string' || !looksNumeric(value.text)
                ? (typeof value === 'string' ? value : value.text).charCodeAt(0) || 0
                : toInt(toNum(value)) & 0xff
        return formatText(String.fromCharCode(code), field)
      }
      case 'd': {
        const n = toNum(value)
        return n >= 2 ** 63
          ? formatInteger(toUlong(n), { ...field, conv: 'u' })
          : formatInteger(toLong(n), field)
      }
      case 'i':
        return formatInteger(toLong(toNum(value)), field)
      case 'o':
      case 'x':
      case 'X':
      case 'u':
        return formatInteger(toUlong(toNum(value)), field)
    }
    return formatFloat(toNum(value), field)
  }

  async getline(e: Expr & { k: 'getline' }): Promise<Value> {
    let line: string | undefined
    if (e.command) {
      const command = this.str(await this.eval(e.command))
      let reader = this.readers.get(command)
      if (!reader) {
        await this.flushAll()
        const result = await this.ctx.exec(chars(command))
        reader = {
          lines: splitRecords(bytes(result.stdout), this.str(this.scalar('RS'))),
          pos: 0,
          status: result.status,
        }
        this.readers.set(command, reader)
      }
      line = reader.lines[reader.pos++]
    } else if (e.file) {
      const file = this.str(await this.eval(e.file))
      let reader = this.readers.get(file)
      if (!reader) {
        let content: string
        try {
          content =
            file === '-' || file === '/dev/stdin' || file === '/dev/fd/0'
              ? bytes(await this.ctx.stdin.text())
              : binary(await this.ctx.fs.read(this.ctx.resolve(chars(file))))
        } catch (error) {
          if (error instanceof FsError && error.code === 'EISDIR')
            throw new AwkError('read error (Is a directory)')
          return -1
        }
        reader = { lines: splitRecords(content, this.str(this.scalar('RS'))), pos: 0 }
        this.readers.set(file, reader)
      }
      line = reader.lines[reader.pos++]
    } else {
      line = this.next()
      while (line === undefined) {
        if (this.more) {
          const text = await this.more()
          if (text === null) this.more = undefined
          else this.load(text)
        } else if (!this.advance || !(await this.advance())) break
        line = this.next()
      }
      if (line !== undefined) {
        this.globals.set('NR', toNum(this.scalar('NR')) + 1)
        this.globals.set('FNR', toNum(this.scalar('FNR')) + 1)
      }
    }
    if (line === undefined) return 0
    if (e.target) await this.assignTo(e.target, new Strnum(line))
    else this.setRecord(line)
    return 1
  }

  async write(text: string, redirect?: { op: string; target: Expr }) {
    if (!redirect) {
      this.print(text)
      return
    }
    this.emit(text, redirect.op, this.str(await this.eval(redirect.target)))
  }

  emit(text: string, op: string, key: string) {
    if (key === '/dev/stdout' || key === '-') {
      this.print(text)
      return
    }
    if (key === '/dev/stderr') {
      this.flushOut()
      this.ctx.stderr.write(chars(text))
      return
    }
    let output = this.outputs.get(key)
    if (!output) {
      output = { kind: op === '|' ? 'pipe' : 'file', text: '', append: op === '>>' }
      this.outputs.set(key, output)
      if (op === '|') this.flushOut()
    }
    output.text += text
    if (output.text.length > this.ctx.limits.maxBufferLength)
      throw new CommandError('output exceeded ' + this.ctx.limits.maxBufferLength + ' characters')
  }

  async flush(key: string, output: { kind: 'file' | 'pipe'; text: string; append: boolean }) {
    if (output.kind === 'pipe') {
      const result = await this.ctx.exec(chars(key), chars(output.text))
      this.ctx.stdout.write(result.stdout)
    } else {
      try {
        await this.ctx.fs.write(this.ctx.resolve(chars(key)), raw(output.text), output.append)
      } catch (error) {
        if (!(error instanceof FsError)) throw error
        throw new AwkError(
          'cannot open "' +
            key +
            '" for output (' +
            (key
              ? error.message.slice(error.message.lastIndexOf(': ') + 2)
              : 'No such file or directory') +
            ')',
        )
      }
      output.append = true
    }
    output.text = ''
  }

  async flushAll(last = false) {
    if (!last) this.flushOut()
    for (const [key, output] of this.outputs)
      if (output.text || output.kind === 'file') await this.flush(key, output)
    this.flushOut()
  }

  async statements(list: Stmt[]) {
    for (const statement of list) await this.statement(statement)
  }

  async statement(s: Stmt): Promise<void> {
    const fast = this.fastStmts.get(s)
    if (fast) {
      this.signal(fast())
      return
    }
    this.tick()
    switch (s.k) {
      case 'expr':
        await this.eval(s.e)
        return
      case 'print': {
        let text: string
        if (!s.args.length) text = this.fields[0] ?? ''
        else {
          const parts: string[] = []
          for (const arg of s.args) parts.push(this.str(await this.eval(arg), true))
          text = parts.join(this.str(this.scalar('OFS')))
        }
        await this.write(text + this.str(this.scalar('ORS')), s.redirect)
        return
      }
      case 'printf': {
        const values: Value[] = []
        for (const arg of s.args.slice(1)) values.push(await this.eval(arg))
        const spec = this.str(await this.eval(s.args[0]))
        const target = s.redirect && this.str(await this.eval(s.redirect.target))
        const sink: Sink = (text) =>
          s.redirect ? this.emit(text, s.redirect.op, target!) : this.print(text)
        sink(this.sprintf(spec, { values, sink }))
        return
      }
      case 'if':
        if (truthy(await this.eval(s.test))) await this.statement(s.yes)
        else if (s.no) await this.statement(s.no)
        return
      case 'while':
        for (let n = 0; truthy(await this.eval(s.test)); n++) {
          this.loop(n)
          if (await this.loopBody(s.body)) break
        }
        return
      case 'do': {
        let n = 0
        do {
          this.loop(n++)
          if (await this.loopBody(s.body)) break
        } while (truthy(await this.eval(s.test)))
        return
      }
      case 'for':
        if (s.init) await this.statement(s.init)
        for (let n = 0; !s.test || truthy(await this.eval(s.test)); n++) {
          this.loop(n)
          if (await this.loopBody(s.body)) break
          if (s.step) await this.statement(s.step)
        }
        return
      case 'forin': {
        const keys = [...this.array(s.array).keys()]
        for (let n = 0; n < keys.length; n++) {
          this.loop(n)
          this.setScalar(s.name, new Strnum(keys[n]))
          if (await this.loopBody(s.body)) break
        }
        return
      }
      case 'block':
        await this.statements(s.body)
        return
      case 'next':
        throw new NextSignal()
      case 'nextfile':
        throw new NextFileSignal()
      case 'break':
      case 'continue':
        throw new LoopSignal(s.k)
      case 'exit':
        throw new ExitSignal(s.e ? toInt(toNum(await this.eval(s.e))) & 0xff : 0)
      case 'return':
        throw new ReturnSignal(s.e ? await this.eval(s.e) : undefined)
      case 'delete': {
        const array = this.array(s.name)
        if (s.subs) array.delete(await this.subscript(s.subs))
        else array.clear()
        return
      }
    }
  }

  loop(n: number) {
    if (n > this.ctx.limits.maxLoopIterations * 100)
      throw new CommandError('too many loop iterations', 124)
  }

  async loopBody(body: Stmt): Promise<boolean> {
    try {
      await this.statement(body)
      return false
    } catch (error) {
      if (error instanceof LoopSignal) return error.kind === 'break'
      throw error
    }
  }
}

declare namespace Interpreter {
  type Printf = { values: Value[]; sink?: Sink | undefined }
}

function splitRecords(text: string, rs: string): string[] {
  if (rs === '\n') {
    const parts = text.split('\n')
    if (parts[parts.length - 1] === '') parts.pop()
    return parts
  }
  if (rs === '')
    return text
      .replace(/^\n+/, '')
      .split(/\n\n+/)
      .map((part) => part.replace(/\n+$/, ''))
      .filter((part) => part !== '')
  const parts = rs.length === 1 ? text.split(rs) : separate(text, new RegExp(regex(rs).source, 'g'))
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

function separate(text: string, pattern: RegExp): string[] {
  const parts: string[] = []
  let start = 0
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (!match[0]) {
      pattern.lastIndex++
      continue
    }
    parts.push(text.slice(start, match.index))
    start = pattern.lastIndex
  }
  parts.push(text.slice(start))
  return parts
}

const USAGE = [
  'Usage: mawk [Options] [Program] [file ...]',
  '',
  'Program:',
  '    The -f option value is the name of a file containing program text.',
  '    If no -f option is given, a "--" ends option processing; the following',
  '    parameters are the program text.',
  '',
  'Options:',
  '    -f program-file  Program  text is read from file instead of from the',
  '                     command-line.  Multiple -f options are accepted.',
  '    -F value         sets the field separator, FS, to value.',
  '    -v var=value     assigns value to program variable var.',
  '    --               unambiguous end of options.',
  '',
  '    Implementation-specific options are prefixed with "-W".  They can be',
  '    abbreviated:',
  '',
  '    -W version       show version information and exit.',
  '    -W compat        pre-POSIX 2001.',
  '    -W dump          show assembler-like listing of program and exit.',
  '    -W help          show this message and exit.',
  '    -W interactive   set unbuffered output, line-buffered input.',
  '    -W exec file     use file as program as well as last option.',
  '    -W posix         stricter POSIX checking.',
  '    -W random=number set initial random seed.',
  '    -W sprintf=number adjust size of sprintf buffer.',
  '    -W usage         show this message and exit.',
].join('\n')

const VERSION = [
  'mawk 1.3.4 20240123',
  'Copyright 2008-2023,2024, Thomas E. Dickey',
  'Copyright 1991-1996,2014, Michael D. Brennan',
  '',
  'random-funcs:       arc4random_stir/arc4random',
  'regex-funcs:        internal',
  '',
  'compiled limits:',
  'sprintf buffer      8192',
  'maximum-integer     9223372036854775808',
].join('\n')

const OPTIONS = [
  'version',
  'dump',
  'exec',
  'help',
  'interactive',
  'posix',
  'random',
  'sprintf',
  'traditional',
  'usage',
]

function rmEscape(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i + 1]
    if (text[i] !== '\\') out += text[i]
    else if (c === undefined) out += '\\'
    else if (c === '"' || c === '\\') {
      out += c
      i++
    } else if (
      c in SIMPLE_ESCAPES ||
      /[0-7]/.test(c) ||
      (c === 'x' && /[0-9a-fA-F]/.test(text[i + 2] ?? ''))
    ) {
      const [value, next] = unescape(text, i + 1)
      out += value
      i = next - 1
    } else {
      out += '\\' + c
      i++
    }
  }
  return out
}

export const awk: CommandHandler = streaming(async (ctx) => {
  AwkArray.limits = ctx.limits
  const args = ctx.args
  if (!args.length) {
    ctx.stderr.write(USAGE + '\n')
    return 0
  }
  let fs: string | undefined
  const assigns: [string, string][] = []
  const files: string[] = []
  let i = 0
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const arg = args[i]
    if (arg === '-') {
      if (!files.length) return 0
      break
    }
    if (arg === '--') {
      i++
      break
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0]
      if (name === 'version') {
        ctx.stdout.write(VERSION + '\n')
        return 0
      }
      if (name === 'help' || name === 'usage') {
        ctx.stdout.write(USAGE + '\n')
        return 0
      }
      if (
        !['posix', 'traditional', 'lint', 'lint-old', 'non-decimal-data', 're-interval'].includes(
          name,
        )
      )
        throw new CommandError('not an option: ' + arg, 2)
      continue
    }
    const option = arg[1]
    if (arg.length === 2 && i === args.length - 1) {
      if ('WFvf'.includes(option)) throw new CommandError('option ' + arg + ' lacks argument', 2)
      throw new CommandError('not an option: ' + arg, 2)
    }
    const value = arg.length > 2 ? arg.slice(2) : args[++i]
    if (option === 'W') {
      for (const part of value.split(',')) {
        const name = part.split('=')[0]
        if (!name) continue
        const known = OPTIONS.find((candidate) => candidate.startsWith(name))
        if (known === 'version') {
          ctx.stdout.write(VERSION + '\n')
          return 0
        }
        if (known === 'help' || known === 'usage') {
          ctx.stdout.write(USAGE + '\n')
          return 0
        }
        if (!known) ctx.stderr.write('awk: vacuous option: -W "' + name + '"\n')
      }
    } else if (option === 'v') {
      const eq = value.indexOf('=')
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(value))
        throw new CommandError('improper assignment: -v ' + value, 2)
      assigns.push([value.slice(0, eq), value.slice(eq + 1)])
    } else if (option === 'F') fs = value
    else if (option === 'f') files.push(value)
    else if (option !== 'r') throw new CommandError('not an option: ' + arg, 2)
  }
  const sources: string[] = []
  for (const file of files) {
    try {
      sources.push(binary(await ctx.fs.read(ctx.resolve(file))))
    } catch (error) {
      if (!(error instanceof FsError)) throw error
      throw new CommandError('cannot open "' + file + '" (No such file or directory)', 2)
    }
  }
  if (!files.length) {
    if (i >= args.length) return 0
    sources.push(bytes(args[i++]))
  }
  const operands = args.slice(i)
  const located = (message: string) => {
    if (!files.length) return message
    return message.replace(/(^|\nawk: )line (\d+): /g, (_, head: string, at: string) => {
      let line = Number(at)
      for (let index = 0; index < files.length; index++) {
        const lines = sources[index].split('\n').length
        if (line <= lines || index === files.length - 1)
          return head + files[index] + ': line ' + line + ': '
        line -= lines
      }
      return head + 'line ' + at + ': '
    })
  }
  let program: Program
  try {
    program = new Parser(lex(sources.join('\n'))).program()
  } catch (error) {
    if (error instanceof AwkError) throw new CommandError(chars(located(error.message)), 2)
    throw error
  }
  const interp = new Interpreter(ctx, program)
  try {
    interp.prepare()
  } catch (error) {
    if (error instanceof AwkError) throw new CommandError(chars(error.message), 2)
    throw error
  }
  if (fs !== undefined) interp.globals.set('FS', rmEscape(bytes(fs)))
  for (const [name, value] of assigns) interp.globals.set(name, new Strnum(rmEscape(bytes(value))))
  const argv = new Map<string, Value>([['0', 'awk']])
  operands.forEach((operand, index) => argv.set(String(index + 1), new Strnum(bytes(operand))))
  interp.globals.set('ARGV', argv)
  interp.globals.set('ARGC', operands.length + 1)
  const read = async (operand: string) => {
    try {
      return binary(await ctx.fs.read(ctx.resolve(chars(operand))))
    } catch (error) {
      if (!(error instanceof FsError)) throw error
      throw new AwkError(
        error.code === 'EISDIR'
          ? 'read error (Is a directory)'
          : 'cannot open "' + operand + '" (No such file or directory)',
      )
    }
  }
  const stdin = () => {
    const batch = batches(ctx.stdin)
    const next = async () => {
      const text = await batch()
      return text === null ? null : bytes(text)
    }
    const more = async (): Promise<string | null> => {
      if (interp.str(interp.scalar('RS')) === '\n') return next()
      let all = ''
      for (let text = await next(); text !== null; text = await next()) all += text
      return all || null
    }
    return { first: async () => (await more()) ?? '', more }
  }
  let index = 0
  let consumed = false
  interp.advance = async () => {
    for (;;) {
      let operand = '-'
      if (++index < toNum(interp.globals.get('ARGC') as Value)) {
        const value = interp.array('ARGV').get(String(index))
        operand = value === undefined ? '' : interp.str(value)
      } else if (consumed) return false
      if (!operand) continue
      const assignment = operand.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/)
      if (assignment) {
        interp.globals.set(assignment[1], new Strnum(rmEscape(assignment[2])))
        continue
      }
      consumed = true
      interp.globals.set('FILENAME', operand)
      interp.globals.set('FNR', 0)
      if (operand === '-') {
        const input = stdin()
        interp.load(await input.first())
        interp.more = input.more
      } else interp.load(await read(operand))
      interp.open = true
      return true
    }
  }
  let exitCode = 0
  try {
    let exiting = false
    try {
      for (const block of program.begin) await interp.statements(block)
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error
      exitCode = error.code
      exiting = true
    }
    if (!exiting && (program.rules.length || program.end.length))
      while (interp.open || (await interp.advance()))
        if (await runFile(interp, program)) {
          exitCode = interp.exitCode
          break
        }
    try {
      for (const block of program.end) await interp.statements(block)
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error
      exitCode = error.code
    }
    await interp.flushAll(true)
  } catch (error) {
    if (!(error instanceof AwkError)) {
      interp.flushOut()
      throw error
    }
    await interp.flushAll(true).catch((failure) => {
      if (!(failure instanceof AwkError)) throw failure
    })
    throw new CommandError(chars(error.message), 2)
  }
  return exitCode
})

async function runFile(interp: Interpreter, program: Program): Promise<boolean> {
  try {
    for (;;) {
      interp.skipped = false
      const result = interp.rules ? interp.scan() : await records(interp, program)
      if (result === 'pause') {
        interp.flushOut()
        await pause(interp.ctx)
        continue
      }
      if (result) return true
      if (interp.skipped || !interp.more) return false
      interp.flushOut()
      await pause(interp.ctx)
      const next = await interp.more()
      if (next === null) return false
      interp.load(next)
    }
  } finally {
    interp.more = undefined
    interp.open = false
    interp.load('')
  }
}

async function records(interp: Interpreter, program: Program): Promise<boolean> {
  for (;;) {
    const record = interp.next()
    if (record === undefined) break
    interp.globals.set('NR', toNum(interp.scalar('NR')) + 1)
    interp.globals.set('FNR', toNum(interp.scalar('FNR')) + 1)
    interp.setRecord(record)
    try {
      for (const rule of program.rules) {
        let matched: boolean
        if (!rule.pattern) matched = true
        else if (rule.end) {
          if (rule.active) {
            matched = true
            if (truthy(await interp.eval(rule.end))) rule.active = false
          } else if (truthy(await interp.eval(rule.pattern))) {
            matched = true
            rule.active = !truthy(await interp.eval(rule.end))
          } else matched = false
        } else matched = truthy(await interp.eval(rule.pattern))
        if (!matched) continue
        if (rule.action) await interp.statements(rule.action)
        else interp.print((interp.fields[0] ?? '') + interp.str(interp.scalar('ORS')))
      }
    } catch (error) {
      if (error instanceof NextSignal) continue
      if (error instanceof NextFileSignal) {
        interp.skipped = true
        break
      }
      if (error instanceof ExitSignal) {
        interp.exitCode = error.code
        return true
      }
      throw error
    }
  }
  return false
}

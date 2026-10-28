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
import { format, formatNumber, posixRegExp, type FormatValue } from '../Text.ts'
import { strftime } from './text.ts'
import { batches, pause } from './util.ts'

type Token = { type: string; value: string; line: number }

const KEYWORDS = new Set([
  'BEGIN',
  'END',
  'function',
  'func',
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
  'gensub',
  'systime',
  'strftime',
  'and',
  'or',
  'xor',
  'lshift',
  'rshift',
  'compl',
  'asort',
  'asorti',
])
const PUNCT = [
  '**=',
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
  '**',
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

function lex(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
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
      i++
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const n = source[++i]
          const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            '"': '"',
            '/': '/',
            a: '\x07',
            b: '\b',
            f: '\f',
            v: '\v',
          }
          if (n in map) value += map[n]
          else if (/[0-7]/.test(n)) {
            const oct = source.slice(i).match(/^[0-7]{1,3}/)![0]
            value += String.fromCharCode(parseInt(oct, 8))
            i += oct.length - 1
          } else if (n === '\n') line++
          else value += '\\' + n
          i++
          continue
        }
        value += source[i++]
      }
      if (i >= source.length) throw new AwkError('unterminated string')
      i++
      tokens.push({ type: 'string', value, line })
      continue
    }
    if (c === '/' && !operand()) {
      let value = ''
      i++
      let bracket = false
      while (i < source.length && (source[i] !== '/' || bracket)) {
        if (source[i] === '\n') throw new AwkError('unterminated regexp')
        if (source[i] === '\\' && i + 1 < source.length) {
          value += source[i + 1] === '/' ? '/' : source.slice(i, i + 2)
          i += 2
          continue
        }
        if (source[i] === '[') bracket = true
        else if (source[i] === ']' && bracket && !/\[\^?$/.test(value)) bracket = false
        value += source[i++]
      }
      i++
      tokens.push({ type: 'regex', value, line })
      continue
    }
    const number = source.slice(i).match(/^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/)
    if (number) {
      tokens.push({ type: 'number', value: number[0], line })
      i += number[0].length
      continue
    }
    const name = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)
    if (name) {
      const word = name[0]
      i += word.length
      if (KEYWORDS.has(word))
        tokens.push({ type: word === 'func' ? 'function' : word, value: word, line })
      else if (BUILTINS.has(word)) tokens.push({ type: 'builtin', value: word, line })
      else if (source[i] === '(') tokens.push({ type: 'funcname', value: word, line })
      else tokens.push({ type: 'name', value: word, line })
      continue
    }
    const punct = PUNCT.find((p) => source.startsWith(p, i))
    if (!punct)
      throw new AwkError(
        'syntax error at source line ' + line + ": unexpected character '" + c + "'",
      )
    tokens.push({
      type: 'punct',
      value: punct === '**=' ? '^=' : punct === '**' ? '^' : punct,
      line,
    })
    i += punct.length
  }
  tokens.push({ type: 'eof', value: '', line })
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
    throw new AwkError(
      'syntax error at source line ' +
        token.line +
        " near '" +
        (token.type === 'eof' ? 'end of program' : token.value.replace('\n', 'newline')) +
        "'",
    )
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
      if (token.type === 'BEGIN') {
        this.pos++
        this.newlines()
        program.begin.push(this.block())
      } else if (token.type === 'END') {
        this.pos++
        this.newlines()
        program.end.push(this.block())
      } else if (token.type === 'function') {
        this.pos++
        const name = this.peek()
        if (name.type !== 'funcname' && name.type !== 'name') this.fail()
        this.pos++
        this.take('(')
        const params: string[] = []
        while (!this.is(')')) {
          const param = this.peek()
          if (param.type !== 'name') this.fail()
          params.push(param.value)
          this.pos++
          if (this.is(',')) {
            this.pos++
            this.newlines()
          }
        }
        this.take(')')
        this.newlines()
        program.functions.set(name.value, { params, body: this.block() })
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
      this.terminators()
    }
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
        return { k: 'while', test, body: this.body() }
      }
      case 'do': {
        this.pos++
        const body = this.body()
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
          this.pos += 4
          return { k: 'forin', name, array, body: this.body() }
        }
        const init = this.is(';') ? undefined : this.simple()
        this.take(';')
        this.newlines()
        const test = this.is(';') ? undefined : this.expr()
        this.take(';')
        this.newlines()
        const step = this.is(')') ? undefined : this.simple()
        this.take(')')
        return { k: 'for', init, test, step, body: this.body() }
      }
      case 'next':
      case 'nextfile':
      case 'break':
      case 'continue':
        this.pos++
        this.end()
        return { k: token.type }
      case 'exit':
      case 'return': {
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
    this.newlines()
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
      this.pos++
      left = { k: 'in', subs: left.k === 'group' ? left.list : [left], name: name.value }
    }
    return left
  }

  match(noGt: boolean): Expr {
    let left = this.relation(noGt)
    while (this.is('~') || this.is('!~')) {
      const negate = this.tokens[this.pos++].value === '!~'
      left = { k: 'match', negate, left, right: this.relation(noGt) }
    }
    return left
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
      case 'regex':
        this.pos++
        return { k: 're', v: regex(token.value) }
      case 'name': {
        this.pos++
        if (this.is('[')) {
          this.pos++
          const subs = this.list(']')
          this.take(']')
          return { k: 'index', name: token.value, subs }
        }
        return { k: 'var', name: token.value }
      }
      case 'funcname': {
        this.pos++
        this.take('(')
        const args = this.list(')')
        this.take(')')
        return { k: 'call', name: token.value, args }
      }
      case 'builtin': {
        this.pos++
        if (token.value === 'length' && !this.is('('))
          return { k: 'builtin', name: 'length', args: [] }
        this.take('(')
        const args = this.list(')')
        this.take(')')
        return { k: 'builtin', name: token.value, args }
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

function regex(source: string): RegExp {
  try {
    return posixRegExp(source, true)
  } catch {
    throw new AwkError('invalid regular expression /' + source + '/')
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

const NUMERIC = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/

function looksNumeric(text: string): boolean {
  return NUMERIC.test(text)
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
  const match = text.match(/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/)
  if (match) return Number(match[0])
  const hex = text.match(/^\s*[+-]?0[xX][0-9a-fA-F]+/)
  if (hex) return 0
  const special = text.trim().match(/^([+-])(inf|nan)/i)
  if (special)
    return special[2].toLowerCase() === 'inf' ? (special[1] === '-' ? -Infinity : Infinity) : NaN
  return 0
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

type Piece = string | { spec: string; conv: string; plain: boolean }

const CONVERSION =
  /%([-+ 0#']*)(\*|\d+)?(?:\.(\*|\d*))?(l{0,2}|h{0,2}|j|z|L)?([diouxXfFeEgGsScbq%])/y

function compileFormat(spec: string): Piece[] | null {
  const pieces: Piece[] = []
  let literal = ''
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i]
    if (c !== '%') {
      literal += c
      continue
    }
    CONVERSION.lastIndex = i
    const match = CONVERSION.exec(spec)
    if (!match) {
      literal += c
      continue
    }
    i += match[0].length - 1
    if (match[5] === '%') {
      literal += '%'
      continue
    }
    if (match[2] === '*' || match[3] === '*') return null
    if (literal) pieces.push(literal)
    literal = ''
    const conv = match[5] === 'i' ? 'd' : match[5]
    pieces.push({
      spec: match[0],
      conv,
      plain: match[0].length === 2 || (match[0].length === 3 && match[4] === 'l'),
    })
  }
  if (literal) pieces.push(literal)
  return pieces
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

function strlen(text: string): number {
  return /[\uD800-\uDFFF]/.test(text) ? [...text].length : text.length
}

function substr(text: string, from: number, count: number): string {
  let start = Math.round(from)
  let length = Number.isNaN(count) ? 0 : count === Infinity ? Infinity : Math.round(count)
  if (Number.isNaN(start)) start = 1
  if (start < 1) start = 1
  if (length <= 0) return ''
  if (!/[\uD800-\uDFFF]/.test(text))
    return text.slice(start - 1, length === Infinity ? undefined : start - 1 + length)
  return [...text].slice(start - 1, length === Infinity ? undefined : start - 1 + length).join('')
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
  formats = new Map<string, Piece[] | null>()
  globalCache = new WeakMap<RegExp, RegExp>()
  fastExprs = new Map<Expr, Fn>()
  fastStmts = new Map<Stmt, Run>()
  fastFns = new Map<string, Run>()
  asyncFns = new Set<string>()
  asyncMemo = new Map<Expr | Stmt, boolean>()
  returned: Value = undefined
  rules?: { rule: Rule; pattern: Fn | undefined; end: Fn | undefined; action: Run | undefined }[]
  outputs = new Map<string, { kind: 'file' | 'pipe'; text: string; append: boolean }>()
  readers = new Map<string, { lines: string[]; pos: number }>()
  records: string[] | undefined
  source = ''
  cursor = 0
  buffer = ''
  preload?: () => Promise<void>
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
    set('RSTART', 0)
    set('RLENGTH', -1)
    set('FILENAME', '')
    const environ = new Map<string, Value>()
    for (const [key, value] of Object.entries(ctx.env)) environ.set(key, new Strnum(value))
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
    if (Number.isInteger(value) && Math.abs(value) < 1e16) return String(value)
    const spec = this.scalar(output ? 'OFMT' : 'CONVFMT')
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value < 0 ? '-inf' : 'inf'
    const fmt = this.str(spec)
    return fmt === '%.6g' ? formatNumber(value) : format(fmt, [value], false).text
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
      this.setNF(Math.max(0, Math.trunc(toNum(value))))
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
    if (fs.length === 1 && fs !== '\\') {
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
    if (fs === '') return [...text]
    if (fs.length === 1 && fs !== '\\') return text.split(fs)
    return text.split(this.dynamic(fs))
  }

  dynamic(source: string): RegExp {
    let re = this.regexCache.get(source)
    if (!re) {
      if (this.regexCache.size > 512) this.regexCache.clear()
      re = regex(source)
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
    if (index < 0) throw new AwkError('attempt to access field ' + index)
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
    if (index < 0) throw new AwkError('attempt to access field ' + index)
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
      result = x < y ? -1 : x > y ? 1 : x === y ? 0 : NaN
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
        if (!arg) return () => strlen(this.fields[0] ?? '')
        const fn = this.expr(arg, scope)
        if (arg.k === 'var') {
          const variable = arg.name
          return () => {
            const cell = this.lookup(variable).get(variable)
            return cell instanceof Map ? cell.size : strlen(this.str(fn()))
          }
        }
        return () => strlen(this.str(fn()))
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
      case 'gensub': {
        if (missing(3)) return fail('gensub: not enough arguments')
        const re = this.pattern(args[0], scope)
        const rest = args.slice(1).map((arg) => this.expr(arg, scope))
        return () => {
          const pattern = re()
          return this.gensub(
            pattern,
            rest.map((fn) => fn()),
          )
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
      case 'asort':
      case 'asorti':
        return () => this.sortArray(name, args)
    }
    const fns = args.map((arg) => this.expr(arg, scope))
    if (fns.length === 1) {
      const only = fns[0]
      if (name === 'tolower') return () => this.str(only()).toLowerCase()
      if (name === 'toupper') return () => this.str(only()).toUpperCase()
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
        if (!s.args.length)
          return () => {
            throw new AwkError('printf: no format')
          }
        const sink = this.sink(s.redirect, scope)
        const first = s.args[0]
        const pieces = first.k === 'str' ? compileFormat(first.v) : null
        if (pieces) {
          let used = 0
          const parts = pieces.map((piece): (() => string) => {
            if (typeof piece === 'string') return () => piece
            const arg = s.args[1 + used++]
            if (!arg) return () => format(piece.spec, [], false).text
            if (piece.plain && piece.conv === 's') {
              if (arg.k === 'field' || arg.k === 'str' || arg.k === 'concat')
                return this.text(arg, scope)
              const fn = this.expr(arg, scope)
              return () => {
                const value = fn()
                return value === undefined
                  ? ''
                  : typeof value === 'number'
                    ? formatNumber(value)
                    : typeof value === 'string'
                      ? value
                      : value.text
              }
            }
            const fn = this.expr(arg, scope)
            if (piece.plain && piece.conv === 'd')
              return () => {
                const value = fn()
                const number = typeof value === 'number' ? value : this.formatArg(value)
                if (typeof number !== 'number') return format(piece.spec, [number], false).text
                const int = Math.trunc(Number.isFinite(number) ? number : 0)
                return (int < 0 || Object.is(int, -0) ? '-' : '') + Math.abs(int).toString()
              }
            return () => format(piece.spec, [this.formatArg(fn())], false).text
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
          const values: FormatValue[] = []
          for (let i = 0; i < rest.length; i++) values.push(this.formatArg(rest[i]()))
          sink(this.sprintf(this.str(spec()), values))
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
          throw new ExitSignal(code ? Math.trunc(toNum(code())) : 0)
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
    this.ctx.stdout.write(text)
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
        if (b === 0) throw new AwkError('division by zero')
        return a / b
      case '%':
        if (b === 0) throw new AwkError('division by zero in %')
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
    if (plain && global && !counted) {
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
    const result = text.replace(global ? this.global(re) : re, (match) => {
      count++
      if (plain) return replacement
      let out = ''
      for (let i = 0; i < replacement.length; i++) {
        const c = replacement[i]
        if (c === '\\' && replacement[i + 1] === '&') {
          out += '&'
          i++
        } else if (c === '\\' && replacement[i + 1] === '\\') {
          out += '\\'
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
        if (!arg) return strlen(this.fields[0] ?? '')
        if (arg.k === 'var') {
          const cell = this.lookup(arg.name).get(arg.name)
          if (cell instanceof Map) return cell.size
        }
        return strlen(this.str(await this.eval(arg)))
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
      case 'gensub': {
        const re = await this.toRegex(args[0])
        const values: Value[] = []
        for (const arg of args.slice(1)) values.push(await this.eval(arg))
        return this.gensub(re, values)
      }
      case 'match': {
        const source = this.str(await this.eval(args[0]))
        return this.match(source, await this.toRegex(args[1]), args[2])
      }
      case 'asort':
      case 'asorti':
        return this.sortArray(name, args)
      case 'system': {
        await this.flushAll()
        const result = await this.ctx.exec(this.str(await this.eval(args[0])))
        this.print(result.stdout)
        return result.status
      }
      case 'close': {
        const key = this.str(await this.eval(args[0]))
        this.readers.delete(key)
        const output = this.outputs.get(key)
        if (!output) return -1
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
        return strlen(text(0))
      case 'substr':
        return substr(text(0), num(1), values.length > 2 ? num(2) : Infinity)
      case 'index':
        return text(0).indexOf(text(1)) + 1
      case 'sprintf':
        return values.length
          ? this.sprintf(
              text(0),
              values.slice(1).map((value) => this.formatArg(value)),
            )
          : ''
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
        return text(0).toLowerCase()
      case 'toupper':
        return text(0).toUpperCase()
      case 'systime':
        return Math.floor(Date.now() / 1000)
      case 'strftime':
        return strftime(
          values.length ? text(0) : '%a %b %e %H:%M:%S %Z %Y',
          new Date(values.length > 1 ? num(1) * 1000 : Date.now()),
        )
      case 'and':
        return Number(BigInt(Math.trunc(num(0))) & BigInt(Math.trunc(num(1))))
      case 'or':
        return Number(BigInt(Math.trunc(num(0))) | BigInt(Math.trunc(num(1))))
      case 'xor':
        return Number(BigInt(Math.trunc(num(0))) ^ BigInt(Math.trunc(num(1))))
      case 'lshift':
        return num(0) * 2 ** num(1)
      case 'rshift':
        return Math.floor(num(0) / 2 ** num(1))
      case 'compl':
        return Number(~BigInt(Math.trunc(num(0))) & 0x1fffffffffffffn)
      case 'fflush':
        return 0
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
            : source.split(separator)
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

  gensub(re: RegExp, values: Value[]): string {
    const replacement = this.str(values[0])
    const how = this.str(values[1])
    const target = values.length > 2 ? this.str(values[2]) : (this.fields[0] ?? '')
    const global = /^[gG]/.test(how)
    const which = global ? 0 : Math.max(1, Math.trunc(toNum(how)))
    let count = 0
    return target.replace(this.global(re), (...matchArgs: unknown[]) => {
      let end = matchArgs.length - 2
      if (typeof matchArgs[matchArgs.length - 1] === 'object') end--
      const groups = matchArgs.slice(0, end) as string[]
      count++
      if (!global && count !== which) return groups[0]
      return replacement.replace(/\\(\d)|&|\\&/g, (token, digit: string | undefined) =>
        token === '\\&' ? '&' : token === '&' ? groups[0] : (groups[Number(digit)] ?? ''),
      )
    })
  }

  match(source: string, re: RegExp, target: Expr | undefined): number {
    re.lastIndex = 0
    const found = re.exec(source)
    const start = found ? strlen(source.slice(0, found.index)) + 1 : 0
    const length = found ? strlen(found[0]) : -1
    this.globals.set('RSTART', start)
    this.globals.set('RLENGTH', length)
    if (target?.k === 'var' && found) {
      const array = this.array(target.name)
      array.clear()
      found.forEach((group, index) => array.set(String(index), group ?? ''))
    }
    return start
  }

  sortArray(name: string, args: Expr[]): number {
    const source = args[0]
    if (source?.k !== 'var') throw new AwkError(name + ': argument is not an array')
    const array = this.array(source.name)
    const items = name === 'asort' ? [...array.values()] : [...array.keys()]
    items.sort((a, b) =>
      isNumberish(a) && isNumberish(b) && typeof a !== 'string' && typeof b !== 'string'
        ? toNum(a) - toNum(b)
        : this.str(a) < this.str(b)
          ? -1
          : this.str(a) > this.str(b)
            ? 1
            : 0,
    )
    const target = args[1]?.k === 'var' ? this.array((args[1] as { name: string }).name) : array
    target.clear()
    items.forEach((item, index) => target.set(String(index + 1), item))
    return items.length
  }

  global(re: RegExp): RegExp {
    let global = this.globalCache.get(re)
    if (!global) {
      global = new RegExp(re.source, re.flags.replace('g', '') + 'g')
      this.globalCache.set(re, global)
    }
    return global
  }

  sprintf(spec: string, values: FormatValue[]): string {
    let pieces = this.formats.get(spec)
    if (pieces === undefined) {
      pieces = compileFormat(spec)
      if (this.formats.size > 256) this.formats.clear()
      this.formats.set(spec, pieces)
    }
    if (!pieces) return format(spec, values, false).text
    let out = ''
    let used = 0
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]
      if (typeof piece === 'string') {
        out += piece
        continue
      }
      const value = used < values.length ? values[used] : undefined
      used++
      if (piece.plain && piece.conv === 's')
        out += value === undefined ? '' : typeof value === 'number' ? formatNumber(value) : value
      else if (piece.plain && piece.conv === 'd' && typeof value === 'number') {
        const int = Math.trunc(Number.isFinite(value) ? value : 0)
        out += (int < 0 || Object.is(int, -0) ? '-' : '') + Math.abs(int).toString()
      } else out += format(piece.spec, value === undefined ? [] : [value], false).text
    }
    return out
  }

  formatArg(value: Value): FormatValue {
    if (typeof value === 'number') return value
    if (value === undefined) return ''
    if (value instanceof Strnum) return looksNumeric(value.text) ? Number(value.text) : value.text
    return value
  }

  async getline(e: Expr & { k: 'getline' }): Promise<Value> {
    let line: string | undefined
    if (e.command) {
      const command = this.str(await this.eval(e.command))
      let reader = this.readers.get(command)
      if (!reader) {
        await this.flushAll()
        const result = await this.ctx.exec(command)
        reader = { lines: splitRecords(result.stdout, '\n'), pos: 0 }
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
              ? await this.ctx.stdin.text()
              : decode(await this.ctx.fs.read(this.ctx.resolve(file)))
        } catch {
          return -1
        }
        reader = { lines: splitRecords(content, this.str(this.scalar('RS'))), pos: 0 }
        this.readers.set(file, reader)
      }
      line = reader.lines[reader.pos++]
    } else {
      if (this.preload && !this.pending()) {
        const preload = this.preload
        this.preload = undefined
        await preload()
      }
      line = this.next()
      while (line === undefined && this.more) {
        const text = await this.more()
        if (text === null) {
          this.more = undefined
          break
        }
        this.load(text)
        line = this.next()
      }
      if (line !== undefined) {
        this.globals.set('NR', toNum(this.scalar('NR')) + 1)
        this.globals.set('FNR', toNum(this.scalar('FNR')) + 1)
      }
    }
    if (line === undefined) return 0
    if (e.target) await this.assignTo(e.target, new Strnum(line))
    else {
      this.setRecord(line)
      if (e.command || e.file) this.globals.set('NR', toNum(this.scalar('NR')) + 1)
    }
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
      this.ctx.stderr.write(text)
      return
    }
    let output = this.outputs.get(key)
    if (!output) {
      output = { kind: op === '|' ? 'pipe' : 'file', text: '', append: op === '>>' }
      this.outputs.set(key, output)
    }
    output.text += text
    if (output.text.length > this.ctx.limits.maxBufferLength)
      throw new CommandError('output exceeded ' + this.ctx.limits.maxBufferLength + ' characters')
  }

  async flush(key: string, output: { kind: 'file' | 'pipe'; text: string; append: boolean }) {
    this.flushOut()
    if (output.kind === 'pipe') {
      const result = await this.ctx.exec(key, output.text)
      this.print(result.stdout)
    } else {
      await this.ctx.fs.write(this.ctx.resolve(key), encode(output.text), output.append)
      output.append = true
    }
    output.text = ''
  }

  async flushAll() {
    this.flushOut()
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
        if (!s.args.length) throw new AwkError('printf: no format')
        const values: FormatValue[] = []
        for (const arg of s.args.slice(1)) values.push(this.formatArg(await this.eval(arg)))
        await this.write(
          format(this.str(await this.eval(s.args[0])), values, false).text,
          s.redirect,
        )
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
        throw new ExitSignal(s.e ? Math.trunc(toNum(await this.eval(s.e))) : 0)
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
  const parts = text.split(rs.length === 1 ? rs : regex(rs))
  if (parts[parts.length - 1] === '' || parts[parts.length - 1] === '\n') parts.pop()
  return parts
}

export const awk: CommandHandler = streaming(async (ctx) => {
  AwkArray.limits = ctx.limits
  const args = ctx.args
  let fs: string | undefined
  const assigns: [string, string][] = []
  let source: string | undefined
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      i++
      break
    }
    if (arg.startsWith('-F')) fs = arg.length > 2 ? arg.slice(2) : args[++i]
    else if (arg.startsWith('-v')) {
      const assignment = arg.length > 2 ? arg.slice(2) : args[++i]
      const eq = assignment.indexOf('=')
      if (eq < 0) throw new CommandError('-v: invalid assignment ' + assignment, 2)
      assigns.push([assignment.slice(0, eq), assignment.slice(eq + 1)])
    } else if (arg === '-f')
      source = (source ?? '') + decode(await ctx.fs.read(ctx.resolve(args[++i]))) + '\n'
    else if (
      arg.startsWith('--') ||
      (arg.startsWith('-') && arg.length > 1 && !/^-[Fvf]/.test(arg))
    ) {
      if (arg === '-e' || arg === '--source') source = (source ?? '') + args[++i] + '\n'
      else continue
    } else break
  }
  if (source === undefined) {
    if (i >= args.length)
      throw new CommandError('usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]', 2)
    source = args[i++]
  }
  const operands = args.slice(i)
  let program: Program
  try {
    program = new Parser(lex(source)).program()
  } catch (error) {
    if (error instanceof AwkError) throw new CommandError(error.message, 2)
    throw error
  }
  const interp = new Interpreter(ctx, program)
  try {
    interp.prepare()
  } catch (error) {
    if (error instanceof AwkError) throw new CommandError(error.message, 2)
    throw error
  }
  const unescape = (value: string) =>
    value.replace(
      /\\(.)/g,
      (_, c: string) => ({ n: '\n', t: '\t', '\\': '\\', r: '\r' })[c] ?? '\\' + c,
    )
  if (fs !== undefined) interp.globals.set('FS', fs === 't' ? '\t' : unescape(fs))
  for (const [name, value] of assigns) interp.globals.set(name, new Strnum(unescape(value)))
  const argv = new Map<string, Value>([['0', 'awk']])
  operands.forEach((operand, index) => argv.set(String(index + 1), new Strnum(operand)))
  interp.globals.set('ARGV', argv)
  interp.globals.set('ARGC', operands.length + 1)
  let exitCode = 0
  let exiting = false
  let preloaded: string | undefined
  interp.preload = async () => {
    const operand = operands.find((operand) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(operand)) ?? '-'
    let text = ''
    try {
      text =
        operand === '-' ? await ctx.stdin.text() : decode(await ctx.fs.read(ctx.resolve(operand)))
    } catch (error) {
      if (!(error instanceof FsError)) throw error
    }
    preloaded = operand
    interp.globals.set('FILENAME', operand === '-' && !operands.includes('-') ? '' : operand)
    interp.load(text)
  }
  const stdin = () => {
    const next = batches(ctx.stdin)
    const more = async (): Promise<string | null> => {
      if (interp.str(interp.scalar('RS')) === '\n') return next()
      let all = ''
      for (let text = await next(); text !== null; text = await next()) all += text
      return all || null
    }
    return { first: async () => (await more()) ?? '', more }
  }
  try {
    try {
      for (const block of program.begin) await interp.statements(block)
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error
      exitCode = error.code
      exiting = true
    }
    if (!exiting && (program.rules.length || program.end.length)) {
      const inputs = operands.length ? operands : ['-']
      let consumed = false
      for (const operand of inputs) {
        const assignment = operand.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/)
        if (assignment) {
          interp.globals.set(assignment[1], new Strnum(unescape(assignment[2])))
          continue
        }
        consumed = true
        if (preloaded === operand) {
          preloaded = undefined
          if (await runFile(interp, program, undefined, operand)) {
            exiting = true
            exitCode = interp.exitCode
            break
          }
          continue
        }
        if (operand === '-') {
          const input = stdin()
          if (await runFile(interp, program, await input.first(), operand, input.more)) {
            exiting = true
            exitCode = interp.exitCode
            break
          }
          continue
        }
        let text: string
        try {
          text = decode(await ctx.fs.read(ctx.resolve(operand)))
        } catch (error) {
          if (!(error instanceof FsError)) throw error
          interp.flushOut()
          ctx.stderr.write('awk: cannot open "' + operand + '" (No such file or directory)\n')
          exitCode = 2
          continue
        }
        if (await runFile(interp, program, text, operand)) {
          exiting = true
          exitCode = interp.exitCode
          break
        }
      }
      if (!consumed && !exiting) {
        const input = preloaded === '-' ? undefined : stdin()
        if (
          await runFile(interp, program, input ? await input.first() : undefined, '', input?.more)
        ) {
          exiting = true
          exitCode = interp.exitCode
        }
      }
    }
    try {
      for (const block of program.end) await interp.statements(block)
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error
      exitCode = error.code
    }
  } catch (error) {
    if (error instanceof AwkError) {
      await interp.flushAll()
      throw new CommandError(error.message, 2)
    }
    interp.flushOut()
    if (error instanceof NextSignal || error instanceof NextFileSignal)
      throw new CommandError('next used in BEGIN or END action', 2)
    throw error
  }
  await interp.flushAll()
  return exitCode
})

async function runFile(
  interp: Interpreter,
  program: Program,
  text: string | undefined,
  name: string,
  more?: () => Promise<string | null>,
): Promise<boolean> {
  interp.preload = undefined
  interp.globals.set('FILENAME', name)
  if (text !== undefined) {
    interp.globals.set('FNR', 0)
    interp.load(text)
  }
  interp.more = more
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

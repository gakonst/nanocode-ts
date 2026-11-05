import { CommandError, type CommandHandler } from '../Shell.ts'
import { FsError } from '../../FileSystem.ts'
import { decode } from '../Fs.ts'
import { strftime } from './text.ts'
import { pause } from './util.ts'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type PathKey = string | number | { start: number | null; end: number | null }
type Path = PathKey[]

export class JqError extends Error {
  readonly value: Json
  constructor(value: Json) {
    super(typeof value === 'string' ? value : JSON.stringify(value))
    this.value = value
  }
}

class CompileError extends Error {
  readonly at: number
  constructor(message: string, at: number) {
    super(message)
    this.at = at
  }
}

class BreakSignal {
  readonly label: string
  constructor(label: string) {
    this.label = label
  }
}

type Token = { t: string; v: string; at: number; parts?: (string | string[])[] }

const BUILTINS = [
  'input_line_number/0',
  'input_filename/0',
  'now/0',
  'localtime/0',
  'gmtime/0',
  'mktime/0',
  'strflocaltime/1',
  'strftime/1',
  'strptime/1',
  'stderr/0',
  'debug/0',
  'input/0',
  'modulemeta/0',
  'get_jq_origin/0',
  'get_prog_origin/0',
  'get_search_list/0',
  'halt_error/1',
  'halt/0',
  'env/0',
  'format/1',
  'error/0',
  'max/0',
  'min/0',
  'sort/0',
  'nan/0',
  'infinite/0',
  'isnormal/0',
  'isnan/0',
  'isinfinite/0',
  'type/0',
  'utf8bytelength/0',
  'length/0',
  'contains/1',
  'has/1',
  'delpaths/1',
  'getpath/1',
  'setpath/2',
  'implode/0',
  'explode/0',
  'split/1',
  'rtrimstr/1',
  'ltrimstr/1',
  'endswith/1',
  'startswith/1',
  'keys_unsorted/0',
  'keys/0',
  'tostring/0',
  'tonumber/0',
  'fromjson/0',
  'tojson/0',
  'lgamma_r/0',
  'modf/0',
  'frexp/0',
  'ldexp/2',
  'trunc/0',
  'significand/0',
  'scalbln/2',
  'scalb/2',
  'round/0',
  'rint/0',
  'nexttoward/2',
  'nextafter/2',
  'nearbyint/0',
  'logb/0',
  'log1p/0',
  'lgamma/0',
  'gamma/0',
  'fmod/2',
  'fmin/2',
  'fmax/2',
  'fma/3',
  'fdim/2',
  'fabs/0',
  'expm1/0',
  'exp10/0',
  'erfc/0',
  'erf/0',
  'drem/2',
  'copysign/2',
  'ceil/0',
  'yn/2',
  'jn/2',
  'y1/0',
  'y0/0',
  'tgamma/0',
  'tanh/0',
  'tan/0',
  'sqrt/0',
  'sinh/0',
  'sin/0',
  'remainder/2',
  'pow/2',
  'log2/0',
  'log10/0',
  'log/0',
  'j1/0',
  'j0/0',
  'hypot/2',
  'floor/0',
  'exp2/0',
  'exp/0',
  'cosh/0',
  'cos/0',
  'cbrt/0',
  'atanh/0',
  'atan2/2',
  'atan/0',
  'asinh/0',
  'asin/0',
  'acosh/0',
  'acos/0',
  'empty/0',
  'not/0',
  'path/1',
  'range/2',
  'halt_error/0',
  'error/1',
  'map/1',
  'select/1',
  'sort_by/1',
  'group_by/1',
  'unique/0',
  'unique_by/1',
  'max_by/1',
  'min_by/1',
  'add/0',
  'del/1',
  'abs/0',
  'map_values/1',
  'recurse/1',
  'recurse/2',
  'recurse/0',
  'to_entries/0',
  'from_entries/0',
  'with_entries/1',
  'reverse/0',
  'indices/1',
  'index/1',
  'rindex/1',
  'paths/0',
  'paths/1',
  'isfinite/0',
  'arrays/0',
  'objects/0',
  'iterables/0',
  'booleans/0',
  'numbers/0',
  'normals/0',
  'finites/0',
  'strings/0',
  'nulls/0',
  'values/0',
  'scalars/0',
  'join/1',
  'flatten/1',
  'flatten/0',
  'range/1',
  'fromdateiso8601/0',
  'todateiso8601/0',
  'fromdate/0',
  'todate/0',
  'match/2',
  'match/1',
  'test/2',
  'test/1',
  'capture/2',
  'capture/1',
  'scan/2',
  'scan/1',
  'splits/2',
  'splits/1',
  'split/2',
  'sub/3',
  'sub/2',
  'gsub/3',
  'gsub/2',
  'while/2',
  'until/2',
  'limit/2',
  'range/3',
  'first/1',
  'isempty/1',
  'all/2',
  'any/2',
  'all/1',
  'any/1',
  'all/0',
  'any/0',
  'last/1',
  'nth/2',
  'first/0',
  'last/0',
  'nth/1',
  'combinations/0',
  'combinations/1',
  'transpose/0',
  'in/1',
  'inside/1',
  'repeat/1',
  'inputs/0',
  'ascii_downcase/0',
  'ascii_upcase/0',
  'truncate_stream/1',
  'fromstream/1',
  'tostream/0',
  'bsearch/1',
  'walk/1',
  'pick/1',
  'debug/1',
  'INDEX/2',
  'INDEX/1',
  'JOIN/2',
  'JOIN/3',
  'JOIN/4',
  'IN/1',
  'IN/2',
  'pow10/0',
  'builtins/0',
]

const DEFINED = new Set(BUILTINS)

const PUNCT = [
  '?//=',
  '?//',
  '|=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '//=',
  '==',
  '!=',
  '<=',
  '>=',
  '//',
  '..',
  '|',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ':',
  ';',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '?',
  '.',
]
const KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'end',
  'as',
  'def',
  'reduce',
  'foreach',
  'try',
  'catch',
  'label',
  'import',
  'include',
  'and',
  'or',
  '__loc__',
])

function lex(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const start = i
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '"') {
      const parts: (string | string[])[] = []
      let text = ''
      i++
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const n = source[i + 1]
          if (n === '(') {
            let depth = 1
            let j = i + 2
            let inString = false
            while (j < source.length && depth > 0) {
              const ch = source[j]
              if (inString) {
                if (ch === '\\') j++
                else if (ch === '"') inString = false
              } else if (ch === '"') inString = true
              else if (ch === '(') depth++
              else if (ch === ')') depth--
              j++
            }
            if (depth) throw new JqError('unterminated string interpolation')
            if (text) parts.push(text)
            text = ''
            parts.push([source.slice(i + 2, j - 1)])
            i = j
            continue
          }
          const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            b: '\b',
            f: '\f',
            '\\': '\\',
            '"': '"',
            '/': '/',
          }
          if (n === 'u') {
            text += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16))
            i += 6
            continue
          }
          if (!(n in map)) throw new JqError('invalid escape \\' + n)
          text += map[n]
          i += 2
          continue
        }
        text += source[i++]
      }
      if (i >= source.length) throw new JqError('unterminated string literal')
      i++
      if (text || !parts.length) parts.push(text)
      tokens.push({ t: 'str', v: '', at: start, parts })
      continue
    }
    const number = source.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/)
    if (
      number &&
      !(c === '.' && tokens.length && [')', ']', '}'].includes(tokens[tokens.length - 1].v))
    ) {
      tokens.push({ t: 'num', v: number[0], at: start })
      i += number[0].length
      continue
    }
    if (c === '.' && /[A-Za-z_]/.test(source[i + 1] ?? '')) {
      const name = source.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)![0]
      tokens.push({ t: 'field', v: name, at: start })
      i += 1 + name.length
      continue
    }
    if (c === '$') {
      const name = source.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)?/)
      if (!name) throw new JqError("syntax error: unexpected '$'")
      tokens.push({ t: 'var', v: name[0], at: start })
      i += 1 + name[0].length
      continue
    }
    if (c === '@') {
      const name = source.slice(i + 1).match(/^[A-Za-z0-9_]+/)
      if (!name) throw new JqError("syntax error: unexpected '@'")
      tokens.push({ t: 'format', v: name[0], at: start })
      i += 1 + name[0].length
      continue
    }
    const ident = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*/)
    if (ident) {
      tokens.push({ t: KEYWORDS.has(ident[0]) ? ident[0] : 'ident', v: ident[0], at: start })
      i += ident[0].length
      continue
    }
    const punct = PUNCT.find((p) => source.startsWith(p, i))
    if (!punct)
      throw new CompileError(
        'syntax error, unexpected INVALID_CHARACTER' +
          (tokens.length ? '' : ', expecting end of file') +
          ' (Unix shell quoting issues?)',
        start,
      )
    tokens.push({ t: punct, v: punct, at: start })
    i += punct.length
  }
  tokens.push({ t: 'eof', v: '', at: tokens[tokens.length - 1]?.at ?? 0 })
  return tokens
}

type Node =
  | { k: 'identity' }
  | { k: 'recurse' }
  | { k: 'literal'; v: Json }
  | { k: 'string'; parts: (string | Node)[]; format?: string }
  | { k: 'format'; name: string }
  | { k: 'index'; target: Node; key: Node; optional?: boolean }
  | { k: 'slice'; target: Node; from?: Node; to?: Node }
  | { k: 'iterate'; target: Node }
  | { k: 'pipe' | 'comma' | 'alt'; left: Node; right: Node }
  | { k: 'binop'; op: string; left: Node; right: Node }
  | { k: 'and' | 'or'; left: Node; right: Node }
  | { k: 'neg'; e: Node }
  | { k: 'array'; e?: Node }
  | { k: 'object'; entries: { key: Node; value?: Node }[] }
  | { k: 'if'; cond: Node; then: Node; elifs: { cond: Node; then: Node }[]; else?: Node }
  | { k: 'try'; body: Node; handler?: Node }
  | { k: 'reduce'; source: Node; pattern: Pattern; init: Node; update: Node }
  | { k: 'foreach'; source: Node; pattern: Pattern; init: Node; update: Node; extract?: Node }
  | { k: 'def'; name: string; params: string[]; body: Node; rest: Node }
  | { k: 'call'; name: string; args: Node[]; at?: number }
  | { k: 'var'; name: string; at?: number }
  | { k: 'as'; source: Node; patterns: Pattern[]; body: Node }
  | { k: 'assign'; op: string; left: Node; right: Node }
  | { k: 'label'; name: string; body: Node }
  | { k: 'break'; name: string; at?: number }

type Pattern =
  | { k: 'var'; name: string }
  | { k: 'array'; items: Pattern[] }
  | { k: 'object'; entries: { key: Node; name?: string; pattern?: Pattern }[] }

class Parser {
  tokens: Token[]
  pos = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]
  }

  is(t: string): boolean {
    return this.peek().t === t
  }

  take(t: string): Token {
    if (!this.is(t)) this.fail()
    return this.tokens[this.pos++]
  }

  fail(expecting?: string): never {
    const token = this.peek()
    const name =
      expecting && token.v && ')]}'.includes(token.v) ? 'INVALID_CHARACTER' : tokenName(token)
    throw new CompileError(
      'syntax error, unexpected ' +
        name +
        (expecting ? ', expecting ' + expecting : '') +
        ' (Unix shell quoting issues?)',
      token.at,
    )
  }

  program(): Node {
    const node = this.pipe()
    if (!this.is('eof')) this.fail('end of file')
    return node
  }

  pipe(noComma = false): Node {
    if (this.is('def')) {
      const def = this.definition()
      return { ...def, rest: this.pipe(noComma) }
    }
    if (this.is('label')) {
      this.pos++
      const name = this.take('var').v
      this.take('|')
      return { k: 'label', name, body: this.pipe(noComma) }
    }
    const left = noComma ? this.alt() : this.comma()
    if (this.is('as')) {
      this.pos++
      const patterns = [this.pattern()]
      while (this.is('?//')) {
        this.pos++
        patterns.push(this.pattern())
      }
      this.take('|')
      return { k: 'as', source: left, patterns, body: this.pipe(noComma) }
    }
    if (this.is('|')) {
      this.pos++
      return { k: 'pipe', left, right: this.pipe(noComma) }
    }
    return left
  }

  definition(): Node & { k: 'def' } {
    this.take('def')
    const name = this.peek()
    if (name.t !== 'ident' && !KEYWORDS.has(name.t)) this.fail()
    this.pos++
    const params: string[] = []
    if (this.is('(')) {
      this.pos++
      for (;;) {
        const param = this.peek()
        if (param.t === 'var') params.push('$' + param.v)
        else if (param.t === 'ident') params.push(param.v)
        else this.fail()
        this.pos++
        if (this.is(';')) {
          this.pos++
          continue
        }
        break
      }
      this.take(')')
    }
    this.take(':')
    const body = this.pipe()
    this.take(';')
    return { k: 'def', name: name.v, params, body, rest: { k: 'identity' } }
  }

  pattern(): Pattern {
    if (this.is('var')) return { k: 'var', name: this.tokens[this.pos++].v }
    if (this.is('[')) {
      this.pos++
      const items: Pattern[] = []
      if (!this.is(']')) {
        for (;;) {
          items.push(this.pattern())
          if (!this.is(',')) break
          this.pos++
        }
      }
      this.take(']')
      return { k: 'array', items }
    }
    if (this.is('{')) {
      this.pos++
      const entries: { key: Node; name?: string; pattern?: Pattern }[] = []
      for (;;) {
        const token = this.peek()
        if (token.t === 'var') {
          this.pos++
          const entry: { key: Node; name?: string; pattern?: Pattern } = {
            key: { k: 'literal', v: token.v },
            name: token.v,
          }
          if (this.is(':')) {
            this.pos++
            entry.pattern = this.pattern()
          }
          entries.push(entry)
        } else {
          let key: Node
          if (token.t === 'ident' || KEYWORDS.has(token.t)) {
            this.pos++
            key = { k: 'literal', v: token.v }
          } else if (token.t === 'str') key = this.term()
          else if (token.t === '(') {
            this.pos++
            key = this.pipe()
            this.take(')')
          } else this.fail()
          this.take(':')
          entries.push({ key, pattern: this.pattern() })
        }
        if (!this.is(',')) break
        this.pos++
      }
      this.take('}')
      return { k: 'object', entries }
    }
    this.fail()
  }

  comma(): Node {
    let left = this.alt()
    while (this.is(',')) {
      this.pos++
      left = { k: 'comma', left, right: this.alt() }
    }
    return left
  }

  alt(): Node {
    const left = this.assign()
    if (this.is('//')) {
      this.pos++
      return { k: 'alt', left, right: this.alt() }
    }
    return left
  }

  assign(): Node {
    const left = this.or()
    if (['=', '|=', '+=', '-=', '*=', '/=', '%=', '//='].includes(this.peek().t)) {
      const op = this.tokens[this.pos++].t
      return { k: 'assign', op, left, right: this.alt() }
    }
    return left
  }

  or(): Node {
    let left = this.and()
    while (this.is('or')) {
      this.pos++
      left = { k: 'or', left, right: this.and() }
    }
    return left
  }

  and(): Node {
    let left = this.compare()
    while (this.is('and')) {
      this.pos++
      left = { k: 'and', left, right: this.compare() }
    }
    return left
  }

  compare(): Node {
    const left = this.additive()
    if (['==', '!=', '<', '<=', '>', '>='].includes(this.peek().t)) {
      const op = this.tokens[this.pos++].t
      return { k: 'binop', op, left, right: this.additive() }
    }
    return left
  }

  additive(): Node {
    let left = this.multiplicative()
    while (this.is('+') || this.is('-')) {
      const op = this.tokens[this.pos++].t
      left = { k: 'binop', op, left, right: this.multiplicative() }
    }
    return left
  }

  multiplicative(): Node {
    let left = this.unary()
    while (this.is('*') || this.is('/') || this.is('%')) {
      const op = this.tokens[this.pos++].t
      left = { k: 'binop', op, left, right: this.unary() }
    }
    return left
  }

  unary(): Node {
    if (this.is('-')) {
      this.pos++
      return { k: 'neg', e: this.postfix() }
    }
    return this.postfix()
  }

  postfix(): Node {
    let node = this.term()
    for (;;) {
      if (this.is('field')) {
        node = { k: 'index', target: node, key: { k: 'literal', v: this.tokens[this.pos++].v } }
      } else if (this.is('.') && this.peek(1).t === 'str') {
        this.pos++
        node = { k: 'index', target: node, key: this.term() }
      } else if (this.is('[') || (this.is('.') && this.peek(1).t === '[')) {
        if (this.is('.')) this.pos++
        node = this.bracket(node)
      } else if (this.is('?')) {
        this.pos++
        node = { k: 'try', body: node }
      } else return node
    }
  }

  bracket(target: Node): Node {
    this.take('[')
    if (this.is(']')) {
      this.pos++
      return { k: 'iterate', target }
    }
    if (this.is(':')) {
      this.pos++
      const to = this.pipe()
      this.take(']')
      return { k: 'slice', target, to }
    }
    const key = this.pipe()
    if (this.is(':')) {
      this.pos++
      const to = this.is(']') ? undefined : this.pipe()
      this.take(']')
      return { k: 'slice', target, from: key, to }
    }
    this.take(']')
    return { k: 'index', target, key }
  }

  string(token: Token, format?: string): Node {
    const parts = (token.parts ?? []).map((part) =>
      typeof part === 'string' ? part : new Parser(lex(part[0])).program(),
    )
    if (parts.length === 1 && typeof parts[0] === 'string' && !format)
      return { k: 'literal', v: parts[0] }
    return { k: 'string', parts, format }
  }

  term(): Node {
    const token = this.peek()
    switch (token.t) {
      case 'num':
        this.pos++
        return { k: 'literal', v: Number(token.v) }
      case 'str':
        this.pos++
        return this.string(token)
      case 'format':
        this.pos++
        if (this.is('str')) return this.string(this.tokens[this.pos++], token.v)
        return { k: 'format', name: token.v }
      case '.':
        this.pos++
        if (this.is('str')) return { k: 'index', target: { k: 'identity' }, key: this.term() }
        return { k: 'identity' }
      case '..':
        this.pos++
        return { k: 'recurse' }
      case 'field':
        this.pos++
        return { k: 'index', target: { k: 'identity' }, key: { k: 'literal', v: token.v } }
      case 'var':
        this.pos++
        return { k: 'var', name: token.v, at: token.at }
      case '__loc__':
        this.pos++
        return { k: 'literal', v: { file: '<stdin>', line: 1 } }
      case '(': {
        this.pos++
        const node = this.pipe()
        this.take(')')
        return node
      }
      case '[': {
        this.pos++
        if (this.is(']')) {
          this.pos++
          return { k: 'array' }
        }
        const e = this.pipe()
        this.take(']')
        return { k: 'array', e }
      }
      case '{':
        return this.object()
      case 'if': {
        this.pos++
        const cond = this.pipe()
        this.take('then')
        const then = this.pipe()
        const elifs: { cond: Node; then: Node }[] = []
        let otherwise: Node | undefined
        while (this.is('elif')) {
          this.pos++
          const c = this.pipe()
          this.take('then')
          elifs.push({ cond: c, then: this.pipe() })
        }
        if (this.is('else')) {
          this.pos++
          otherwise = this.pipe()
        }
        this.take('end')
        return { k: 'if', cond, then, elifs, else: otherwise }
      }
      case 'try': {
        this.pos++
        const body = this.postfixNoTry()
        if (this.is('catch')) {
          this.pos++
          return { k: 'try', body, handler: this.postfixNoTry() }
        }
        return { k: 'try', body }
      }
      case 'reduce': {
        this.pos++
        const source = this.postfix()
        this.take('as')
        const pattern = this.pattern()
        this.take('(')
        const init = this.pipe()
        this.take(';')
        const update = this.pipe()
        this.take(')')
        return { k: 'reduce', source, pattern, init, update }
      }
      case 'foreach': {
        this.pos++
        const source = this.postfix()
        this.take('as')
        const pattern = this.pattern()
        this.take('(')
        const init = this.pipe()
        this.take(';')
        const update = this.pipe()
        let extract: Node | undefined
        if (this.is(';')) {
          this.pos++
          extract = this.pipe()
        }
        this.take(')')
        return { k: 'foreach', source, pattern, init, update, extract }
      }
      case 'def': {
        const def = this.definition()
        return { ...def, rest: this.pipe() }
      }
      case 'ident': {
        this.pos++
        if ((token.v === 'true' || token.v === 'false' || token.v === 'null') && !this.is('('))
          return { k: 'literal', v: token.v === 'null' ? null : token.v === 'true' }
        if (token.v === 'break' && this.is('var'))
          return { k: 'break', name: this.tokens[this.pos++].v, at: token.at }
        const args: Node[] = []
        if (this.is('(')) {
          this.pos++
          for (;;) {
            args.push(this.pipe())
            if (!this.is(';')) break
            this.pos++
          }
          this.take(')')
        }
        return { k: 'call', name: token.v, args, at: token.at }
      }
      case '-': {
        this.pos++
        return { k: 'neg', e: this.postfix() }
      }
    }
    this.fail()
  }

  postfixNoTry(): Node {
    let node = this.term()
    for (;;) {
      if (this.is('field'))
        node = { k: 'index', target: node, key: { k: 'literal', v: this.tokens[this.pos++].v } }
      else if (this.is('[') || (this.is('.') && this.peek(1).t === '[')) {
        if (this.is('.')) this.pos++
        node = this.bracket(node)
      } else return node
    }
  }

  object(): Node {
    this.take('{')
    const entries: { key: Node; value?: Node }[] = []
    while (!this.is('}')) {
      const token = this.peek()
      let key: Node
      let value: Node | undefined
      if (token.t === 'var') {
        this.pos++
        key = { k: 'literal', v: token.v }
        value = { k: 'var', name: token.v, at: token.at }
      } else if (token.t === 'ident' || KEYWORDS.has(token.t)) {
        this.pos++
        key = { k: 'literal', v: token.v }
      } else if (token.t === 'num') {
        this.pos++
        key = { k: 'literal', v: token.v }
      } else if (token.t === 'str' || token.t === 'format') key = this.term()
      else if (token.t === '(') {
        this.pos++
        key = this.pipe()
        this.take(')')
      } else this.fail()
      if (this.is(':')) {
        this.pos++
        value = this.objectValue()
      } else if (!value) value = { k: 'index', target: { k: 'identity' }, key }
      entries.push({ key, value })
      if (!this.is(',')) break
      this.pos++
    }
    this.take('}')
    return { k: 'object', entries }
  }

  objectValue(): Node {
    let left: Node = this.is('-') ? (this.pos++, { k: 'neg', e: this.postfix() }) : this.postfix()
    if (this.is('|')) {
      this.pos++
      left = { k: 'pipe', left, right: this.objectValue() }
    } else if (
      ['+', '-', '*', '/', '%', '//', '==', '!=', '<', '<=', '>', '>=', 'and', 'or'].includes(
        this.peek().t,
      )
    ) {
      const op = this.peek().t
      this.pos++
      const right = this.objectValue()
      if (op === '//') return { k: 'alt', left, right }
      if (op === 'and' || op === 'or') return { k: op, left, right }
      return { k: 'binop', op, left, right }
    }
    return left
  }
}

type Closure = { params: string[]; body: Node; env: Env }

class Env {
  readonly parent?: Env
  vars = new Map<string, Json>()
  funcs = new Map<string, Closure>()

  constructor(parent?: Env) {
    this.parent = parent
  }

  variable(name: string): Json {
    for (let env: Env | undefined = this; env; env = env.parent)
      if (env.vars.has(name)) return env.vars.get(name)!
    throw new JqError('$' + name + ' is not defined')
  }

  func(name: string, arity: number): Closure | undefined {
    const key = name + '/' + arity
    for (let env: Env | undefined = this; env; env = env.parent) {
      const fn = env.funcs.get(key)
      if (fn) return fn
    }
    return undefined
  }
}

function typeOf(value: Json): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

const ORDER = ['null', 'boolean', 'number', 'string', 'array', 'object']

export function compare(a: Json, b: Json): number {
  const ta = typeOf(a)
  const tb = typeOf(b)
  if (ta !== tb) {
    if (ta === 'boolean' && tb === 'boolean') return 0
    return ORDER.indexOf(ta) - ORDER.indexOf(tb)
  }
  if (ta === 'boolean') return a === b ? 0 : a === false ? -1 : 1
  if (ta === 'number') {
    if (Number.isNaN(a)) return -1
    if (Number.isNaN(b)) return 1
    return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0
  }
  if (ta === 'string')
    return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0
  if (ta === 'array') {
    const x = a as Json[]
    const y = b as Json[]
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const result = compare(x[i], y[i])
      if (result) return result
    }
    return x.length - y.length
  }
  if (ta === 'null') return 0
  const x = a as Record<string, Json>
  const y = b as Record<string, Json>
  const kx = Object.keys(x).sort()
  const ky = Object.keys(y).sort()
  const keys = compare(kx, ky)
  if (keys) return keys
  for (const key of kx) {
    const result = compare(x[key], y[key])
    if (result) return result
  }
  return 0
}

function truthy(value: Json): boolean {
  return value !== null && value !== false
}

function describe(value: Json): string {
  const text = JSON.stringify(value)
  return typeOf(value) + ' (' + (text.length > 11 ? text.slice(0, 10) + '...' : text) + ')'
}

function add(a: Json, b: Json): Json {
  if (a === null) return b
  if (b === null) return a
  if (typeof a === 'number' && typeof b === 'number') return a + b
  if (typeof a === 'string' && typeof b === 'string') return a + b
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  if (typeOf(a) === 'object' && typeOf(b) === 'object')
    return { ...(a as object), ...(b as object) } as Json
  throw new JqError(describe(a) + ' and ' + describe(b) + ' cannot be added')
}

function deepMerge(a: Record<string, Json>, b: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const existing = out[key]
    out[key] =
      typeOf(existing) === 'object' && typeOf(value) === 'object'
        ? deepMerge(existing as Record<string, Json>, value as Record<string, Json>)
        : value
  }
  return out
}

function binop(op: string, a: Json, b: Json): Json {
  switch (op) {
    case '+':
      return add(a, b)
    case '-':
      if (typeof a === 'number' && typeof b === 'number') return a - b
      if (Array.isArray(a) && Array.isArray(b))
        return a.filter((item) => !b.some((other) => compare(item, other) === 0))
      throw new JqError(describe(a) + ' and ' + describe(b) + ' cannot be subtracted')
    case '*':
      if (typeof a === 'number' && typeof b === 'number') return a * b
      if (typeof a === 'string' && typeof b === 'number')
        return Math.trunc(b) < 0 ? null : a.repeat(Math.trunc(b))
      if (typeof b === 'string' && typeof a === 'number')
        return Math.trunc(a) < 0 ? null : b.repeat(Math.trunc(a))
      if (typeOf(a) === 'object' && typeOf(b) === 'object')
        return deepMerge(a as Record<string, Json>, b as Record<string, Json>)
      throw new JqError(describe(a) + ' and ' + describe(b) + ' cannot be multiplied')
    case '/':
      if (typeof a === 'number' && typeof b === 'number') {
        if (b === 0)
          throw new JqError(
            describe(a) + ' and ' + describe(b) + ' cannot be divided because the divisor is zero',
          )
        return a / b
      }
      if (typeof a === 'string' && typeof b === 'string') return split(a, b)
      throw new JqError(describe(a) + ' and ' + describe(b) + ' cannot be divided')
    case '%':
      if (typeof a === 'number' && typeof b === 'number') {
        if (Math.trunc(b) === 0)
          throw new JqError(
            describe(a) + ' and ' + describe(b) + ' cannot be divided because the divisor is zero',
          )
        return Math.trunc(a) % Math.trunc(b)
      }
      throw new JqError(describe(a) + ' and ' + describe(b) + ' cannot be divided')
    case '==':
      return compare(a, b) === 0
    case '!=':
      return compare(a, b) !== 0
    case '<':
      return compare(a, b) < 0
    case '<=':
      return compare(a, b) <= 0
    case '>':
      return compare(a, b) > 0
    case '>=':
      return compare(a, b) >= 0
  }
  throw new JqError('unknown operator ' + op)
}

function split(a: string, b: string): Json {
  if (a === '') return []
  return b === '' ? [...a] : a.split(b)
}

function index(value: Json, key: PathKey): Json {
  if (value === null) return null
  if (typeof key === 'object') {
    if (typeof value === 'string' || Array.isArray(value)) {
      const length = value.length
      let from =
        key.start === null ? 0 : key.start < 0 ? Math.max(0, length + key.start) : key.start
      let to = key.end === null ? length : key.end < 0 ? length + key.end : key.end
      from = Math.floor(from)
      to = Math.ceil(to)
      return value.slice(from, Math.max(from, to)) as Json
    }
    throw new JqError('Cannot index ' + typeOf(value) + ' with object')
  }
  if (typeof key === 'string') {
    if (typeOf(value) === 'object') return (value as Record<string, Json>)[key] ?? null
    throw new JqError('Cannot index ' + typeOf(value) + ' with string "' + key + '"')
  }
  if (Array.isArray(value)) {
    const i = Math.floor(key < 0 ? value.length + key : key)
    return value[i] ?? null
  }
  throw new JqError('Cannot index ' + typeOf(value) + ' with number')
}

function setPath(root: Json, path: Path, value: Json, at = 0): Json {
  if (at >= path.length) return value
  const key = path[at]
  if (typeof key === 'string') {
    if (root !== null && typeOf(root) !== 'object')
      throw new JqError('Cannot index ' + typeOf(root) + ' with string "' + key + '"')
    const object = { ...((root ?? {}) as Record<string, Json>) }
    object[key] = setPath(object[key] ?? null, path, value, at + 1)
    return object
  }
  if (typeof key === 'number') {
    if (root !== null && !Array.isArray(root))
      throw new JqError('Cannot index ' + typeOf(root) + ' with number')
    const array = [...((root ?? []) as Json[])]
    const i = key < 0 ? array.length + key : key
    if (i < 0) throw new JqError('Out of bounds negative array index')
    while (array.length < i) array.push(null)
    array[i] = setPath(array[i] ?? null, path, value, at + 1)
    return array
  }
  if (root !== null && !Array.isArray(root))
    throw new JqError('Cannot update field at object index of ' + typeOf(root))
  const array = [...((root ?? []) as Json[])]
  const from =
    key.start === null
      ? 0
      : key.start < 0
        ? Math.max(0, array.length + key.start)
        : Math.min(array.length, key.start)
  const to =
    key.end === null
      ? array.length
      : key.end < 0
        ? Math.max(from, array.length + key.end)
        : Math.max(from, Math.min(array.length, key.end))
  const replacement = setPath(array.slice(from, to), path, value, at + 1)
  if (!Array.isArray(replacement))
    throw new JqError('A slice of an array can only be assigned another array')
  array.splice(from, to - from, ...replacement)
  return array
}

function deletePaths(root: Json, paths: Path[]): Json {
  const sorted = [...paths].sort((a, b) => compare(b as Json, a as Json))
  let result = root
  for (const path of sorted) result = deletePath(result, path)
  return result
}

function deletePath(root: Json, path: Path): Json {
  if (!path.length) return null
  if (root === null) return null
  const [key, ...rest] = path
  if (rest.length) {
    const child = index(root, key)
    if (child === null) return root
    return setPath(root, [key], deletePath(child, rest))
  }
  if (typeof key === 'string') {
    if (typeOf(root) !== 'object')
      throw new JqError('Cannot delete field at object index of ' + typeOf(root))
    const object = { ...(root as Record<string, Json>) }
    delete object[key]
    return object
  }
  if (!Array.isArray(root)) throw new JqError('Cannot delete field at index of ' + typeOf(root))
  const array = [...root]
  if (typeof key === 'number') {
    const i = key < 0 ? array.length + key : key
    if (i >= 0 && i < array.length) array.splice(i, 1)
    return array
  }
  const from =
    key.start === null ? 0 : key.start < 0 ? Math.max(0, array.length + key.start) : key.start
  const to = key.end === null ? array.length : key.end < 0 ? array.length + key.end : key.end
  array.splice(from, Math.max(0, to - from))
  return array
}

function keysOf(value: Json): PathKey[] {
  if (Array.isArray(value)) return value.map((_, i) => i)
  if (typeOf(value) === 'object') return Object.keys(value as object)
  throw new JqError('Cannot iterate over ' + describe(value))
}

function* allPaths(value: Json, path: Path): Generator<[Path, Json]> {
  yield [path, value]
  if (Array.isArray(value) || typeOf(value) === 'object')
    for (const key of keysOf(value)) yield* allPaths(index(value, key), [...path, key])
}

function toJson(value: Json, indent: string | number = 0, sortKeys = false): string {
  const sorter = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(sorter)
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((key) => [key, sorter((v as Record<string, Json>)[key])]),
      )
    return v
  }
  const prepared = sortKeys ? sorter(value) : value
  return (
    JSON.stringify(
      prepared,
      (_, v) =>
        typeof v === 'number' && !Number.isFinite(v)
          ? Number.isNaN(v)
            ? null
            : v > 0
              ? 1.7976931348623157e308
              : -1.7976931348623157e308
          : v,
      indent,
    ) ?? 'null'
  )
}

function tostring(value: Json): string {
  return typeof value === 'string' ? value : toJson(value)
}

function applyFormat(name: string, value: Json): string {
  switch (name) {
    case 'text':
      return tostring(value)
    case 'json':
      return toJson(value)
    case 'html':
      return tostring(value).replace(
        /[<>&'"]/g,
        (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' })[c]!,
      )
    case 'uri':
      return [...new TextEncoder().encode(tostring(value))]
        .map((byte) =>
          /[A-Za-z0-9\-_.~]/.test(String.fromCharCode(byte))
            ? String.fromCharCode(byte)
            : '%' + byte.toString(16).toUpperCase().padStart(2, '0'),
        )
        .join('')
    case 'csv':
    case 'tsv': {
      if (!Array.isArray(value))
        throw new JqError(
          describe(value) + ' cannot be ' + name + '-formatted, only an array can be',
        )
      return value
        .map((item) => {
          if (typeof item === 'number') return String(item)
          if (typeof item === 'boolean') return String(item)
          if (item === null) return ''
          if (typeof item !== 'string')
            throw new JqError(describe(item) + ' is not valid in a csv row')
          return name === 'csv'
            ? '"' + item.replace(/"/g, '""') + '"'
            : item
                .replace(/\\/g, '\\\\')
                .replace(/\t/g, '\\t')
                .replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r')
        })
        .join(name === 'csv' ? ',' : '\t')
    }
    case 'sh': {
      const quote = (item: Json) => {
        if (typeof item === 'string') return "'" + item.replace(/'/g, "'\\''") + "'"
        if (Array.isArray(item) || typeOf(item) === 'object')
          throw new JqError(describe(item) + ' can not be escaped for shell')
        return tostring(item)
      }
      return Array.isArray(value) ? value.map(quote).join(' ') : quote(value)
    }
    case 'base64': {
      const bytes = new TextEncoder().encode(tostring(value))
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary)
    }
    case 'base64d': {
      const text = tostring(value).replace(/=+$/, '')
      const binary = atob(text.padEnd(Math.ceil(text.length / 4) * 4, '='))
      return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
    }
  }
  throw new JqError(name + ' is not a valid format')
}

function regexFlags(flags: Json): { flags: string; global: boolean } {
  const text = typeof flags === 'string' ? flags : ''
  let out = 'u'
  let global = false
  for (const c of text) {
    if (c === 'g') global = true
    else if (c === 'i') out += 'i'
    else if (c === 'x') continue
    else if (c === 's') out += 's'
    else if (c === 'n') continue
    else if (c === 'l' || c === 'p') continue
    else throw new JqError(text + ' is not a valid modifier string')
  }
  return { flags: out, global }
}

function matches(input: Json, re: Json, flags: Json, forceGlobal = false): Json[] {
  if (typeof input !== 'string')
    throw new JqError(describe(input) + ' cannot be matched, as it is not a string')
  if (typeof re !== 'string')
    throw new JqError(describe(re) + ' cannot be matched, as it is not a string')
  const parsed = regexFlags(flags)
  let regex: RegExp
  try {
    regex = new RegExp(re.replace(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g, '(?<$1>'), parsed.flags + 'g')
  } catch (error) {
    throw new JqError(re + ' (at offset 0) is not a valid regex: ' + (error as Error).message)
  }
  const names = [...re.matchAll(/\((?:\?<([A-Za-z_][A-Za-z0-9_]*)>|(?!\?))/g)].map(
    (match) => match[1] ?? null,
  )
  const out: Json[] = []
  for (const match of input.matchAll(regex)) {
    const offset = [...input.slice(0, match.index)].length
    let cursor = match.index!
    out.push({
      offset,
      length: [...match[0]].length,
      string: match[0],
      captures: match.slice(1).map((group, i) => {
        const at = group === undefined ? -1 : input.indexOf(group, cursor)
        if (at >= 0) cursor = at
        return {
          offset: at < 0 ? -1 : [...input.slice(0, at)].length,
          length: group === undefined ? 0 : [...group].length,
          string: group ?? null,
          name: names[i] ?? null,
        }
      }),
    })
    if (!parsed.global && !forceGlobal) break
    if (match[0] === '') regex.lastIndex++
  }
  return out
}

function flatten(value: Json[], depth: number): Json[] {
  if (depth < 0) throw new JqError('flatten depth must not be negative')
  return value.flatMap((item) =>
    Array.isArray(item) && depth > 0 ? flatten(item, depth - 1) : [item],
  )
}

function dateParts(seconds: number): Json[] {
  const date = new Date(seconds * 1000)
  const start = Date.UTC(date.getUTCFullYear(), 0, 1)
  return [
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds() + (seconds % 1),
    date.getUTCDay(),
    Math.floor((date.getTime() - start) / 86400000),
  ]
}

function fromParts(parts: Json): number {
  if (!Array.isArray(parts) || parts.length < 6 || parts.some((part) => typeof part !== 'number'))
    throw new JqError('mktime requires array of 6 numbers')
  const [y, mo, d, h, mi, s] = parts as number[]
  return Math.floor(Date.UTC(y, mo, d, h, mi, Math.floor(s)) / 1000)
}

export type JqOptions = {
  env: Record<string, string>
  vars: Record<string, Json>
  inputs: () => Json | undefined
  filename: () => Json
  stderr: (text: string) => void
  tick: () => void
  limit: number
}

class Interpreter {
  options: JqOptions
  depth = 0

  constructor(options: JqOptions) {
    this.options = options
  }

  *eval(node: Node, input: Json, env: Env): Generator<Json> {
    this.options.tick()
    switch (node.k) {
      case 'identity':
        yield input
        return
      case 'recurse':
        for (const [, value] of allPaths(input, [])) yield value
        return
      case 'literal':
        yield node.v
        return
      case 'string':
        yield* this.interpolate(node, 0, '', input, env)
        return
      case 'format':
        yield applyFormat(node.name, input)
        return
      case 'index':
        for (const key of this.eval(node.key, input, env)) {
          for (const target of this.eval(node.target, input, env)) {
            if (key !== null && typeof key === 'object' && !Array.isArray(key)) {
              const slice = key as Record<string, Json>
              yield index(target, {
                start: slice.start as number | null,
                end: slice.end as number | null,
              })
            } else if (Array.isArray(key)) {
              if (!Array.isArray(target))
                throw new JqError('Cannot index ' + typeOf(target) + ' with array')
              const out: number[] = []
              for (let i = 0; i + key.length <= target.length && key.length; i++)
                if (key.every((item, j) => compare(item, target[i + j]) === 0)) out.push(i)
              yield out
            } else {
              if (typeof key !== 'string' && typeof key !== 'number' && key !== null)
                throw new JqError('Cannot index ' + typeOf(target) + ' with ' + typeOf(key))
              if (key === null) {
                if (target === null) yield null
                else throw new JqError('Cannot index ' + typeOf(target) + ' with null')
                continue
              }
              yield index(target, key)
            }
          }
        }
        return
      case 'slice':
        for (const to of node.to ? this.eval(node.to, input, env) : [null]) {
          for (const from of node.from ? this.eval(node.from, input, env) : [null]) {
            for (const target of this.eval(node.target, input, env))
              yield index(target, { start: from as number | null, end: to as number | null })
          }
        }
        return
      case 'iterate':
        for (const target of this.eval(node.target, input, env)) {
          if (Array.isArray(target)) yield* target
          else if (target !== null && typeof target === 'object') yield* Object.values(target)
          else throw new JqError('Cannot iterate over ' + describe(target))
        }
        return
      case 'pipe':
        for (const value of this.eval(node.left, input, env))
          yield* this.eval(node.right, value, env)
        return
      case 'comma':
        yield* this.eval(node.left, input, env)
        yield* this.eval(node.right, input, env)
        return
      case 'alt': {
        let any = false
        for (const value of this.eval(node.left, input, env)) {
          if (truthy(value)) {
            any = true
            yield value
          }
        }
        if (!any) yield* this.eval(node.right, input, env)
        return
      }
      case 'binop':
        for (const right of this.eval(node.right, input, env))
          for (const left of this.eval(node.left, input, env)) yield binop(node.op, left, right)
        return
      case 'and':
      case 'or':
        for (const left of this.eval(node.left, input, env)) {
          if (node.k === 'and' && !truthy(left)) {
            yield false
            continue
          }
          if (node.k === 'or' && truthy(left)) {
            yield true
            continue
          }
          for (const right of this.eval(node.right, input, env)) yield truthy(right)
        }
        return
      case 'neg':
        for (const value of this.eval(node.e, input, env)) {
          if (typeof value !== 'number') throw new JqError(describe(value) + ' cannot be negated')
          yield -value
        }
        return
      case 'array':
        yield node.e ? [...this.eval(node.e, input, env)] : []
        return
      case 'object':
        yield* this.object(node.entries, 0, {}, input, env)
        return
      case 'if':
        yield* this.conditional(node, input, env, 0)
        return
      case 'try':
        try {
          for (const value of this.eval(node.body, input, env)) yield value
        } catch (error) {
          if (error instanceof BreakSignal) throw error
          if (!(error instanceof JqError)) throw error
          if (node.handler) yield* this.eval(node.handler, error.value, env)
        }
        return
      case 'reduce': {
        for (let acc of this.eval(node.init, input, env)) {
          for (const item of this.eval(node.source, input, env)) {
            for (const scope of this.bind(node.pattern, item, env)) {
              let last: Json = null
              let produced = false
              for (const value of this.eval(node.update, acc, scope)) {
                last = value
                produced = true
              }
              acc = produced ? last : null
            }
          }
          yield acc
        }
        return
      }
      case 'foreach': {
        for (let acc of this.eval(node.init, input, env)) {
          for (const item of this.eval(node.source, input, env)) {
            for (const scope of this.bind(node.pattern, item, env)) {
              for (const value of this.eval(node.update, acc, scope)) {
                acc = value
                if (node.extract) yield* this.eval(node.extract, value, scope)
                else yield value
              }
            }
          }
        }
        return
      }
      case 'def': {
        const scope = new Env(env)
        scope.funcs.set(node.name + '/' + node.params.length, {
          params: node.params,
          body: node.body,
          env: scope,
        })
        yield* this.eval(node.rest, input, scope)
        return
      }
      case 'var':
        if (node.name === 'ENV') yield this.options.env as Json
        else if (node.name === '__prog_args') yield []
        else if (node.name === 'ARGS') yield env.variable('__prog_args')
        else if (node.name === '__loc__') yield { file: '<top-level>', line: 1 }
        else yield env.variable(node.name)
        return
      case 'as':
        for (const value of this.eval(node.source, input, env)) {
          let done = false
          for (let i = 0; i < node.patterns.length && !done; i++) {
            try {
              const names = node.patterns.flatMap((pattern) => patternNames(pattern))
              const bound = new Set(patternNames(node.patterns[i]))
              for (const scope of this.bind(node.patterns[i], value, env)) {
                for (const name of names) if (!bound.has(name)) scope.vars.set(name, null)
                yield* this.eval(node.body, input, scope)
              }
              done = true
            } catch (error) {
              if (!(error instanceof JqError) || i === node.patterns.length - 1) throw error
            }
          }
        }
        return
      case 'assign':
        yield* this.assign(node, input, env)
        return
      case 'label':
        try {
          yield* this.eval(node.body, input, env)
        } catch (error) {
          if (!(error instanceof BreakSignal) || error.label !== node.name) throw error
        }
        return
      case 'break':
        throw new BreakSignal(node.name)
      case 'call':
        yield* this.call(node, input, env)
        return
    }
  }

  *interpolate(
    node: Node & { k: 'string' },
    at: number,
    prefix: string,
    input: Json,
    env: Env,
  ): Generator<Json> {
    if (at >= node.parts.length) {
      yield prefix
      return
    }
    const part = node.parts[at]
    if (typeof part === 'string') {
      yield* this.interpolate(node, at + 1, prefix + part, input, env)
      return
    }
    for (const value of this.eval(part, input, env))
      yield* this.interpolate(
        node,
        at + 1,
        prefix + (node.format ? applyFormat(node.format, value) : tostring(value)),
        input,
        env,
      )
  }

  *object(
    entries: { key: Node; value?: Node }[],
    at: number,
    acc: Record<string, Json>,
    input: Json,
    env: Env,
  ): Generator<Json> {
    if (at >= entries.length) {
      yield { ...acc }
      return
    }
    const entry = entries[at]
    for (const key of this.eval(entry.key, input, env)) {
      if (typeof key !== 'string')
        throw new JqError('Cannot use ' + describe(key) + ' as object key')
      for (const value of this.eval(entry.value!, input, env))
        yield* this.object(entries, at + 1, { ...acc, [key]: value }, input, env)
    }
  }

  *conditional(node: Node & { k: 'if' }, input: Json, env: Env, at: number): Generator<Json> {
    const branches = [{ cond: node.cond, then: node.then }, ...node.elifs]
    if (at >= branches.length) {
      if (node.else) yield* this.eval(node.else, input, env)
      else yield input
      return
    }
    for (const cond of this.eval(branches[at].cond, input, env)) {
      if (truthy(cond)) yield* this.eval(branches[at].then, input, env)
      else yield* this.conditional(node, input, env, at + 1)
    }
  }

  *bind(pattern: Pattern, value: Json, env: Env): Generator<Env> {
    if (pattern.k === 'var') {
      const scope = new Env(env)
      scope.vars.set(pattern.name, value)
      yield scope
      return
    }
    if (pattern.k === 'array') {
      if (value !== null && !Array.isArray(value))
        throw new JqError('Cannot index ' + typeOf(value) + ' with number')
      let scopes: Env[] = [env]
      pattern.items.forEach((item, i) => {
        scopes = scopes.flatMap((scope) => [
          ...this.bind(item, value === null ? null : (value[i] ?? null), scope),
        ])
      })
      yield* scopes
      return
    }
    let scopes: Env[] = [env]
    for (const entry of pattern.entries) {
      const next: Env[] = []
      for (const scope of scopes) {
        for (const key of this.eval(entry.key, value, scope)) {
          if (typeof key !== 'string')
            throw new JqError('Cannot index ' + typeOf(value) + ' with ' + typeOf(key))
          const field = index(value, key)
          let current = scope
          if (entry.name) {
            current = new Env(scope)
            current.vars.set(entry.name, field)
          }
          if (entry.pattern) next.push(...this.bind(entry.pattern, field, current))
          else next.push(current)
        }
      }
      scopes = next
    }
    yield* scopes
  }

  *paths(node: Node, input: Json, env: Env): Generator<[Path, Json]> {
    this.options.tick()
    switch (node.k) {
      case 'identity':
        yield [[], input]
        return
      case 'recurse':
        yield* allPaths(input, [])
        return
      case 'index':
        for (const key of this.eval(node.key, input, env)) {
          for (const [path, value] of this.paths(node.target, input, env)) {
            if (key !== null && typeof key === 'object' && !Array.isArray(key)) {
              const slice = {
                start: (key as Record<string, Json>).start as number | null,
                end: (key as Record<string, Json>).end as number | null,
              }
              yield [[...path, slice], value === null ? null : index(value, slice)]
            } else {
              if (typeof key !== 'string' && typeof key !== 'number')
                throw new JqError('Cannot index ' + typeOf(value) + ' with ' + typeOf(key))
              yield [[...path, key], index(value, key)]
            }
          }
        }
        return
      case 'slice':
        for (const to of node.to ? this.eval(node.to, input, env) : [null]) {
          for (const from of node.from ? this.eval(node.from, input, env) : [null]) {
            for (const [path, value] of this.paths(node.target, input, env)) {
              const slice = { start: from as number | null, end: to as number | null }
              yield [[...path, slice], value === null ? null : index(value, slice)]
            }
          }
        }
        return
      case 'iterate':
        for (const [path, value] of this.paths(node.target, input, env)) {
          if (value === null) continue
          for (const key of keysOf(value)) yield [[...path, key], index(value, key)]
        }
        return
      case 'pipe':
        for (const [left, value] of this.paths(node.left, input, env))
          for (const [right, inner] of this.paths(node.right, value, env))
            yield [[...left, ...right], inner]
        return
      case 'comma':
        yield* this.paths(node.left, input, env)
        yield* this.paths(node.right, input, env)
        return
      case 'if': {
        const branches = [{ cond: node.cond, then: node.then }, ...node.elifs]
        const visit = function* (this: Interpreter, at: number): Generator<[Path, Json]> {
          if (at >= branches.length) {
            if (node.else) yield* this.paths(node.else, input, env)
            else yield [[], input]
            return
          }
          for (const cond of this.eval(branches[at].cond, input, env)) {
            if (truthy(cond)) yield* this.paths(branches[at].then, input, env)
            else yield* visit.call(this, at + 1)
          }
        }
        yield* visit.call(this, 0)
        return
      }
      case 'alt': {
        let any = false
        for (const item of this.paths(node.left, input, env)) {
          if (truthy(item[1])) {
            any = true
            yield item
          }
        }
        if (!any) yield* this.paths(node.right, input, env)
        return
      }
      case 'try':
        try {
          for (const item of this.paths(node.body, input, env)) yield item
        } catch (error) {
          if (!(error instanceof JqError)) throw error
        }
        return
      case 'def': {
        const scope = new Env(env)
        scope.funcs.set(node.name + '/' + node.params.length, {
          params: node.params,
          body: node.body,
          env: scope,
        })
        yield* this.paths(node.rest, input, scope)
        return
      }
      case 'as':
        for (const value of this.eval(node.source, input, env))
          for (const scope of this.bind(node.patterns[0], value, env))
            yield* this.paths(node.body, input, scope)
        return
      case 'reduce': {
        for (const init of this.paths(node.init, input, env)) {
          let acc = init
          for (const item of this.eval(node.source, input, env)) {
            for (const scope of this.bind(node.pattern, item, env)) {
              for (const [path, value] of this.paths(node.update, acc[1], scope))
                acc = [[...acc[0], ...path], value]
            }
          }
          yield acc
        }
        return
      }
      case 'call': {
        const { name, args } = node
        const user = env.func(name, args.length)
        if (user) {
          yield* this.invoke(user, args, input, env, true) as Generator<[Path, Json]>
          return
        }
        if (name === 'empty') return
        if (name === 'error') {
          yield* this.eval(node, input, env) as Generator<never>
          return
        }
        if (name === 'select' && args.length === 1) {
          for (const cond of this.eval(args[0], input, env)) if (truthy(cond)) yield [[], input]
          return
        }
        if (name === 'recurse' && args.length === 0) {
          yield* allPaths(input, [])
          return
        }
        if (name === 'recurse' && args.length >= 1) {
          const visit = function* (
            this: Interpreter,
            path: Path,
            value: Json,
          ): Generator<[Path, Json]> {
            yield [path, value]
            for (const [inner, child] of this.paths(args[0], value, env))
              yield* visit.call(this, [...path, ...inner], child)
          }
          yield* visit.call(this, [], input)
          return
        }
        if ((name === 'first' || name === 'last') && args.length === 1) {
          let found: [Path, Json] | undefined
          for (const item of this.paths(args[0], input, env)) {
            found = item
            if (name === 'first') break
          }
          if (found) yield found
          return
        }
        if (name === 'first' && !args.length) {
          yield [[0], index(input, 0)]
          return
        }
        if (name === 'last' && !args.length) {
          yield [[-1], index(input, -1)]
          return
        }
        if (name === 'limit' && args.length === 2) {
          for (const n of this.eval(args[0], input, env)) {
            let count = 0
            if ((n as number) <= 0) continue
            for (const item of this.paths(args[1], input, env)) {
              yield item
              if (++count >= (n as number)) break
            }
          }
          return
        }
        if (name === 'getpath' && args.length === 1) {
          for (const path of this.eval(args[0], input, env)) {
            if (!Array.isArray(path)) throw new JqError('Path must be specified as an array')
            let value: Json = input
            for (const key of path) value = value === null ? null : index(value, key as PathKey)
            yield [path as Path, value]
          }
          return
        }
        if ((name === 'paths' || name === 'leaf_paths') && args.length <= 1) {
          for (const [path, value] of allPaths(input, [])) if (path.length) yield [path, value]
          return
        }
        if (
          name === 'to_entries' ||
          name === 'objects' ||
          name === 'arrays' ||
          name === 'strings' ||
          name === 'numbers' ||
          name === 'booleans' ||
          name === 'nulls' ||
          name === 'iterables' ||
          name === 'scalars' ||
          name === 'values'
        ) {
          for (const value of this.eval(node, input, env)) if (value === input) yield [[], input]
          return
        }
        throw new JqError(
          'Invalid path expression with result ' +
            JSON.stringify([...this.eval(node, input, env)][0] ?? null),
        )
      }
      case 'literal':
        if (node.v === null) {
          yield [[], null]
          return
        }
    }
    const values = [...this.eval(node, input, env)]
    throw new JqError(
      'Invalid path expression with result ' + toJson(values[0] ?? null).slice(0, 40),
    )
  }

  *assign(node: Node & { k: 'assign' }, input: Json, env: Env): Generator<Json> {
    if (node.op === '|=') {
      let result = input
      for (const [path] of [...this.paths(node.left, input, env)]) {
        let current: Json = result
        for (const key of path) current = current === null ? null : index(current, key)
        const first = this.eval(node.right, current, env).next()
        result = first.done ? deletePaths(result, [path]) : setPath(result, path, first.value)
      }
      yield result
      return
    }
    for (const value of this.eval(node.right, input, env)) {
      let result = input
      for (const [path] of [...this.paths(node.left, input, env)]) {
        if (node.op === '=') result = setPath(result, path, value)
        else {
          let current: Json = result
          for (const key of path) current = current === null ? null : index(current, key)
          const op = node.op.slice(0, -1)
          result = setPath(
            result,
            path,
            op === '//' ? (truthy(current) ? current : value) : binop(op, current, value),
          )
        }
      }
      yield result
    }
  }

  *invoke(
    fn: Closure,
    args: Node[],
    input: Json,
    env: Env,
    pathMode: boolean,
  ): Generator<Json | [Path, Json]> {
    if (++this.depth > 512) {
      this.depth--
      throw new JqError('maximum recursion depth exceeded')
    }
    try {
      const values = fn.params.map((param, i) =>
        param.startsWith('$') ? [...this.eval(args[i], input, env)] : undefined,
      )
      const combos = (at: number, scope: Env): Env[] => {
        if (at >= fn.params.length) return [scope]
        const param = fn.params[at]
        if (!param.startsWith('$')) {
          const next = new Env(scope)
          next.funcs.set(param + '/0', { params: [], body: args[at], env })
          return combos(at + 1, next)
        }
        return values[at]!.flatMap((value) => {
          const next = new Env(scope)
          next.vars.set(param.slice(1), value)
          next.funcs.set(param.slice(1) + '/0', {
            params: [],
            body: { k: 'literal', v: value },
            env,
          })
          return combos(at + 1, next)
        })
      }
      for (const scope of combos(0, new Env(fn.env))) {
        if (pathMode) yield* this.paths(fn.body, input, scope)
        else yield* this.eval(fn.body, input, scope)
      }
    } finally {
      this.depth--
    }
  }

  *call(node: Node & { k: 'call' }, input: Json, env: Env): Generator<Json> {
    const { name, args } = node
    const user = env.func(name, args.length)
    if (user) {
      yield* this.invoke(user, args, input, env, false) as Generator<Json>
      return
    }
    const one = (i: number) => this.eval(args[i], input, env)
    const all = (i: number) => [...this.eval(args[i], input, env)]
    const need = (type: string) => {
      if (typeOf(input) !== type)
        throw new JqError(
          describe(input) +
            ' ' +
            (type === 'string' ? 'cannot be processed, as it is not a string' : 'has no keys'),
        )
    }
    const key = name + '/' + args.length
    switch (key) {
      case 'empty/0':
        return
      case 'not/0':
        yield !truthy(input)
        return
      case 'length/0':
        if (input === null) yield 0
        else if (typeof input === 'boolean')
          throw new JqError('boolean (' + input + ') has no length')
        else if (typeof input === 'number') yield Math.abs(input)
        else if (typeof input === 'string') yield [...input].length
        else yield Array.isArray(input) ? input.length : Object.keys(input).length
        return
      case 'utf8bytelength/0':
        need('string')
        yield new TextEncoder().encode(input as string).length
        return
      case 'keys/0':
      case 'keys_unsorted/0':
        if (Array.isArray(input)) yield input.map((_, i) => i)
        else if (typeOf(input) === 'object')
          yield name === 'keys' ? Object.keys(input as object).sort() : Object.keys(input as object)
        else throw new JqError(describe(input) + ' has no keys')
        return
      case 'values/0':
        if (input !== null) yield input
        return
      case 'has/1':
        for (const k of one(0)) {
          if (Array.isArray(input) && typeof k === 'number') yield k >= 0 && k < input.length
          else if (typeOf(input) === 'object' && typeof k === 'string')
            yield Object.prototype.hasOwnProperty.call(input, k)
          else
            throw new JqError(
              'Cannot check whether ' + typeOf(input) + ' has a ' + typeOf(k) + ' key',
            )
        }
        return
      case 'in/1':
        for (const object of one(0))
          yield* this.call(
            { k: 'call', name: 'has', args: [{ k: 'literal', v: input }] },
            object,
            env,
          )
        return
      case 'map/1':
        if (input === null || typeof input !== 'object')
          throw new JqError('Cannot iterate over ' + describe(input))
        yield (Array.isArray(input) ? input : Object.values(input)).flatMap((item) => [
          ...this.eval(args[0], item, env),
        ])
        return
      case 'map_values/1':
        yield* this.assign(
          {
            k: 'assign',
            op: '|=',
            left: { k: 'iterate', target: { k: 'identity' } },
            right: args[0],
          },
          input,
          env,
        )
        return
      case 'path/1':
        for (const [path] of this.paths(args[0], input, env)) yield path as Json
        return
      case 'paths/0':
        for (const [path] of allPaths(input, [])) if (path.length) yield path as Json
        return
      case 'paths/1':
        for (const [path, value] of allPaths(input, []))
          if (path.length && [...this.eval(args[0], value, env)].some(truthy)) yield path as Json
        return
      case 'del/1':
        yield deletePaths(
          input,
          [...this.paths(args[0], input, env)].map(([path]) => path),
        )
        return
      case 'delpaths/1':
        for (const paths of one(0)) yield deletePaths(input, paths as Path[])
        return
      case 'getpath/1':
        for (const path of one(0)) {
          if (!Array.isArray(path)) throw new JqError('Path must be specified as an array')
          let value: Json = input
          for (const k of path) value = value === null ? null : index(value, k as PathKey)
          yield value
        }
        return
      case 'setpath/2':
        for (const value of one(1))
          for (const path of one(0)) yield setPath(input, path as Path, value)
        return
      case 'to_entries/0':
        if (Array.isArray(input)) yield input.map((value, key) => ({ key, value }))
        else if (typeOf(input) !== 'object') throw new JqError(describe(input) + ' has no keys')
        else yield Object.entries(input as object).map(([k, v]) => ({ key: k, value: v as Json }))
        return
      case 'from_entries/0': {
        if (!Array.isArray(input)) throw new JqError('Cannot iterate over ' + describe(input))
        const out: Record<string, Json> = {}
        for (const entry of input) {
          if (typeOf(entry) !== 'object')
            throw new JqError('Cannot index ' + typeOf(entry) + ' with string "key"')
          const record = entry as Record<string, Json>
          const k = record.key ?? record.k ?? record.name ?? record.Name ?? record.Key ?? record.K
          const v =
            'value' in record ? record.value : 'v' in record ? record.v : (record.Value ?? null)
          if (typeof k !== 'string')
            throw new JqError('Cannot use ' + describe(k ?? null) + ' as object key')
          out[k] = v
        }
        yield out
        return
      }
      case 'with_entries/1': {
        const entries = [
          ...this.call({ k: 'call', name: 'to_entries', args: [] }, input, env),
        ][0] as Json[]
        const mapped = entries.flatMap((entry) => [...this.eval(args[0], entry, env)])
        yield* this.call({ k: 'call', name: 'from_entries', args: [] }, mapped, env)
        return
      }
      case 'select/1':
        for (const cond of one(0)) if (truthy(cond)) yield input
        return
      case 'error/0':
        throw new JqError(input)
      case 'error/1':
        for (const message of one(0)) throw new JqError(message)
        return
      case 'add/0':
        if (input === null) {
          yield null
          return
        }
        if (typeof input !== 'object') throw new JqError('Cannot iterate over ' + describe(input))
        yield (Array.isArray(input) ? input : Object.values(input)).reduce<Json>(
          (acc, item) => add(acc, item),
          null,
        )
        return
      case 'any/0':
        yield (input as Json[]).some(truthy)
        return
      case 'all/0':
        yield (input as Json[]).every(truthy)
        return
      case 'any/1':
        yield (input as Json[]).some((item) => [...this.eval(args[0], item, env)].some(truthy))
        return
      case 'all/1':
        yield (input as Json[]).every((item) => [...this.eval(args[0], item, env)].every(truthy))
        return
      case 'any/2':
        yield [...this.eval(args[0], input, env)].some((item) =>
          [...this.eval(args[1], item, env)].some(truthy),
        )
        return
      case 'all/2':
        yield [...this.eval(args[0], input, env)].every((item) =>
          [...this.eval(args[1], item, env)].every(truthy),
        )
        return
      case 'range/1':
        for (const n of one(0))
          for (let i = 0; i < (n as number); i++) {
            this.options.tick()
            yield i
          }
        return
      case 'range/2':
      case 'range/3':
        for (const from of one(0))
          for (const to of one(1)) {
            const step = args.length === 3 ? (all(2)[0] as number) : 1
            if (step === 0) continue
            for (
              let i = from as number;
              step > 0 ? i < (to as number) : i > (to as number);
              i += step
            ) {
              this.options.tick()
              yield i
            }
          }
        return
      case 'floor/0':
        yield Math.floor(input as number)
        return
      case 'ceil/0':
        yield Math.ceil(input as number)
        return
      case 'round/0':
        yield Math.round(input as number)
        return
      case 'fabs/0':
      case 'abs/0':
        if (typeof input === 'number') yield Math.abs(input)
        else if (compare(input, 0) < 0) throw new JqError(describe(input) + ' cannot be negated')
        else yield input
        return
      case 'sqrt/0':
        yield Math.sqrt(input as number)
        return
      case 'log/0':
        yield Math.log(input as number)
        return
      case 'log2/0':
        yield Math.log2(input as number)
        return
      case 'log10/0':
        yield Math.log10(input as number)
        return
      case 'exp/0':
        yield Math.exp(input as number)
        return
      case 'exp10/0':
        yield 10 ** (input as number)
        return
      case 'pow/2':
        for (const b of one(1)) for (const a of one(0)) yield (a as number) ** (b as number)
        return
      case 'infinite/0':
        yield Infinity
        return
      case 'nan/0':
        yield NaN
        return
      case 'isinfinite/0':
        yield typeof input === 'number' && !Number.isFinite(input) && !Number.isNaN(input)
        return
      case 'isnan/0':
        yield typeof input === 'number' && Number.isNaN(input)
        return
      case 'isnormal/0':
        yield typeof input === 'number' && Number.isFinite(input) && input !== 0
        return
      case 'tostring/0':
        yield tostring(input)
        return
      case 'tonumber/0': {
        if (typeof input === 'number') {
          yield input
          return
        }
        const value = typeof input === 'string' ? parseOne(input) : null
        if (typeof value !== 'number')
          throw new JqError(describe(input) + ' cannot be parsed as a number')
        yield value
        return
      }
      case 'type/0':
        yield typeOf(input)
        return
      case 'sort/0':
        if (!Array.isArray(input))
          throw new JqError(describe(input) + ' cannot be sorted, as it is not an array')
        yield [...input].sort(compare)
        return
      case 'sort_by/1':
      case 'group_by/1':
      case 'unique_by/1':
      case 'min_by/1':
      case 'max_by/1': {
        if (!Array.isArray(input))
          throw new JqError('Cannot index ' + typeOf(input) + ' with number')
        const keyed = input.map((item, i) => ({
          item,
          key: [...this.eval(args[0], item, env)] as Json,
          i,
        }))
        keyed.sort((a, b) => compare(a.key, b.key) || a.i - b.i)
        if (name === 'sort_by') yield keyed.map((entry) => entry.item)
        else if (name === 'min_by') yield keyed[0]?.item ?? null
        else if (name === 'max_by')
          yield keyed.length
            ? keyed.reduce((best, entry) => (compare(entry.key, best.key) >= 0 ? entry : best)).item
            : null
        else {
          const groups: Json[][] = []
          let last: Json | undefined
          for (const entry of keyed) {
            if (last !== undefined && compare(last, entry.key) === 0)
              groups[groups.length - 1].push(entry.item)
            else groups.push([entry.item])
            last = entry.key
          }
          yield name === 'group_by' ? groups : groups.map((group) => group[0])
        }
        return
      }
      case 'unique/0':
        yield [...(input as Json[])]
          .sort(compare)
          .filter((item, i, list) => i === 0 || compare(list[i - 1], item) !== 0)
        return
      case 'min/0':
        yield (input as Json[]).length ? [...(input as Json[])].sort(compare)[0] : null
        return
      case 'max/0':
        yield (input as Json[]).length
          ? [...(input as Json[])].sort(compare)[(input as Json[]).length - 1]
          : null
        return
      case 'reverse/0':
        if (Array.isArray(input)) yield [...input].reverse()
        else if (input === null || input === '' || input === 0) yield []
        else if (typeof input === 'object' && !Object.keys(input).length) yield []
        else if (typeof input === 'boolean')
          throw new JqError('boolean (' + input + ') has no length')
        else throw new JqError('Cannot index ' + typeOf(input) + ' with number')
        return
      case 'contains/1':
        for (const b of one(0)) yield contains(input, b)
        return
      case 'inside/1':
        for (const b of one(0)) yield contains(b, input)
        return
      case 'startswith/1':
        for (const b of one(0)) {
          if (typeof input !== 'string' || typeof b !== 'string')
            throw new JqError('startswith() requires string inputs')
          yield input.startsWith(b)
        }
        return
      case 'endswith/1':
        for (const b of one(0)) {
          if (typeof input !== 'string' || typeof b !== 'string')
            throw new JqError('endswith() requires string inputs')
          yield input.endsWith(b)
        }
        return
      case 'ltrimstr/1':
        for (const b of one(0))
          yield typeof input === 'string' && typeof b === 'string' && input.startsWith(b)
            ? input.slice(b.length)
            : input
        return
      case 'rtrimstr/1':
        for (const b of one(0))
          yield typeof input === 'string' && typeof b === 'string' && input.endsWith(b) && b.length
            ? input.slice(0, -b.length)
            : input
        return
      case 'explode/0':
        need('string')
        yield [...(input as string)].map((c) => c.codePointAt(0)!)
        return
      case 'implode/0':
        yield String.fromCodePoint(...(input as number[]))
        return
      case 'split/1':
        for (const b of one(0)) {
          if (typeof input !== 'string' || typeof b !== 'string')
            throw new JqError('split input and separator must be strings')
          yield split(input, b)
        }
        return
      case 'split/2':
        for (const flags of one(1))
          for (const re of one(0)) {
            const found = matches(input, re, flags, true) as Record<string, Json>[]
            const out: Json[] = []
            let at = 0
            const chars = [...(input as string)]
            for (const match of found) {
              out.push(chars.slice(at, match.offset as number).join(''))
              at = (match.offset as number) + (match.length as number)
            }
            out.push(chars.slice(at).join(''))
            yield out
          }
        return
      case 'join/1':
        for (const separator of one(0)) {
          if (!Array.isArray(input)) throw new JqError('Cannot iterate over ' + describe(input))
          yield input
            .map((item) => {
              if (item === null) return ''
              if (typeof item === 'object') throw new JqError('Cannot join with ' + typeOf(item))
              return String(item)
            })
            .join(separator as string)
        }
        return
      case 'ascii_downcase/0':
        if (typeof input !== 'string') throw new JqError('explode input must be a string')
        yield input.replace(/[A-Z]/g, (c) => c.toLowerCase())
        return
      case 'ascii_upcase/0':
        if (typeof input !== 'string') throw new JqError('explode input must be a string')
        yield input.replace(/[a-z]/g, (c) => c.toUpperCase())
        return
      case 'recurse/0':
        for (const [, value] of allPaths(input, [])) yield value
        return
      case 'recurse/1': {
        const visit = function* (this: Interpreter, value: Json): Generator<Json> {
          yield value
          for (const child of this.eval(args[0], value, env)) yield* visit.call(this, child)
        }
        yield* visit.call(this, input)
        return
      }
      case 'recurse/2': {
        const visit = function* (this: Interpreter, value: Json): Generator<Json> {
          yield value
          for (const child of this.eval(args[0], value, env))
            if ([...this.eval(args[1], child, env)].some(truthy)) yield* visit.call(this, child)
        }
        yield* visit.call(this, input)
        return
      }
      case 'env/0':
        yield this.options.env as Json
        return
      case 'builtins/0':
        yield BUILTINS
        return
      case 'input/0': {
        const next = this.options.inputs()
        if (next === undefined) throw new JqError('break')
        yield next
        return
      }
      case 'inputs/0':
        for (let next = this.options.inputs(); next !== undefined; next = this.options.inputs())
          yield next
        return
      case 'debug/0':
        this.options.stderr(toJson(['DEBUG:', input]) + '\n')
        yield input
        return
      case 'debug/1':
        for (const message of one(0)) this.options.stderr(toJson(['DEBUG:', message]) + '\n')
        yield input
        return
      case 'stderr/0':
        this.options.stderr(toJson(input))
        yield input
        return
      case 'input_filename/0':
        yield this.options.filename()
        return
      case 'test/1':
      case 'test/2':
        for (const flags of args.length > 1 ? one(1) : [null])
          for (const re of one(0)) yield matches(input, re, flags).length > 0
        return
      case 'match/1':
      case 'match/2':
        for (const flags of args.length > 1 ? one(1) : [null])
          for (const re of one(0)) yield* matches(input, re, flags)
        return
      case 'capture/1':
      case 'capture/2':
        for (const flags of args.length > 1 ? one(1) : [null])
          for (const re of one(0)) {
            for (const match of matches(input, re, flags) as Record<string, Json>[]) {
              const out: Record<string, Json> = {}
              for (const capture of match.captures as Record<string, Json>[])
                if (capture.name) out[capture.name as string] = capture.string
              yield out
            }
          }
        return
      case 'scan/1':
      case 'scan/2':
        for (const flags of args.length > 1 ? one(1) : [null])
          for (const re of one(0)) {
            for (const match of matches(input, re, flags, true) as Record<string, Json>[]) {
              const captures = match.captures as Record<string, Json>[]
              yield captures.length ? captures.map((capture) => capture.string) : match.string
            }
          }
        return
      case 'splits/1':
      case 'splits/2':
        yield* (
          ([
            ...this.call(
              { k: 'call', name: 'split', args: [args[0], args[1] ?? { k: 'literal', v: null }] },
              input,
              env,
            ),
          ][0] as Json[]) ?? []
        )
        return
      case 'sub/2':
      case 'sub/3':
      case 'gsub/2':
      case 'gsub/3': {
        if (typeof input !== 'string')
          throw new JqError(describe(input) + ' cannot be matched, as it is not a string')
        const flagsList = args.length > 2 ? all(2) : [null]
        for (const flags of flagsList)
          for (const re of one(0)) {
            const found = matches(input, re, flags, name === 'gsub') as Record<string, Json>[]
            const results = function* (
              this: Interpreter,
              at: number,
              prefix: string,
              cursor: number,
            ): Generator<Json> {
              const chars = [...input]
              if (at >= found.length) {
                yield prefix + chars.slice(cursor).join('')
                return
              }
              const match = found[at]
              const captures: Record<string, Json> = {}
              for (const capture of match.captures as Record<string, Json>[])
                if (capture.name) captures[capture.name as string] = capture.string
              for (const replacement of this.eval(args[1], captures, env)) {
                if (typeof replacement !== 'string')
                  throw new JqError(describe(replacement) + ' cannot be added to a string')
                yield* results.call(
                  this,
                  at + 1,
                  prefix + chars.slice(cursor, match.offset as number).join('') + replacement,
                  (match.offset as number) + (match.length as number),
                )
              }
            }
            yield* results.call(this, 0, '', 0)
          }
        return
      }
      case 'tojson/0':
        yield toJson(input)
        return
      case 'fromjson/0': {
        if (typeof input !== 'string')
          throw new JqError(describe(input) + ' only strings can be parsed')
        yield parseOne(input)
        return
      }
      case 'first/0':
        yield index(input, 0)
        return
      case 'last/0':
        yield index(input, -1)
        return
      case 'first/1':
        for (const value of one(0)) {
          yield value
          return
        }
        return
      case 'last/1': {
        let found: Json | undefined
        for (const value of one(0)) found = value
        if (found !== undefined) yield found
        return
      }
      case 'nth/1':
        for (const n of one(0)) yield index(input, n as number)
        return
      case 'nth/2':
        for (const n of one(0)) {
          let i = 0
          for (const value of one(1)) {
            if (i++ === n) {
              yield value
              break
            }
          }
        }
        return
      case 'limit/2':
        for (const n of one(0)) {
          if ((n as number) < 0) yield* one(1)
          if ((n as number) <= 0) continue
          let i = 0
          for (const value of one(1)) {
            yield value
            if (++i >= (n as number)) break
          }
        }
        return
      case 'until/2': {
        let value = input
        for (let i = 0; ![...this.eval(args[0], value, env)].some(truthy); i++) {
          this.options.tick()
          value = [...this.eval(args[1], value, env)][0] ?? null
        }
        yield value
        return
      }
      case 'while/2': {
        let value = input
        while ([...this.eval(args[0], value, env)].some(truthy)) {
          this.options.tick()
          yield value
          value = [...this.eval(args[1], value, env)][0] ?? null
        }
        return
      }
      case 'repeat/1': {
        const visit = function* (this: Interpreter, value: Json): Generator<Json> {
          for (const next of this.eval(args[0], value, env)) {
            yield next
            yield* visit.call(this, next)
          }
        }
        yield* visit.call(this, input)
        return
      }
      case 'isempty/1':
        yield one(0).next().done === true
        return
      case 'indices/1':
      case 'index/1':
      case 'rindex/1':
        for (const target of one(0)) {
          let found: number[]
          if (typeof input === 'string' && typeof target === 'string') {
            found = []
            if (target)
              for (let i = input.indexOf(target); i >= 0; i = input.indexOf(target, i + 1))
                found.push(i)
          } else if (Array.isArray(input))
            found = [
              ...this.eval(
                {
                  k: 'index',
                  target: { k: 'identity' },
                  key: { k: 'literal', v: Array.isArray(target) ? target : [target] },
                },
                input,
                env,
              ),
            ][0] as number[]
          else if (input === null) {
            yield null
            continue
          } else throw new JqError('Cannot determine indices of ' + typeOf(input))
          yield name === 'indices'
            ? found
            : name === 'index'
              ? (found[0] ?? null)
              : (found[found.length - 1] ?? null)
        }
        return
      case 'flatten/0':
        yield flatten(input as Json[], 1e9)
        return
      case 'flatten/1':
        for (const depth of one(0)) yield flatten(input as Json[], depth as number)
        return
      case 'objects/0':
      case 'arrays/0':
      case 'strings/0':
      case 'numbers/0':
      case 'booleans/0':
      case 'nulls/0':
      case 'iterables/0':
      case 'scalars/0': {
        const type = typeOf(input)
        const ok =
          name === 'iterables'
            ? type === 'array' || type === 'object'
            : name === 'scalars'
              ? type !== 'array' && type !== 'object'
              : name === type + 's'
        if (ok) yield input
        return
      }
      case 'fromstream/1': {
        const place = (target: Json, path: Json[], leaf: Json): Json => {
          if (!path.length) return leaf
          const [key, ...rest] = path
          if (typeof key === 'number') {
            const list = Array.isArray(target) ? target.slice() : []
            while (list.length < key) list.push(null)
            list[key] = place(list[key] ?? null, rest, leaf)
            return list
          }
          const object: Record<string, Json> =
            target !== null && typeof target === 'object' && !Array.isArray(target)
              ? { ...(target as Record<string, Json>) }
              : {}
          object[key as string] = place(object[key as string] ?? null, rest, leaf)
          return object as Json
        }
        let value: Json = null
        let emitted = false
        for (const event of this.eval(args[0], input, env)) {
          if (emitted) {
            value = null
            emitted = false
          }
          if (!Array.isArray(event) || !Array.isArray(event[0]))
            throw new JqError('Invalid stream event')
          const path = event[0] as Json[]
          if (event.length === 2) {
            if (!path.length) {
              yield event[1] ?? null
              continue
            }
            value = place(value, path, event[1] ?? null)
          } else if (path.length === 1) {
            yield value
            emitted = true
          }
        }
        return
      }
      case 'tostream/0': {
        const stream = function* (value: Json, path: Json[]): Generator<Json> {
          const entries: [Json, Json][] = Array.isArray(value)
            ? value.map((child, index) => [index, child])
            : value !== null && typeof value === 'object'
              ? Object.entries(value)
              : []
          if (!entries.length) {
            yield [path, value]
            return
          }
          for (const [key, child] of entries) yield* stream(child, [...path, key])
          yield [[...path, entries[entries.length - 1][0]]]
        }
        yield* stream(input, [])
        return
      }
      case 'walk/1': {
        const visit = (value: Json): Json => {
          let next = value
          if (Array.isArray(value)) next = value.map(visit)
          else if (value !== null && typeof value === 'object')
            next = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)]))
          return [...this.eval(args[0], next, env)][0] ?? null
        }
        yield visit(input)
        return
      }
      case 'transpose/0': {
        const rows = input as Json[][]
        const width = Math.max(0, ...rows.map((row) => row.length))
        yield Array.from({ length: width }, (_, i) => rows.map((row) => row[i] ?? null))
        return
      }
      case 'IN/1':
        for (const value of one(0))
          if (compare(value, input) === 0) {
            yield true
            return
          }
        yield false
        return
      case 'IN/2':
        for (const item of one(0))
          for (const value of one(1))
            if (compare(value, item) === 0) {
              yield true
              return
            }
        yield false
        return
      case 'INDEX/1': {
        const out: Record<string, Json> = {}
        if (!Array.isArray(input)) throw new JqError('Cannot iterate over ' + describe(input))
        for (const item of input)
          for (const k of this.eval(args[0], item, env)) out[tostring(k)] = item
        yield out
        return
      }
      case 'INDEX/2': {
        const out: Record<string, Json> = {}
        for (const item of one(0))
          for (const k of this.eval(args[1], item, env)) out[tostring(k)] = item
        yield out
        return
      }
      case 'pick/1': {
        let out: Json = null
        for (const [path] of this.paths(args[0], input, env)) {
          let value: Json = input
          for (const k of path) value = value === null ? null : index(value, k)
          out = setPath(out, path, value)
        }
        yield out
        return
      }
      case 'halt/0':
        throw new HaltSignal(0)
      case 'halt_error/0':
      case 'halt_error/1':
        for (const code of args.length ? one(0) : [5]) {
          if (input !== null)
            this.options.stderr(typeof input === 'string' ? input : toJson(input) + '\n')
          throw new HaltSignal(code as number)
        }
        return
      case 'now/0':
        yield Date.now() / 1000
        return
      case 'mktime/0':
        yield fromParts(input)
        return
      case 'gmtime/0':
      case 'localtime/0':
        yield dateParts(input as number)
        return
      case 'todate/0':
      case 'todateiso8601/0':
        yield new Date((input as number) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
        return
      case 'fromdate/0':
      case 'fromdateiso8601/0': {
        const time = Date.parse(input as string)
        if (Number.isNaN(time))
          throw new JqError('date "' + input + '" does not match format "%Y-%m-%dT%H:%M:%SZ"')
        yield Math.floor(time / 1000)
        return
      }
      case 'strftime/1':
      case 'strflocaltime/1':
        for (const spec of one(0)) {
          const seconds = Array.isArray(input) ? fromParts(input) : (input as number)
          yield strftime(spec as string, new Date(seconds * 1000))
        }
        return
      case 'strptime/1':
        for (const _spec of one(0)) {
          const time = Date.parse(input as string)
          if (Number.isNaN(time)) throw new JqError('date "' + input + '" does not match format')
          yield dateParts(time / 1000)
        }
        return
      case 'combinations/0': {
        const lists = input as Json[][]
        const visit = function* (at: number, acc: Json[]): Generator<Json> {
          if (at >= lists.length) {
            yield [...acc]
            return
          }
          for (const item of lists[at]) yield* visit(at + 1, [...acc, item])
        }
        yield* visit(0, [])
        return
      }
      case 'combinations/1':
        for (const n of one(0))
          yield* this.call(
            { k: 'call', name: 'combinations', args: [] },
            Array.from({ length: n as number }, () => input),
            env,
          )
        return
      case 'input_line_number/0':
        yield 0
        return
    }
    throw new JqError(name + '/' + args.length + ' is not defined')
  }
}

class HaltSignal {
  readonly code: number
  constructor(code: number) {
    this.code = code
  }
}

function patternNames(pattern: Pattern): string[] {
  if (pattern.k === 'var') return [pattern.name]
  if (pattern.k === 'array') return pattern.items.flatMap(patternNames)
  return pattern.entries.flatMap((entry) => [
    ...(entry.name ? [entry.name] : []),
    ...(entry.pattern ? patternNames(entry.pattern) : []),
  ])
}

function contains(a: Json, b: Json): boolean {
  if (typeOf(a) !== typeOf(b))
    throw new JqError(
      describe(a) + ' and ' + describe(b) + ' cannot have their containment checked',
    )
  if (typeof a === 'string') return a.includes(b as string)
  if (Array.isArray(a))
    return (b as Json[]).every((item) =>
      a.some((other) => typeOf(other) === typeOf(item) && contains(other, item)),
    )
  if (a !== null && typeof a === 'object')
    return Object.entries(b as object).every(
      ([k, v]) =>
        k in a &&
        typeOf((a as Record<string, Json>)[k]) === typeOf(v as Json) &&
        contains((a as Record<string, Json>)[k], v as Json),
    )
  return compare(a, b) === 0
}

type Source = { name: string; text: string }

type Input = { value: Json; name: string; line: number }

type Scope = { funcs: ReadonlySet<string>; vars: ReadonlySet<string>; labels: ReadonlySet<string> }

const USAGE =
  '\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq'

function tokenName(token: Token): string {
  if (token.t === 'eof') return 'end of file'
  if (token.t === 'str') return 'QQSTRING_START'
  if (token.t === 'num') return 'LITERAL'
  if (token.t === 'ident') return 'IDENT'
  if (token.t === 'field') return 'FIELD'
  if (token.t === 'var') return 'BINDING'
  if (token.t === 'format') return 'FORMAT'
  return token.v.length === 1 && !/\w/.test(token.v) ? "'" + token.v + "'" : token.v
}

function check(node: Node, scope: Scope, errors: CompileError[]) {
  const visit = (child: Node | undefined, inner: Scope = scope) => {
    if (child) check(child, inner, errors)
  }
  const bind = (names: readonly string[]): Scope => ({
    ...scope,
    vars: new Set([...scope.vars, ...names]),
  })
  const patterns = (pattern: Pattern) => {
    if (pattern.k === 'array') pattern.items.forEach(patterns)
    if (pattern.k === 'object')
      for (const entry of pattern.entries) {
        visit(entry.key)
        if (entry.pattern) patterns(entry.pattern)
      }
  }
  switch (node.k) {
    case 'call':
      if (!scope.funcs.has(node.name + '/' + node.args.length))
        errors.push(
          new CompileError(node.name + '/' + node.args.length + ' is not defined', node.at ?? 0),
        )
      for (const arg of node.args) visit(arg)
      return
    case 'var':
      if (!scope.vars.has(node.name))
        errors.push(new CompileError('$' + node.name + ' is not defined', node.at ?? 0))
      return
    case 'break':
      if (!scope.labels.has(node.name))
        errors.push(new CompileError('$*label-' + node.name + ' is not defined', node.at ?? 0))
      return
    case 'label':
      visit(node.body, { ...scope, labels: new Set([...scope.labels, node.name]) })
      return
    case 'def': {
      const funcs = new Set([...scope.funcs, node.name + '/' + node.params.length])
      const values = node.params
        .filter((param) => param.startsWith('$'))
        .map((param) => param.slice(1))
      visit(node.body, {
        funcs: new Set([...funcs, ...node.params.map((param) => param.replace(/^\$/, '') + '/0')]),
        vars: new Set([...scope.vars, ...values]),
        labels: scope.labels,
      })
      visit(node.rest, { ...scope, funcs })
      return
    }
    case 'as':
      visit(node.source)
      node.patterns.forEach(patterns)
      visit(node.body, bind(node.patterns.flatMap(patternNames)))
      return
    case 'reduce':
    case 'foreach': {
      const inner = bind(patternNames(node.pattern))
      visit(node.source)
      patterns(node.pattern)
      visit(node.init, inner)
      visit(node.update, inner)
      if (node.k === 'foreach') visit(node.extract, inner)
      return
    }
    case 'string':
      for (const part of node.parts) if (typeof part !== 'string') visit(part)
      return
    case 'object':
      for (const entry of node.entries) {
        visit(entry.key)
        visit(entry.value)
      }
      return
    case 'if':
      visit(node.cond)
      visit(node.then)
      for (const branch of node.elifs) {
        visit(branch.cond)
        visit(branch.then)
      }
      visit(node.else)
      return
    case 'try':
      visit(node.body)
      visit(node.handler)
      return
    case 'index':
      visit(node.target)
      visit(node.key)
      return
    case 'slice':
      visit(node.target)
      visit(node.from)
      visit(node.to)
      return
    case 'iterate':
      visit(node.target)
      return
    case 'neg':
      visit(node.e)
      return
    case 'array':
      visit(node.e)
      return
    case 'pipe':
    case 'comma':
    case 'alt':
    case 'binop':
    case 'and':
    case 'or':
    case 'assign':
      visit(node.left)
      visit(node.right)
      return
  }
}

function compileErrors(source: string, errors: readonly CompileError[]): string {
  const text = [...errors]
    .sort((a, b) => a.at - b.at)
    .map((error) => {
      const start = source.lastIndexOf('\n', error.at - 1) + 1
      const end = source.indexOf('\n', error.at)
      return (
        'jq: error: ' +
        error.message +
        ' at <top-level>, line ' +
        source.slice(0, start).split('\n').length +
        ':\n' +
        source.slice(start, end < 0 ? undefined : end) +
        ' '.repeat(error.at - start) +
        '\n'
      )
    })
    .join('')
  return text + 'jq: ' + errors.length + ' compile error' + (errors.length > 1 ? 's' : '') + '\n'
}

function reason(error: FsError): string {
  return error.message.slice(error.message.lastIndexOf(': ') + 2)
}

function scanJson(text: string): { values: { value: Json; end: number }[]; error?: string } {
  const values: { value: Json; end: number }[] = []
  const stack: Json[] = []
  let next: Json | undefined
  let token = ''
  let raw = ''
  let state: 'normal' | 'string' | 'escape' = 'normal'
  let line = 1
  let column = 0
  const at = () => ' at line ' + line + ', column ' + column
  const done = (end: number) => {
    if (stack.length || next === undefined) return
    values.push({ value: next, end })
    next = undefined
  }
  const value = (found: Json): string | undefined => {
    if (next !== undefined) return 'Expected separator between values'
    next = found
    return undefined
  }
  const set = (object: Json, key: string, found: Json) =>
    Object.defineProperty(object, key, {
      value: found,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  const literal = (): string | undefined => {
    if (!token) return undefined
    const word = token
    token = ''
    const pattern =
      word[0] === 't'
        ? 'true'
        : word[0] === 'f'
          ? 'false'
          : word[0] === 'n'
            ? word.length === 3
              ? 'nan'
              : 'null'
            : undefined
    if (pattern !== undefined) {
      if (word !== pattern) return 'Invalid literal'
      return value(
        pattern === 'true' ? true : pattern === 'false' ? false : pattern === 'null' ? null : NaN,
      )
    }
    if (!/^[+-]?((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|inf(inity)?|s?nan\d*)$/i.test(word))
      return 'Invalid numeric literal'
    const bare = word.replace(/^[+-]/, '').toLowerCase()
    if (bare.startsWith('inf')) return value(word[0] === '-' ? -Infinity : Infinity)
    return value(bare.includes('nan') ? NaN : Number(word))
  }
  const structure = (c: string): string | undefined => {
    const top = stack[stack.length - 1]
    if (c === '[' || c === '{') {
      if (next !== undefined) return 'Expected separator between values'
      stack.push(c === '[' ? [] : {})
      return undefined
    }
    if (c === ':') {
      if (next === undefined) return "Expected string key before ':'"
      if (top === undefined || typeOf(top) !== 'object') return "':' not as part of an object"
      if (typeof next !== 'string') return 'Object keys must be strings'
      stack.push(next)
      next = undefined
      return undefined
    }
    if (c === ',') {
      if (next === undefined) return "Expected value before ','"
      if (top === undefined) return "',' not as part of an object or array"
      if (Array.isArray(top)) top.push(next)
      else if (typeof top === 'string') {
        set(stack[stack.length - 2]!, top, next)
        stack.pop()
      } else return 'Objects must consist of key:value pairs'
      next = undefined
      return undefined
    }
    if (c === ']') {
      if (!Array.isArray(top)) return "Unmatched ']'"
      if (next !== undefined) top.push(next)
      else if (top.length) return 'Expected another array element'
      next = stack.pop()
      return undefined
    }
    if (top === undefined) return "Unmatched '}'"
    if (next !== undefined) {
      if (typeof top !== 'string') return 'Objects must consist of key:value pairs'
      set(stack[stack.length - 2]!, top, next)
      stack.pop()
    } else {
      if (typeOf(top) !== 'object') return "Unmatched '}'"
      if (Object.keys(top as object).length) return 'Expected another key-value pair'
    }
    next = stack.pop()
    return undefined
  }
  const unescape = (): string | { error: string } => {
    let out = ''
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i)
      if (raw[i] !== '\\') {
        if (code > 0 && code < 0x1f)
          return {
            error: 'Invalid string: control characters from U+0000 through U+001F must be escaped',
          }
        out += raw[i]
        continue
      }
      const c = raw[++i]
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      }
      if (c !== undefined && c in simple) {
        out += simple[c]
        continue
      }
      if (c !== 'u') return { error: 'Invalid escape' }
      const hex = raw.slice(i + 1, i + 5)
      if (hex.length < 4) return { error: 'Invalid \\uXXXX escape' }
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { error: 'Invalid characters in \\uXXXX escape' }
      i += 4
      let point = parseInt(hex, 16)
      if (point >= 0xd800 && point <= 0xdbff) {
        const low = /^\\u([0-9a-fA-F]{4})/.exec(raw.slice(i + 1))
        const second = low ? parseInt(low[1]!, 16) : 0
        if (second < 0xdc00 || second > 0xdfff)
          return { error: 'Invalid \\uXXXX\\uXXXX surrogate pair escape' }
        i += 6
        point = 0x10000 + ((point - 0xd800) << 10) + (second - 0xdc00)
      } else if (point >= 0xdc00 && point <= 0xdfff) point = 0xfffd
      out += String.fromCodePoint(point)
    }
    return out
  }
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i]!
    const code = c.charCodeAt(0)
    column +=
      code < 0x80
        ? 1
        : code < 0x800
          ? 2
          : code >= 0xdc00 && code < 0xe000
            ? 0
            : code >= 0xd800 && code < 0xdc00
              ? 4
              : 3
    if (c === '\n') {
      line++
      column = 0
    }
    if (state !== 'normal') {
      if (c === '"' && state === 'string') {
        const decoded = unescape()
        if (typeof decoded !== 'string') return { values, error: decoded.error + at() }
        raw = ''
        state = 'normal'
        const message = value(decoded)
        if (message) return { values, error: message + at() }
        done(i)
      } else {
        raw += c
        state = c === '\\' && state === 'string' ? 'escape' : 'string'
      }
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '"' || '[,]{:}'.includes(c)) {
      const message = literal()
      if (message) return { values, error: message + at() }
      done(i)
      if (c === '"') state = 'string'
      else if ('[,]{:}'.includes(c)) {
        const problem = structure(c)
        if (problem) return { values, error: problem + at() }
        done(i)
      }
    } else token += c
  }
  if (state !== 'normal') return { values, error: 'Unfinished string at EOF' + at() }
  const message = literal()
  if (message) return { values, error: message + ' at EOF' + at() }
  done(text.length)
  if (stack.length) return { values, error: 'Unfinished JSON term at EOF' + at() }
  return { values }
}

function parseOne(text: string): Json {
  const scanned = scanJson(text)
  const problem =
    scanned.error ??
    (scanned.values.length === 0
      ? 'Expected JSON value'
      : scanned.values.length > 1
        ? 'Unexpected extra JSON values'
        : undefined)
  if (problem !== undefined) throw new JqError(problem + " (while parsing '" + text + "')")
  return scanned.values[0]!.value
}

export function parseStream(text: string): Json[] {
  try {
    return [JSON.parse(text)]
  } catch {}
  const scanned = scanJson(text)
  if (scanned.error !== undefined) throw new JqError(scanned.error)
  return scanned.values.map((entry) => entry.value)
}

export const jq: CommandHandler = async (ctx) => {
  const args = ctx.args
  let raw = false
  let join = false
  let compact = false
  let nullInput = false
  let slurp = false
  let rawInput = false
  let sortKeys = false
  let exitStatus = false
  let tab = false
  let indent = 2
  let asciiOutput = false
  let rawOutput0 = false
  let streaming = false
  let sequence = false
  let filter: string | undefined
  const vars: Record<string, Json> = {}
  const named: Record<string, Json> = {}
  const files: string[] = []
  const positional: Json[] = []
  let mode: 'files' | 'args' | 'jsonargs' = 'files'
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (mode !== 'files' && filter !== undefined && !arg.startsWith('-')) {
      positional.push(mode === 'args' ? arg : (parseStream(arg)[0] ?? null))
      continue
    }
    if (arg === '--version') {
      ctx.stdout.write('jq-1.7\n')
      return 0
    }
    if (
      (arg === '--arg' || arg === '--argjson' || arg === '--slurpfile' || arg === '--rawfile') &&
      args[i + 2] === undefined
    )
      throw new CommandError(
        arg +
          ' takes two parameters (e.g. ' +
          arg +
          ' varname ' +
          (arg === '--arg' ? 'value' : arg === '--argjson' ? 'text' : 'filename') +
          ')' +
          USAGE,
        2,
      )
    if (arg === '--arg') {
      vars[args[i + 1]] = args[i + 2]
      named[args[i + 1]] = args[i + 2]
      i += 2
    } else if (arg === '--argjson') {
      let parsed: Json
      try {
        parsed = parseStream(args[i + 2] ?? '')[0]
      } catch {
        throw new CommandError('invalid JSON text passed to --argjson' + USAGE, 2)
      }
      vars[args[i + 1]] = parsed
      named[args[i + 1]] = parsed
      i += 2
    } else if (arg === '--slurpfile' || arg === '--rawfile') {
      const bad = 'Bad JSON in ' + arg + ' ' + args[i + 1] + ' ' + args[i + 2] + ': '
      const content = await ctx.fs.read(ctx.resolve(args[i + 2])).then(decode, (error: unknown) => {
        if (!(error instanceof FsError)) throw error
        throw new CommandError(bad + 'Could not open ' + args[i + 2] + ': ' + reason(error), 2)
      })
      const scanned = arg === '--rawfile' ? undefined : scanJson(content)
      if (scanned?.error !== undefined) throw new CommandError(bad + scanned.error, 2)
      vars[args[i + 1]] = scanned ? scanned.values.map((entry) => entry.value) : content
      i += 2
    } else if (arg === '--args') mode = 'args'
    else if (arg === '--jsonargs') mode = 'jsonargs'
    else if (arg === '--tab') tab = true
    else if (arg === '--indent') {
      if (args[i + 1] === undefined)
        throw new CommandError('--indent takes one parameter' + USAGE, 2)
      indent = Number(args[++i])
      if (!(indent >= -1 && indent <= 7))
        throw new CommandError('--indent takes a number between -1 and 7' + USAGE, 2)
    } else if (arg === '-f' || arg === '--from-file')
      filter = decode(await ctx.fs.read(ctx.resolve(args[++i])))
    else if (arg.startsWith('--')) {
      const long: Record<string, () => void> = {
        '--raw-output': () => (raw = true),
        '--join-output': () => (raw = join = true),
        '--compact-output': () => (compact = true),
        '--null-input': () => (nullInput = true),
        '--slurp': () => (slurp = true),
        '--raw-input': () => (rawInput = true),
        '--sort-keys': () => (sortKeys = true),
        '--exit-status': () => (exitStatus = true),
        '--ascii-output': () => (asciiOutput = true),
        '--raw-output0': () => (raw = rawOutput0 = true),
        '--color-output': () => undefined,
        '--monochrome-output': () => undefined,
        '--unbuffered': () => undefined,
        '--seq': () => (sequence = true),
        '--stream': () => (streaming = true),
      }
      if (!long[arg]) throw new CommandError('Unknown option ' + arg + USAGE, 2)
      long[arg]()
    } else if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      for (const flag of arg.slice(1)) {
        if (flag === 'r') raw = true
        else if (flag === 'j') raw = join = true
        else if (flag === 'c') compact = true
        else if (flag === 'n') nullInput = true
        else if (flag === 's') slurp = true
        else if (flag === 'R') rawInput = true
        else if (flag === 'S') sortKeys = true
        else if (flag === 'e') exitStatus = true
        else if (flag === 'a') asciiOutput = true
        else if (flag === 'C' || flag === 'M') continue
        else throw new CommandError('Unknown option ' + arg + USAGE, 2)
      }
    } else if (filter === undefined) filter = arg
    else files.push(arg)
  }
  if (filter === undefined) filter = '.'
  vars.__named = named
  let program: Node | undefined
  const errors: CompileError[] = []
  try {
    program = new Parser(lex(filter)).program()
    const names = Object.keys(vars).filter((name) => name !== '__named')
    check(
      program,
      { funcs: DEFINED, vars: new Set([...names, 'ENV', '__loc__', 'ARGS']), labels: new Set() },
      errors,
    )
  } catch (error) {
    if (error instanceof JqError)
      throw new CommandError('error: ' + error.message + '\njq: 1 compile error', 3)
    if (!(error instanceof CompileError)) throw error
    errors.push(error)
  }
  if (!program || errors.length) {
    ctx.stderr.write(compileErrors(filter, errors))
    return 3
  }
  const sources: Source[] = []
  let failed = false
  if (files.length) {
    for (const file of files) {
      try {
        sources.push({ name: file, text: decode(await ctx.fs.read(ctx.resolve(file))) })
      } catch (error) {
        if (!(error instanceof FsError)) throw error
        failed = true
        if (error.code !== 'EISDIR')
          ctx.stderr.write('jq: error: Could not open file ' + file + ': ' + reason(error) + '\n')
      }
    }
  } else sources.push({ name: '<stdin>', text: ctx.stdin.read() })
  const queue: Input[] = []
  let failure: string | undefined
  if (rawInput) {
    const text = sources.map((source) => source.text).join('')
    const name = sources[sources.length - 1]?.name ?? '<stdin>'
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    if (slurp) queue.push({ value: text, name, line: lines.length })
    else lines.forEach((value, i) => queue.push({ value, name, line: i + 1 }))
  } else {
    const text = sources.map((source) => source.text).join('')
    const scanned = scanJson(sequence ? text.replace(/\x1e/g, '\n') : text)
    failure = scanned.error
    let source = 0
    let start = 0
    let counted = 0
    let lines = 0
    const values = scanned.values.map((entry): Input => {
      while (source < sources.length - 1 && entry.end >= start + sources[source]!.text.length) {
        start += sources[source]!.text.length
        source++
        counted = start
        lines = 0
      }
      const newline = text.indexOf('\n', entry.end)
      const stop = Math.min(
        start + (sources[source]?.text.length ?? 0),
        newline < 0 ? text.length : newline + 1,
      )
      for (; counted < stop; counted++) if (text[counted] === '\n') lines++
      return { value: entry.value, name: sources[source]?.name ?? '<stdin>', line: lines }
    })
    const events = (value: Json): Json[] => {
      const out: Json[] = []
      const walk = (node: Json, path: Json[], top: boolean) => {
        const entries: [Json, Json][] = Array.isArray(node)
          ? node.map((child, index) => [index, child])
          : node !== null && typeof node === 'object'
            ? Object.entries(node)
            : []
        if (!entries.length) {
          out.push([path, node])
          return
        }
        for (const [key, child] of entries) walk(child, [...path, key], false)
        if (!top || path.length || entries.length)
          out.push([[...path, entries[entries.length - 1]![0]]])
      }
      walk(value, [], true)
      return out
    }
    const stream = streaming
      ? values.flatMap((input) => events(input.value).map((value) => ({ ...input, value })))
      : values
    const end = stream[stream.length - 1]
    if (!slurp) queue.push(...stream)
    else if (failure === undefined)
      queue.push({
        value: stream.map((input) => input.value),
        name: end?.name ?? sources[sources.length - 1]?.name ?? '<stdin>',
        line: end?.line ?? 0,
      })
  }
  let cursor = 0
  let current: Input | undefined
  const take = (): Input | undefined => {
    const input = queue[cursor++]
    const source = sources[sources.length - 1]
    current =
      input ??
      (source
        ? { value: null, name: source.name, line: source.text.split('\n').length - 1 }
        : current)
    return input
  }
  let steps = 0
  const interp = new Interpreter({
    env: ctx.env,
    vars,
    inputs: () => take()?.value,
    filename: () => current?.name ?? null,
    stderr: (text) => ctx.stderr.write(text),
    tick: () => {
      if (++steps % 4096 === 0 && ctx.signal.aborted)
        throw new CommandError('execution aborted', 124)
      if (steps > ctx.limits.maxCommands * 1000) throw new CommandError('too many steps', 124)
    },
    limit: ctx.limits.maxBufferLength,
  })
  const env = new Env()
  for (const [name, value] of Object.entries(vars)) env.vars.set(name, value)
  env.vars.set('__prog_args', { positional, named } as Json)
  const space = tab ? '\t' : compact ? 0 : indent
  let last: Json | undefined
  let status = 0
  const emit = (value: Json) => {
    last = value
    let out = raw && typeof value === 'string' ? value : toJson(value, space, sortKeys)
    if (asciiOutput)
      out = out.replace(
        /[\u007f-\uffff]/g,
        (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
      )
    ctx.stdout.write((sequence ? '\x1e' : '') + out + (rawOutput0 ? '\0' : join ? '' : '\n'))
  }
  const run = async (input: Json): Promise<number> => {
    try {
      for (const value of interp.eval(program, input, env)) {
        emit(value)
        await pause(ctx)
      }
      return 0
    } catch (error) {
      if (error instanceof JqError) {
        ctx.stderr.write(
          'jq: error (at ' +
            (current ? current.name + ':' + current.line : '<unknown>') +
            ')' +
            (typeof error.value === 'string'
              ? ': ' + error.value
              : ' (not a string): ' + toJson(error.value)) +
            '\n',
        )
        return 5
      }
      if (error instanceof BreakSignal) return 0
      throw error
    }
  }
  try {
    if (nullInput) status = await run(null)
    else for (let input = take(); input; input = take()) status = await run(input.value)
  } catch (error) {
    if (error instanceof HaltSignal) return error.code
    throw error
  }
  if (failure !== undefined && (!nullInput || cursor > queue.length))
    ctx.stderr.write('jq: parse error: ' + failure + '\n')
  else failure = undefined
  if (failed) return 2
  if (failure !== undefined) return 5
  if (status) return status
  if (exitStatus) return last === undefined ? 4 : truthy(last) ? 0 : 1
  return 0
}

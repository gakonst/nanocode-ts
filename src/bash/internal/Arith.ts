export type ArithValue = number | bigint

export type ArithScope = {
  get(name: string, index?: number): string
  set(name: string, value: ArithValue, index?: number): void
}

type Token =
  | { kind: 'num'; value: ArithValue }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string }

const OPERATORS = [
  '<<=',
  '>>=',
  '**',
  '++',
  '--',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '^=',
  '|=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '&',
  '^',
  '|',
  '!',
  '~',
  '?',
  ':',
  '=',
  '(',
  ')',
  '[',
  ']',
  ',',
]

const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|='])

const NUMBER = /0[xX][0-9a-zA-Z@_]*|\d+#[0-9a-zA-Z@_]*|\d[0-9a-zA-Z@_]*/y

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y

const SAFE = BigInt(Number.MAX_SAFE_INTEGER)

const CACHE = new Map<string, Token[]>()

export class ArithError extends Error {}

function normal(value: bigint): ArithValue {
  const wrapped = BigInt.asIntN(64, value)
  return wrapped >= -SAFE && wrapped <= SAFE ? Number(wrapped) : wrapped
}

function big(value: ArithValue): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

function digits(text: string, base: number, token: string): ArithValue {
  if (base < 2 || base > 64)
    throw new ArithError('invalid arithmetic base (error token is "' + token + '")')
  let value: ArithValue = 0
  for (const c of text) {
    const code = c.charCodeAt(0)
    const digit =
      code >= 48 && code <= 57
        ? code - 48
        : code >= 97 && code <= 122
          ? code - 87
          : code >= 65 && code <= 90
            ? base <= 36
              ? code - 55
              : code - 29
            : c === '@'
              ? 62
              : c === '_'
                ? 63
                : 64
    if (digit >= base)
      throw new ArithError('value too great for base (error token is "' + token + '")')
    if (typeof value === 'number') {
      const next: number = value * base + digit
      value = next <= Number.MAX_SAFE_INTEGER ? next : BigInt(value) * BigInt(base) + BigInt(digit)
    } else value = BigInt.asUintN(64, value * BigInt(base) + BigInt(digit))
  }
  return typeof value === 'bigint' ? normal(value) : value
}

function literal(text: string): ArithValue {
  if (/^0[xX]/.test(text)) {
    if (text.length === 2) throw new ArithError('invalid number (error token is "' + text + '")')
    return digits(text.slice(2), 16, text)
  }
  const hash = text.indexOf('#')
  if (hash > 0) {
    const base = Number(text.slice(0, hash))
    if (hash === text.length - 1)
      throw new ArithError('invalid number (error token is "' + text + '")')
    return digits(text.slice(hash + 1), base, text)
  }
  if (text.length > 1 && text[0] === '0') return digits(text.slice(1), 8, text)
  if (text.length <= 15 && /^\d+$/.test(text)) return Number(text)
  return digits(text, 10, text)
}

function tokenize(source: string): Token[] {
  const cached = CACHE.get(source)
  if (cached) return cached
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const code = source.charCodeAt(i)
    if (
      code === 32 ||
      code === 9 ||
      code === 10 ||
      code === 13 ||
      code === 34 ||
      code === 11 ||
      code === 12
    ) {
      i++
      continue
    }
    if (code >= 48 && code <= 57) {
      NUMBER.lastIndex = i
      const text = NUMBER.exec(source)![0]
      tokens.push({ kind: 'num', value: literal(text) })
      i += text.length
      continue
    }
    if (code === 95 || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      NAME.lastIndex = i
      const name = NAME.exec(source)![0]
      tokens.push({ kind: 'name', value: name })
      i += name.length
      continue
    }
    const op = OPERATORS.find((op) => source.startsWith(op, i))
    if (!op)
      throw new ArithError(
        'syntax error: invalid arithmetic operator (error token is "' + source.slice(i) + '")',
      )
    tokens.push({ kind: 'op', value: op })
    i += op.length
  }
  if (CACHE.size > 512) CACHE.clear()
  CACHE.set(source, tokens)
  return tokens
}

const BINARY: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
  '**': 11,
}

function power(base: ArithValue, exponent: ArithValue): ArithValue {
  if (exponent < 0)
    throw new ArithError('exponent less than 0 (error token is "' + String(exponent) + '")')
  if (typeof base === 'number' && typeof exponent === 'number') {
    const result = base ** exponent
    if (Number.isSafeInteger(result)) return result
  }
  let result = 1n
  let factor = BigInt.asUintN(64, big(base))
  let rest = big(exponent)
  while (rest > 0n) {
    if (rest & 1n) result = BigInt.asUintN(64, result * factor)
    factor = BigInt.asUintN(64, factor * factor)
    rest >>= 1n
  }
  return normal(result)
}

function shift(count: ArithValue): number {
  return typeof count === 'number' && count >= 0 && count < 64
    ? count
    : Number(BigInt.asUintN(6, big(count)))
}

function apply(op: string, a: ArithValue, b: ArithValue, run: boolean): ArithValue {
  const small = typeof a === 'number' && typeof b === 'number'
  switch (op) {
    case '+':
      if (small) {
        const result = (a as number) + (b as number)
        if (result <= Number.MAX_SAFE_INTEGER && result >= -Number.MAX_SAFE_INTEGER) return result
      }
      return normal(big(a) + big(b))
    case '-':
      if (small) {
        const result = (a as number) - (b as number)
        if (result <= Number.MAX_SAFE_INTEGER && result >= -Number.MAX_SAFE_INTEGER) return result
      }
      return normal(big(a) - big(b))
    case '*':
      if (small) {
        const result = (a as number) * (b as number)
        if (result <= Number.MAX_SAFE_INTEGER && result >= -Number.MAX_SAFE_INTEGER)
          return result + 0
      }
      return normal(big(a) * big(b))
    case '/':
    case '%':
      if (b == 0) {
        if (!run) return 0
        throw new ArithError('division by 0 (error token is "' + String(b) + '")')
      }
      if (small) {
        const rest = (a as number) % (b as number)
        return op === '%' ? rest + 0 : ((a as number) - rest) / (b as number) + 0
      }
      return normal(op === '/' ? big(a) / big(b) : big(a) % big(b))
    case '**':
      return power(a, b)
    case '<<': {
      const count = shift(b)
      if (typeof a === 'number' && count < 32) {
        const result = a * 2 ** count
        if (result <= Number.MAX_SAFE_INTEGER && result >= -Number.MAX_SAFE_INTEGER) return result
      }
      return normal(big(a) << BigInt(count))
    }
    case '>>': {
      const count = shift(b)
      if (typeof a === 'number') return Math.floor(a / 2 ** count)
      return normal(a >> BigInt(count))
    }
    case '<':
      return Number(a < b)
    case '>':
      return Number(a > b)
    case '<=':
      return Number(a <= b)
    case '>=':
      return Number(a >= b)
    case '==':
      return Number(a == b)
    case '!=':
      return Number(a != b)
    case '&':
    case '|':
    case '^':
      if (small && (a as number) === ((a as number) | 0) && (b as number) === ((b as number) | 0))
        return op === '&'
          ? (a as number) & (b as number)
          : op === '|'
            ? (a as number) | (b as number)
            : (a as number) ^ (b as number)
      return normal(op === '&' ? big(a) & big(b) : op === '|' ? big(a) | big(b) : big(a) ^ big(b))
  }
  throw new ArithError('unknown operator ' + op)
}

function numeric(text: string): ArithValue | undefined {
  const length = text.length
  if (!length || length > 20) return undefined
  let start = text.charCodeAt(0) === 45 ? 1 : 0
  if (start === length || (text.charCodeAt(start) === 48 && length > start + 1)) return undefined
  for (let i = start; i < length; i++) {
    const code = text.charCodeAt(i)
    if (code < 48 || code > 57) return undefined
  }
  return length <= 15 ? Number(text) : normal(BigInt(text))
}

export function evaluateArith(source: string, scope: ArithScope, depth = 0): ArithValue {
  if (depth > 32) throw new ArithError('expression recursion level exceeded')
  const tokens = tokenize(source)
  let pos = 0
  const peek = () => tokens[pos]
  const isOp = (value: string) => {
    const token = tokens[pos]
    return token !== undefined && token.kind === 'op' && token.value === value
  }
  const expect = (value: string) => {
    if (!isOp(value))
      throw new ArithError(
        'syntax error in expression (error token is "' +
          (peek() ? String(peek()!.value) : '') +
          '")',
      )
    pos++
  }
  const variable = (name: string, index?: number): ArithValue => {
    const raw = scope.get(name, index)
    const fast = numeric(raw)
    if (fast !== undefined) return fast
    const text = raw.trim()
    if (text === '') return 0
    return numeric(text) ?? evaluateArith(text, scope, depth + 1)
  }
  const subscript = (run: boolean): number | undefined => {
    if (!isOp('[')) return undefined
    pos++
    const index = comma(run)
    expect(']')
    return Number(index)
  }
  function comma(run: boolean): ArithValue {
    let value = assign(run)
    while (isOp(',')) {
      pos++
      value = assign(run)
    }
    return value
  }
  function assign(run: boolean): ArithValue {
    const token = peek()
    if (token?.kind === 'name') {
      const save = pos
      pos++
      const index = subscript(run)
      const next = peek()
      if (next?.kind === 'op' && ASSIGN.has(next.value)) {
        pos++
        const right = assign(run)
        const value =
          next.value === '='
            ? right
            : apply(next.value.slice(0, -1), variable(token.value, index), right, run)
        if (run) scope.set(token.value, value, index)
        return value
      }
      pos = save
    }
    return ternary(run)
  }
  function ternary(run: boolean): ArithValue {
    const cond = binary(1, run)
    if (!isOp('?')) return cond
    pos++
    const yes = comma(run && cond != 0)
    expect(':')
    const no = assign(run && cond == 0)
    return cond != 0 ? yes : no
  }
  function binary(min: number, run: boolean): ArithValue {
    let left = unary(run)
    for (;;) {
      const token = peek()
      if (token?.kind !== 'op') break
      const prec = BINARY[token.value]
      if (prec === undefined || prec < min) break
      pos++
      if (token.value === '&&') {
        const right = binary(prec + 1, run && left != 0)
        left = Number(left != 0 && right != 0)
      } else if (token.value === '||') {
        const right = binary(prec + 1, run && left == 0)
        left = Number(left != 0 || right != 0)
      } else {
        const right = binary(token.value === '**' ? prec : prec + 1, run)
        left = apply(token.value, left, right, run)
      }
    }
    return left
  }
  function unary(run: boolean): ArithValue {
    const token = peek()
    if (token?.kind === 'op') {
      if (token.value === '++' || token.value === '--') {
        pos++
        const name = peek()
        if (name?.kind !== 'name') throw new ArithError('syntax error: operand expected')
        pos++
        const index = subscript(run)
        const value = apply(token.value === '++' ? '+' : '-', variable(name.value, index), 1, run)
        if (run) scope.set(name.value, value, index)
        return value
      }
      if (
        token.value === '+' ||
        token.value === '-' ||
        token.value === '!' ||
        token.value === '~'
      ) {
        pos++
        const value = unary(run)
        if (token.value === '-') return typeof value === 'number' ? 0 - value : normal(-value)
        if (token.value === '!') return Number(value == 0)
        if (token.value === '~')
          return typeof value === 'number' && value === (value | 0) ? ~value : normal(~big(value))
        return value
      }
    }
    return postfix(run)
  }
  function postfix(run: boolean): ArithValue {
    const token = peek()
    if (!token) throw new ArithError('syntax error: operand expected')
    pos++
    if (token.kind === 'num') return token.value
    if (token.kind === 'op') {
      if (token.value !== '(')
        throw new ArithError(
          'syntax error: operand expected (error token is "' + token.value + '")',
        )
      const value = comma(run)
      expect(')')
      return value
    }
    const index = subscript(run)
    const value = variable(token.value, index)
    if (isOp('++') || isOp('--')) {
      const op = String(tokens[pos++].value)
      if (run) scope.set(token.value, apply(op === '++' ? '+' : '-', value, 1, run), index)
    }
    return value
  }
  if (!tokens.length) return 0
  const value = comma(true)
  if (pos < tokens.length)
    throw new ArithError(
      'syntax error in expression (error token is "' + String(tokens[pos].value) + '")',
    )
  return value
}

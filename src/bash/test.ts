import type { FileStat, LinkStat } from './fs.ts'

export type TestArg = { text: string; op?: boolean; pattern?: string; regex?: string }

export type TestHost = {
  stat(path: string): Promise<FileStat | null>
  lstat?(path: string): Promise<LinkStat | null>
  isSet(name: string): boolean
  match(text: string, pattern: string): boolean
  regex(text: string, source: string): boolean
}

export class TestError extends Error {}

const UNARY = new Set([
  '-e',
  '-a',
  '-f',
  '-d',
  '-s',
  '-r',
  '-w',
  '-x',
  '-L',
  '-h',
  '-n',
  '-z',
  '-v',
  '-t',
  '-p',
  '-S',
  '-b',
  '-c',
  '-g',
  '-u',
  '-k',
  '-O',
  '-G',
  '-N',
])
const BINARY = new Set([
  '=',
  '==',
  '!=',
  '<',
  '>',
  '-eq',
  '-ne',
  '-lt',
  '-le',
  '-gt',
  '-ge',
  '-nt',
  '-ot',
  '-ef',
  '=~',
])

function integer(text: string): number {
  const trimmed = text.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) throw new TestError(text + ': integer expression expected')
  return Number(trimmed)
}

export async function evaluateTest(
  args: TestArg[],
  double: boolean,
  host: TestHost,
): Promise<boolean> {
  let pos = 0
  const is = (text: string, op = false) =>
    pos < args.length && args[pos].text === text && (!double || Boolean(args[pos].op) === op)
  const isOr = () => (double ? is('||', true) : is('-o'))
  const isAnd = () => (double ? is('&&', true) : is('-a'))
  async function or(): Promise<boolean> {
    let value = await and()
    while (isOr()) {
      pos++
      const right = await and()
      value = value || right
    }
    return value
  }
  async function and(): Promise<boolean> {
    let value = await not()
    while (isAnd()) {
      pos++
      const right = await not()
      value = value && right
    }
    return value
  }
  async function not(): Promise<boolean> {
    if (is('!') && pos + 1 < args.length) {
      pos++
      return !(await not())
    }
    return primary()
  }
  async function primary(): Promise<boolean> {
    if (pos >= args.length) throw new TestError('argument expected')
    if (is('(', double) && pos + 1 < args.length) {
      pos++
      const value = await or()
      if (!is(')', double)) throw new TestError("')' expected")
      pos++
      return value
    }
    const first = args[pos]
    const next = args[pos + 1]
    if (
      next &&
      BINARY.has(next.text) &&
      pos + 2 < args.length &&
      (!double || (next.text === '<' || next.text === '>' ? next.op : !next.op))
    ) {
      pos += 3
      return binary(first, next.text, args[pos - 1])
    }
    if (
      UNARY.has(first.text) &&
      !first.op &&
      pos + 1 < args.length &&
      !(double && args[pos + 1].op)
    ) {
      pos += 2
      return unary(first.text, args[pos - 1].text)
    }
    pos++
    return first.text !== ''
  }
  async function unary(op: string, operand: string): Promise<boolean> {
    if (op === '-n') return operand !== ''
    if (op === '-z') return operand === ''
    if (op === '-v') return host.isSet(operand)
    if (op === '-t') return false
    if (op === '-L' || op === '-h') return (await host.lstat?.(operand))?.kind === 'symlink'
    const stat = await host.stat(operand)
    switch (op) {
      case '-e':
      case '-a':
        return stat !== null
      case '-f':
        return stat?.kind === 'file'
      case '-d':
        return stat?.kind === 'directory'
      case '-s':
        return stat !== null && stat.size > 0
      case '-r':
      case '-w':
      case '-O':
      case '-G':
        return stat !== null
      case '-x':
        return stat !== null && (stat.mode & 0o111) !== 0
      case '-k':
        return stat !== null && (stat.mode & 0o1000) !== 0
      case '-u':
        return stat !== null && (stat.mode & 0o4000) !== 0
      case '-g':
        return stat !== null && (stat.mode & 0o2000) !== 0
      default:
        return false
    }
  }
  async function binary(left: TestArg, op: string, right: TestArg): Promise<boolean> {
    switch (op) {
      case '=':
      case '==':
        return double
          ? host.match(left.text, right.pattern ?? right.text)
          : left.text === right.text
      case '!=':
        return double
          ? !host.match(left.text, right.pattern ?? right.text)
          : left.text !== right.text
      case '<':
        return left.text < right.text
      case '>':
        return left.text > right.text
      case '=~':
        return host.regex(left.text, right.regex ?? right.text)
      case '-eq':
        return integer(left.text) === integer(right.text)
      case '-ne':
        return integer(left.text) !== integer(right.text)
      case '-lt':
        return integer(left.text) < integer(right.text)
      case '-le':
        return integer(left.text) <= integer(right.text)
      case '-gt':
        return integer(left.text) > integer(right.text)
      case '-ge':
        return integer(left.text) >= integer(right.text)
      case '-nt':
      case '-ot': {
        const [a, b] = [await host.stat(left.text), await host.stat(right.text)]
        if (!a || !b) return op === '-nt' ? Boolean(a) : Boolean(b)
        return op === '-nt' ? a.mtime > b.mtime : a.mtime < b.mtime
      }
      case '-ef':
        return left.text === right.text
    }
    return false
  }
  if (!args.length) return false
  const value = await or()
  if (pos < args.length) throw new TestError(args[pos].text + ': unexpected argument')
  return value
}

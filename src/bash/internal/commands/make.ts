import { CommandError, type CommandContext, type CommandHandler } from '../Shell.ts'
import { decode } from '../Fs.ts'
import { globRegExp } from '../Text.ts'

type Origin = 'default' | 'environment' | 'file' | 'command line' | 'override' | 'automatic'

type Variable = { value: string; recursive: boolean; origin: Origin; exported: boolean }

type Recipe = { text: string; file: string; line: number }

type Rule = {
  prerequisites: string[]
  orderOnly: string[]
  recipe: Recipe[] | undefined
  file: string
  line: number
  variables: Map<string, Variable>
}

type Pattern = {
  target: string
  prerequisites: string[]
  orderOnly: string[]
  recipe: Recipe[]
  file: string
  line: number
}

type Built = { time: number; remade: boolean }

type Conditional = { active: boolean; taken: boolean; parent: boolean }

class MakeError extends Error {
  readonly status: number
  constructor(message: string, status = 2) {
    super(message)
    this.status = status
  }
}

const FUNCTIONS = new Set([
  'subst',
  'patsubst',
  'strip',
  'findstring',
  'filter',
  'filter-out',
  'sort',
  'word',
  'words',
  'wordlist',
  'firstword',
  'lastword',
  'dir',
  'notdir',
  'suffix',
  'basename',
  'addsuffix',
  'addprefix',
  'join',
  'wildcard',
  'realpath',
  'abspath',
  'if',
  'or',
  'and',
  'foreach',
  'call',
  'value',
  'shell',
  'error',
  'warning',
  'info',
  'origin',
  'flavor',
  'eval',
  'file',
])

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

const words = (text: string) => text.split(/\s+/).filter(Boolean)

function patternMatch(pattern: string, text: string): string | undefined {
  const index = pattern.indexOf('%')
  if (index < 0) return pattern === text ? '' : undefined
  const prefix = pattern.slice(0, index)
  const suffix = pattern.slice(index + 1)
  if (
    text.length < prefix.length + suffix.length ||
    !text.startsWith(prefix) ||
    !text.endsWith(suffix)
  )
    return undefined
  return text.slice(prefix.length, text.length - suffix.length)
}

function patternReplace(pattern: string, replacement: string, text: string): string {
  const stem = patternMatch(pattern, text)
  if (stem === undefined) return text
  return replacement.includes('%') ? replacement.replace('%', stem) : replacement
}

function splitArgs(text: string): string[] {
  const args: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '(' || c === '{') depth++
    else if (c === ')' || c === '}') depth--
    if (c === ',' && depth === 0) {
      args.push(current)
      current = ''
      continue
    }
    current += c
  }
  args.push(current)
  return args
}

function closing(text: string, start: number, open: string): number {
  const close = open === '(' ? ')' : '}'
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '{') depth++
    else if (c === ')' || c === '}') {
      depth--
      if (depth === 0) return c === close ? i : i
    }
  }
  return -1
}

function colon(text: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) {
      depth++
      i++
    } else if ((c === ')' || c === '}') && depth) depth--
    else if (c === ':' && !depth && !(i === 1 && /^[A-Za-z]$/.test(text[0]!) && text[2] === '\\'))
      return i
  }
  return -1
}

function stripComment(text: string): string {
  let out = ''
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\' && text[i + 1] === '#') {
      out += '#'
      i++
      continue
    }
    if (c === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) depth++
    else if ((c === ')' || c === '}') && depth) depth--
    if (c === '#' && !depth) break
    out += c
  }
  return out
}

class Make {
  ctx: CommandContext
  dir: string
  variables = new Map<string, Variable>()
  rules = new Map<string, Rule>()
  patterns: Pattern[] = []
  phony = new Set<string>()
  silentTargets = new Set<string>()
  silentAll = false
  defaultGoal: string | undefined
  options: {
    dry: boolean
    silent: boolean
    ignore: boolean
    keep: boolean
    always: boolean
    environment: boolean
  }
  level: number
  name: string
  built = new Map<string, Built>()
  building = new Set<string>()
  ran = 0
  failed = false
  makefiles: string[] = []

  constructor(ctx: CommandContext, dir: string, options: Make['options'], level: number) {
    this.ctx = ctx
    this.dir = dir
    this.options = options
    this.level = level
    this.name = level ? 'make[' + level + ']' : 'make'
  }

  resolve(path: string): string {
    return this.ctx.resolve(path.startsWith('/') ? path : this.dir + '/' + path)
  }

  set(name: string, value: string, recursive: boolean, origin: Origin, exported = false) {
    const existing = this.variables.get(name)
    if (
      existing &&
      (existing.origin === 'command line' || existing.origin === 'override') &&
      origin !== 'override' &&
      origin !== 'command line' &&
      origin !== 'automatic'
    )
      return
    if (existing?.origin === 'environment' && this.options.environment && origin === 'file') return
    this.variables.set(name, {
      value,
      recursive,
      origin,
      exported: exported || (existing?.exported ?? false),
    })
  }

  lookup(name: string, locals?: Map<string, Variable>): Variable | undefined {
    const local = locals?.get(name)
    if (local) return local
    const found = this.variables.get(name)
    if (found) return found
    const env = this.ctx.env[name]
    return env === undefined
      ? undefined
      : { value: env, recursive: true, origin: 'environment', exported: true }
  }

  async expand(text: string, locals?: Map<string, Variable>): Promise<string> {
    if (!text.includes('$')) return text
    let out = ''
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (c !== '$') {
        out += c
        continue
      }
      const next = text[i + 1]
      if (next === undefined) break
      if (next === '$') {
        out += '$'
        i++
        continue
      }
      if (next === '(' || next === '{') {
        const end = closing(text, i + 1, next)
        if (end < 0) throw new MakeError('*** unterminated variable reference.  Stop.')
        out += await this.reference(text.slice(i + 2, end), locals)
        i = end
        continue
      }
      out += await this.variable(next, locals)
      i++
    }
    return out
  }

  async variable(name: string, locals?: Map<string, Variable>): Promise<string> {
    const found = this.lookup(name, locals)
    if (!found) {
      if (
        name.length === 2 &&
        '@<^+?*%'.includes(name[0]!) &&
        (name[1] === 'D' || name[1] === 'F')
      ) {
        const value = await this.variable(name[0]!, locals)
        return words(value)
          .map((word) => {
            const slash = word.lastIndexOf('/')
            return name[1] === 'D'
              ? slash < 0
                ? '.'
                : word.slice(0, slash) || '/'
              : word.slice(slash + 1)
          })
          .join(' ')
      }
      return ''
    }
    return found.recursive ? this.expand(found.value, locals) : found.value
  }

  async reference(inner: string, locals?: Map<string, Variable>): Promise<string> {
    const space = inner.search(/[\s,]/)
    const head = space < 0 ? inner : inner.slice(0, space)
    if (space >= 0 && FUNCTIONS.has(head) && /\s/.test(inner[space]!))
      return this.call(head, inner.slice(space + 1).replace(/^\s+/, ''), locals)
    const name = await this.expand(inner, locals)
    const substitution = colon(name)
    if (substitution > 0 && name.includes('=', substitution)) {
      const variable = name.slice(0, substitution)
      const rest = name.slice(substitution + 1)
      const eq = rest.indexOf('=')
      const from = rest.slice(0, eq)
      const to = rest.slice(eq + 1)
      const value = await this.variable(variable, locals)
      return words(value)
        .map((word) =>
          from.includes('%')
            ? patternReplace(from, to, word)
            : word.endsWith(from)
              ? word.slice(0, word.length - from.length) + to
              : word,
        )
        .join(' ')
    }
    return this.variable(name, locals)
  }

  async call(name: string, raw: string, locals?: Map<string, Variable>): Promise<string> {
    const parts = splitArgs(raw)
    const arg = (index: number) => this.expand(parts[index] ?? '', locals)
    const rest = (index: number) => this.expand(parts.slice(index).join(','), locals)
    switch (name) {
      case 'subst': {
        const [from, to, text] = [await arg(0), await arg(1), await rest(2)]
        return from === '' ? text : text.split(from).join(to)
      }
      case 'patsubst': {
        const [from, to, text] = [await arg(0), await arg(1), await rest(2)]
        return words(text)
          .map((word) => patternReplace(from.trim(), to.trim(), word))
          .join(' ')
      }
      case 'strip':
        return words(await rest(0)).join(' ')
      case 'findstring': {
        const [needle, text] = [await arg(0), await rest(1)]
        return text.includes(needle) ? needle : ''
      }
      case 'filter':
      case 'filter-out': {
        const patterns = words(await arg(0))
        const keep = name === 'filter'
        return words(await rest(1))
          .filter(
            (word) =>
              patterns.some((pattern) => patternMatch(pattern, word) !== undefined) === keep,
          )
          .join(' ')
      }
      case 'sort':
        return [...new Set(words(await rest(0)))].sort().join(' ')
      case 'word': {
        const n = Number((await arg(0)).trim())
        if (!Number.isInteger(n) || n < 1)
          throw new MakeError("*** non-numeric first argument to 'word' function.  Stop.")
        return words(await rest(1))[n - 1] ?? ''
      }
      case 'words':
        return String(words(await rest(0)).length)
      case 'wordlist': {
        const start = Number((await arg(0)).trim())
        const end = Number((await arg(1)).trim())
        return words(await rest(2))
          .slice(start - 1, end)
          .join(' ')
      }
      case 'firstword':
        return words(await rest(0))[0] ?? ''
      case 'lastword':
        return words(await rest(0)).at(-1) ?? ''
      case 'dir':
        return words(await rest(0))
          .map((word) => (word.includes('/') ? word.slice(0, word.lastIndexOf('/') + 1) : './'))
          .join(' ')
      case 'notdir':
        return words(await rest(0))
          .map((word) => word.slice(word.lastIndexOf('/') + 1))
          .join(' ')
      case 'suffix':
        return words(await rest(0))
          .map((word) => word.match(/\.[^./]*$/)?.[0] ?? '')
          .filter(Boolean)
          .join(' ')
      case 'basename':
        return words(await rest(0))
          .map((word) => word.replace(/\.[^./]*$/, ''))
          .join(' ')
      case 'addsuffix': {
        const suffix = await arg(0)
        return words(await rest(1))
          .map((word) => word + suffix)
          .join(' ')
      }
      case 'addprefix': {
        const prefix = await arg(0)
        return words(await rest(1))
          .map((word) => prefix + word)
          .join(' ')
      }
      case 'join': {
        const a = words(await arg(0))
        const b = words(await rest(1))
        return Array.from(
          { length: Math.max(a.length, b.length) },
          (_, index) => (a[index] ?? '') + (b[index] ?? ''),
        ).join(' ')
      }
      case 'wildcard': {
        const out: string[] = []
        for (const pattern of words(await rest(0))) out.push(...(await this.glob(pattern)))
        return out.join(' ')
      }
      case 'realpath':
      case 'abspath': {
        const out: string[] = []
        for (const word of words(await rest(0))) {
          const path = this.resolve(word)
          if (name === 'realpath' && !(await this.ctx.fs.stat(path))) continue
          out.push(path)
        }
        return out.join(' ')
      }
      case 'if':
        return (await arg(0)).trim() ? arg(1) : rest(2)
      case 'or': {
        for (let i = 0; i < parts.length; i++) {
          const value = (await arg(i)).trim()
          if (value) return value
        }
        return ''
      }
      case 'and': {
        let value = ''
        for (let i = 0; i < parts.length; i++) {
          value = (await arg(i)).trim()
          if (!value) return ''
        }
        return value
      }
      case 'foreach': {
        const variable = (await arg(0)).trim()
        const list = words(await arg(1))
        const body = parts.slice(2).join(',')
        const out: string[] = []
        for (const item of list) {
          const scope = new Map(locals ?? [])
          scope.set(variable, {
            value: item,
            recursive: false,
            origin: 'automatic',
            exported: false,
          })
          out.push(await this.expand(body, scope))
        }
        return out.join(' ')
      }
      case 'call': {
        const variable = (await arg(0)).trim()
        const scope = new Map(locals ?? [])
        for (let i = 0; i < parts.length; i++)
          scope.set(String(i), {
            value: i === 0 ? variable : await arg(i),
            recursive: false,
            origin: 'automatic',
            exported: false,
          })
        for (let i = parts.length; i < 10; i++)
          scope.set(String(i), {
            value: '',
            recursive: false,
            origin: 'automatic',
            exported: false,
          })
        const found = this.lookup(variable, locals)
        return found ? this.expand(found.value, scope) : ''
      }
      case 'value':
        return this.lookup((await rest(0)).trim(), locals)?.value ?? ''
      case 'origin':
        return this.lookup((await rest(0)).trim(), locals)?.origin ?? 'undefined'
      case 'flavor': {
        const found = this.lookup((await rest(0)).trim(), locals)
        return found ? (found.recursive ? 'recursive' : 'simple') : 'undefined'
      }
      case 'shell': {
        const result = await this.ctx.exec(this.prefix() + (await rest(0)))
        return result.stdout.replace(/\n+$/, '').replace(/\n/g, ' ')
      }
      case 'error':
        throw new MakeError('*** ' + (await rest(0)) + '.  Stop.')
      case 'warning':
        this.ctx.stderr.write('Makefile: ' + (await rest(0)) + '\n')
        return ''
      case 'info':
        this.ctx.stdout.write((await rest(0)) + '\n')
        return ''
      case 'eval':
        await this.parse((await rest(0)).split('\n'), 'eval')
        return ''
      case 'file': {
        const spec = (await arg(0)).trim()
        const match = spec.match(/^(>>|>|<)\s*(.+)$/)
        if (!match) return ''
        const path = this.resolve(match[2]!)
        if (match[1] === '<') {
          try {
            return decode(await this.ctx.fs.read(path)).replace(/\n$/, '')
          } catch {
            return ''
          }
        }
        const text = parts.length > 1 ? await rest(1) : undefined
        await this.ctx.fs.write(
          path,
          new TextEncoder().encode(
            text === undefined ? '' : text.endsWith('\n') ? text : text + '\n',
          ),
          match[1] === '>>',
        )
        return ''
      }
    }
    return ''
  }

  async glob(pattern: string): Promise<string[]> {
    const parts = pattern.split('/')
    let paths = [pattern.startsWith('/') ? '/' : '']
    for (const [index, part] of parts.entries()) {
      if (part === '' && index === 0) continue
      const next: string[] = []
      for (const base of paths) {
        if (!/[*?[]/.test(part)) {
          const path = base === '' ? part : base.endsWith('/') ? base + part : base + '/' + part
          if (await this.ctx.fs.stat(this.resolve(path))) next.push(path)
          continue
        }
        const regex = globRegExp(part)
        let names: string[] = []
        try {
          names = await this.ctx.fs.list(this.resolve(base || '.'))
        } catch {
          continue
        }
        for (const name of names.sort())
          if (regex.test(name) && (!name.startsWith('.') || part.startsWith('.')))
            next.push(base === '' ? name : base.endsWith('/') ? base + name : base + '/' + name)
      }
      paths = next
    }
    return paths.filter(Boolean)
  }

  prefix(): string {
    const exports: string[] = []
    for (const [name, variable] of this.variables)
      if (variable.exported || variable.origin === 'command line') exports.push(name)
    let prefix = this.dir !== this.ctx.cwd ? 'cd ' + quote(this.dir) + ' || exit; ' : ''
    return (
      prefix +
      exports
        .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        .map(
          (name) =>
            'export ' +
            name +
            '=' +
            quote(this.exported.get(name) ?? this.variables.get(name)!.value) +
            '; ',
        )
        .join('')
    )
  }

  exported = new Map<string, string>()

  async load(path: string, name: string, optional: boolean) {
    let text: string
    try {
      text = decode(await this.ctx.fs.read(this.resolve(path)))
    } catch {
      if (optional) return
      throw new MakeError(name + ': No such file or directory')
    }
    this.makefiles.push(name)
    this.set(
      'MAKEFILE_LIST',
      words((this.variables.get('MAKEFILE_LIST')?.value ?? '') + ' ' + name).join(' '),
      false,
      'file',
    )
    await this.parse(text.split('\n'), name)
  }

  async parse(lines: string[], file: string) {
    const stack: Conditional[] = []
    const active = () => stack.every((entry) => entry.active)
    let current: { targets: string[]; recipe: Recipe[] } | undefined
    let defining:
      | {
          name: string
          op: string
          body: string[]
          exported: boolean
          override: boolean
          depth: number
        }
      | undefined
    for (let index = 0; index < lines.length; index++) {
      let line = lines[index]!
      const number = index + 1
      if (defining) {
        const trimmed = line.trim()
        if (/^define\b/.test(trimmed)) defining.depth++
        if (/^endef\b/.test(trimmed) && --defining.depth === 0) {
          if (active()) {
            const value = defining.body.join('\n')
            const simple = defining.op === ':=' || defining.op === '::='
            this.set(
              defining.name,
              simple ? await this.expand(value) : value,
              !simple,
              defining.override ? 'override' : 'file',
              defining.exported,
            )
          }
          defining = undefined
          continue
        }
        defining.body.push(line)
        continue
      }
      if (line.startsWith('\t') && current) {
        let text = line.slice(1)
        let end = index
        while (text.endsWith('\\') && end + 1 < lines.length) {
          end++
          const next = lines[end]!
          text += '\n' + (next.startsWith('\t') ? next.slice(1) : next)
        }
        index = end
        if (active()) current.recipe.push({ text, file, line: number })
        continue
      }
      while (line.endsWith('\\') && index + 1 < lines.length) {
        index++
        line = line.slice(0, -1).replace(/\s+$/, '') + ' ' + lines[index]!.replace(/^\s+/, '')
      }
      const stripped = stripComment(line)
      const trimmed = stripped.trim()
      if (!trimmed) {
        continue
      }
      const conditional = trimmed.match(/^(ifeq|ifneq|ifdef|ifndef)\b\s*(.*)$/)
      if (conditional) {
        const parent = active()
        const result = parent ? await this.condition(conditional[1]!, conditional[2]!) : false
        stack.push({ active: result, taken: result, parent })
        current = undefined
        continue
      }
      const otherwise = trimmed.match(/^else\b\s*(.*)$/)
      if (otherwise) {
        const top = stack.at(-1)
        if (!top) throw new MakeError(file + ':' + number + ": *** extraneous 'else'.  Stop.")
        const nested = otherwise[1]!.match(/^(ifeq|ifneq|ifdef|ifndef)\b\s*(.*)$/)
        if (top.taken || !top.parent) top.active = false
        else {
          top.active = nested ? await this.condition(nested[1]!, nested[2]!) : true
          top.taken = top.active
        }
        continue
      }
      if (/^endif\b/.test(trimmed)) {
        if (!stack.pop())
          throw new MakeError(file + ':' + number + ": *** extraneous 'endif'.  Stop.")
        continue
      }
      if (!active()) continue
      const define = trimmed.match(
        /^(override\s+)?(export\s+)?define\s+(\S+?)\s*(=|:=|::=|\+=|\?=)?\s*$/,
      )
      if (define) {
        defining = {
          name: define[3]!,
          op: define[4] ?? '=',
          body: [],
          exported: !!define[2],
          override: !!define[1],
          depth: 1,
        }
        current = undefined
        continue
      }
      const include = trimmed.match(/^(-?include|sinclude)\s+(.*)$/)
      if (include) {
        for (const name of words(await this.expand(include[2]!)))
          await this.load(name, name, include[1] !== 'include')
        current = undefined
        continue
      }
      if (/^(un)?export$/.test(trimmed)) continue
      const exporting = trimmed.match(/^(un)?export\s+(.*)$/)
      if (exporting && !/(^|[^:+?!])=|:=|\+=|\?=|!=/.test(exporting[2]!)) {
        for (const name of words(await this.expand(exporting[2]!))) {
          const existing = this.variables.get(name)
          if (exporting[1]) {
            if (existing) existing.exported = false
          } else if (existing) existing.exported = true
          else
            this.variables.set(name, {
              value: this.ctx.env[name] ?? '',
              recursive: true,
              origin: this.ctx.env[name] === undefined ? 'file' : 'environment',
              exported: true,
            })
        }
        continue
      }
      if (/^vpath\b/.test(trimmed)) continue
      const assignment = trimmed.match(
        /^(override\s+)?(export\s+)?([^\s:#=]+?|[^\s:#=]*\$[({][^)}]*[)}][^\s:#=]*)\s*(::=|:::=|:=|\+=|\?=|!=|=)\s*(.*)$/,
      )
      if (assignment && colon(trimmed.slice(0, trimmed.indexOf(assignment[4]!))) < 0) {
        await this.assign(
          await this.expand(assignment[3]!),
          assignment[4]!,
          assignment[5]!,
          assignment[1] ? 'override' : 'file',
          !!assignment[2],
        )
        current = undefined
        continue
      }
      const split = colon(stripped)
      if (split < 0) {
        if (trimmed.startsWith('$')) {
          const expanded = (await this.expand(trimmed)).trim()
          if (expanded) throw new MakeError(file + ':' + number + ': *** missing separator.  Stop.')
          continue
        }
        throw new MakeError(file + ':' + number + ': *** missing separator.  Stop.')
      }
      current = await this.rule(stripped, split, file, number, line)
    }
    if (defining)
      throw new MakeError(
        file + ':' + lines.length + ": *** missing 'endef', unterminated 'define'.  Stop.",
      )
    if (stack.length)
      throw new MakeError(file + ':' + lines.length + ": *** missing 'endif'.  Stop.")
  }

  async condition(kind: string, text: string): Promise<boolean> {
    if (kind === 'ifdef' || kind === 'ifndef') {
      const name = (await this.expand(text.trim())).trim()
      const found = this.lookup(name)
      const defined = found !== undefined && found.value !== ''
      return kind === 'ifdef' ? defined : !defined
    }
    let a: string
    let b: string
    const paren = text.trim().match(/^\((.*)\)$/s)
    if (paren) {
      const args = splitArgs(paren[1]!)
      a = args[0] ?? ''
      b = args.slice(1).join(',')
      a = (await this.expand(a)).trim()
      b = (await this.expand(b)).trim()
    } else {
      const quoted = text.trim().match(/^(["'])(.*?)\1\s+(["'])(.*?)\3$/)
      if (!quoted) throw new MakeError('*** invalid syntax in conditional.  Stop.')
      a = await this.expand(quoted[2]!)
      b = await this.expand(quoted[4]!)
    }
    return kind === 'ifeq' ? a === b : a !== b
  }

  async assign(
    name: string,
    op: string,
    raw: string,
    origin: Origin,
    exported: boolean,
    target?: Map<string, Variable>,
  ) {
    const store = target ?? this.variables
    const existing = target ? (target.get(name) ?? this.lookup(name)) : this.lookup(name)
    let value: string
    let recursive: boolean
    if (op === '?=') {
      if (existing) return
      value = raw
      recursive = true
    } else if (op === '+=') {
      if (existing) {
        recursive = existing.recursive
        const addition = recursive ? raw : await this.expand(raw)
        value = existing.value === '' ? addition : existing.value + ' ' + addition
      } else {
        value = raw
        recursive = true
      }
    } else if (op === '!=') {
      const result = await this.ctx.exec(this.prefix() + (await this.expand(raw)))
      value = result.stdout.replace(/\n+$/, '').replace(/\n/g, ' ')
      recursive = false
    } else if (op === '=') {
      value = raw
      recursive = true
    } else {
      value = await this.expand(raw)
      recursive = false
    }
    if (target) target.set(name, { value, recursive, origin, exported })
    else {
      void store
      this.set(name, value, recursive, origin, exported)
    }
  }

  async rule(
    text: string,
    split: number,
    file: string,
    number: number,
    original: string,
  ): Promise<{ targets: string[]; recipe: Recipe[] }> {
    const double = text[split + 1] === ':'
    const targetText = text.slice(0, split)
    let rest = text.slice(split + (double ? 2 : 1))
    let inline: string | undefined
    const semicolon = original.indexOf(
      ';',
      original.indexOf(':', original.indexOf(targetText.trim()) + targetText.trim().length - 1),
    )
    if (rest.includes(';') && semicolon >= 0) {
      inline = original.slice(semicolon + 1).replace(/^\s+/, '')
      rest = rest.slice(0, rest.indexOf(';'))
    }
    const targets = words(await this.expand(targetText))
    const recipe: Recipe[] = inline !== undefined ? [{ text: inline, file, line: number }] : []
    const specific = rest.match(
      /^\s*(override\s+)?(export\s+)?([^\s:#=]+)\s*(::=|:=|\+=|\?=|!=|=)\s*(.*)$/,
    )
    if (specific && inline === undefined) {
      for (const target of targets) {
        const rule = this.ensure(target, file, number)
        await this.assign(
          specific[3]!,
          specific[4]!,
          specific[5]!,
          specific[1] ? 'override' : 'file',
          !!specific[2],
          rule.variables,
        )
      }
      return { targets: [], recipe: [] }
    }
    const second = colon(rest)
    let staticPattern: string | undefined
    if (second >= 0) {
      staticPattern = (await this.expand(rest.slice(0, second))).trim()
      rest = rest.slice(second + 1)
    }
    const expanded = await this.expand(rest)
    const [normal, order = ''] = expanded.split('|')
    const prerequisites = words(normal!)
    const orderOnly = words(order)
    for (const target of targets) {
      if (target === '.PHONY') {
        for (const name of prerequisites) this.phony.add(name)
        continue
      }
      if (target === '.SILENT') {
        if (!prerequisites.length) this.silentAll = true
        for (const name of prerequisites) this.silentTargets.add(name)
        continue
      }
      if (target.startsWith('.') && !target.includes('/') && /^\.[A-Z_]+$/.test(target)) continue
      if (staticPattern !== undefined) {
        const stem = patternMatch(staticPattern, target)
        if (stem === undefined) continue
        const rule = this.ensure(target, file, number)
        rule.prerequisites.push(...prerequisites.map((item) => item.replace('%', stem)))
        rule.orderOnly.push(...orderOnly.map((item) => item.replace('%', stem)))
        rule.recipe = recipe
        rule.variables.set('*', {
          value: stem,
          recursive: false,
          origin: 'automatic',
          exported: false,
        })
        continue
      }
      if (target.includes('%')) {
        this.patterns.push({ target, prerequisites, orderOnly, recipe, file, line: number })
        continue
      }
      const rule = this.ensure(target, file, number)
      rule.prerequisites.push(...prerequisites.filter((item) => !rule.prerequisites.includes(item)))
      rule.orderOnly.push(...orderOnly)
      if (inline !== undefined || !rule.recipe) {
        if (rule.recipe && rule.recipe.length && inline !== undefined)
          this.ctx.stderr.write(
            file + ':' + number + ": warning: overriding recipe for target '" + target + "'\n",
          )
        rule.recipe = recipe
        rule.line = number
        rule.file = file
      } else if (rule.recipe.length === 0) {
        rule.recipe = recipe
        rule.line = number
      } else {
        this.ctx.stderr.write(
          file + ':' + number + ": warning: overriding recipe for target '" + target + "'\n",
        )
        rule.recipe = recipe
      }
      if (this.defaultGoal === undefined && !target.startsWith('.')) this.defaultGoal = target
    }
    if (staticPattern !== undefined)
      for (const target of targets)
        if (this.defaultGoal === undefined && !target.startsWith('.')) this.defaultGoal = target
    return { targets, recipe }
  }

  ensure(target: string, file: string, line: number): Rule {
    let rule = this.rules.get(target)
    if (!rule) {
      rule = {
        prerequisites: [],
        orderOnly: [],
        recipe: undefined,
        file,
        line,
        variables: new Map(),
      }
      this.rules.set(target, rule)
    }
    return rule
  }

  async exists(path: string): Promise<boolean> {
    return (await this.ctx.fs.stat(this.resolve(path))) !== null
  }

  async implicit(
    target: string,
    depth = 0,
  ): Promise<{ pattern: Pattern; stem: string } | undefined> {
    for (const pattern of this.patterns) {
      if (!pattern.recipe.length && depth === 0) continue
      const slash = !pattern.target.includes('/') && target.includes('/')
      const name = slash ? target.slice(target.lastIndexOf('/') + 1) : target
      const stem = patternMatch(pattern.target, name)
      if (stem === undefined) continue
      const fullStem = slash ? target.slice(0, target.lastIndexOf('/') + 1) + stem : stem
      let ok = true
      for (const prerequisite of pattern.prerequisites) {
        const path = prerequisite.replace('%', fullStem)
        if (this.rules.has(path) || this.phony.has(path) || (await this.exists(path))) continue
        if (depth < 2 && (await this.implicit(path, depth + 1))) continue
        ok = false
        break
      }
      if (ok) return { pattern, stem: fullStem }
    }
    return undefined
  }

  async mtime(target: string): Promise<number | undefined> {
    return (await this.ctx.fs.stat(this.resolve(target)))?.mtime
  }

  async build(target: string, parent?: string): Promise<Built> {
    const done = this.built.get(target)
    if (done) return done
    if (this.building.has(target)) {
      this.ctx.stderr.write(
        this.name + ': Circular ' + parent + ' <- ' + target + ' dependency dropped.\n',
      )
      return { time: 0, remade: false }
    }
    this.building.add(target)
    try {
      const result = await this.make(target, parent)
      this.built.set(target, result)
      return result
    } finally {
      this.building.delete(target)
    }
  }

  async make(target: string, parent?: string): Promise<Built> {
    const rule = this.rules.get(target)
    let recipe = rule?.recipe && rule.recipe.length ? rule.recipe : undefined
    let prerequisites = [...(rule?.prerequisites ?? [])]
    let orderOnly = [...(rule?.orderOnly ?? [])]
    let stem = rule?.variables.get('*')?.value ?? ''
    if (!recipe && !this.phony.has(target)) {
      const found = await this.implicit(target)
      if (found) {
        recipe = found.pattern.recipe
        stem = found.stem
        prerequisites = [
          ...found.pattern.prerequisites.map((item) => item.replace('%', found.stem)),
          ...prerequisites,
        ]
        orderOnly = [
          ...found.pattern.orderOnly.map((item) => item.replace('%', found.stem)),
          ...orderOnly,
        ]
      }
    }
    const before = await this.mtime(target)
    if (!rule && !recipe) {
      if (before !== undefined) return { time: before, remade: false }
      if (this.phony.has(target)) return { time: Infinity, remade: true }
      throw new MakeError(
        parent === undefined
          ? "*** No rule to make target '" + target + "'.  Stop."
          : "*** No rule to make target '" + target + "', needed by '" + parent + "'.  Stop.",
      )
    }
    let newest = 0
    let remade = false
    const results: Built[] = []
    for (const prerequisite of prerequisites) {
      try {
        const result = await this.build(prerequisite, target)
        results.push(result)
        newest = Math.max(newest, result.time)
        if (result.remade || this.phony.has(prerequisite)) remade = true
      } catch (error) {
        if (error instanceof MakeError && this.options.keep && !error.message.includes('No rule')) {
          this.failed = true
          return { time: Infinity, remade: false }
        }
        throw error
      }
    }
    for (const prerequisite of orderOnly) await this.build(prerequisite, target)
    const phony = this.phony.has(target)
    const needed =
      phony ||
      before === undefined ||
      this.options.always ||
      newest > before ||
      (remade && results.some((result) => result.time === Infinity))
    if (!needed) return { time: before!, remade: false }
    if (recipe) await this.run(target, recipe, rule, prerequisites, stem, before, results)
    const after = phony ? undefined : await this.mtime(target)
    return { time: after ?? Infinity, remade: recipe !== undefined || remade }
  }

  async run(
    target: string,
    recipe: Recipe[],
    rule: Rule | undefined,
    prerequisites: string[],
    stem: string,
    before: number | undefined,
    results: Built[],
  ) {
    const locals = new Map<string, Variable>(rule?.variables ?? [])
    const auto = (name: string, value: string) =>
      locals.set(name, { value, recursive: false, origin: 'automatic', exported: false })
    auto('@', target)
    auto('<', prerequisites[0] ?? '')
    auto('^', [...new Set(prerequisites)].join(' '))
    auto('+', prerequisites.join(' '))
    auto(
      '?',
      prerequisites
        .filter((_, index) => before === undefined || (results[index]?.time ?? Infinity) > before)
        .join(' '),
    )
    auto('*', stem)
    for (const [name, variable] of rule?.variables ?? [])
      if (variable.exported) this.exported.set(name, variable.value)
    for (const step of recipe) {
      let command = await this.expand(step.text, locals)
      let silent = this.options.silent || this.silentAll || this.silentTargets.has(target)
      let ignore = this.options.ignore
      let force = false
      for (;;) {
        const match = command.match(/^\s*([@+-])/)
        if (!match) break
        if (match[1] === '@') silent = true
        else if (match[1] === '-') ignore = true
        else force = true
        command = command.slice(match[0].length)
      }
      command = command.replace(/^\s+/, '')
      const recursive = /\$\(MAKE\)|\$\{MAKE\}/.test(step.text)
      this.ran++
      if (!silent || (this.options.dry && !force && !recursive))
        this.ctx.stdout.write(command + '\n')
      if (this.options.dry && !force && !recursive) continue
      if (!command.trim()) continue
      const result = await this.ctx.exec(
        this.prefix() + 'export MAKELEVEL=' + (this.level + 1) + '; ' + command,
      )
      this.ctx.stdout.write(result.stdout)
      if (result.status !== 0) {
        const where = '[' + step.file + ':' + step.line + ': ' + target + '] Error ' + result.status
        if (ignore) {
          this.ctx.stderr.write(this.name + ': ' + where + ' (ignored)\n')
          continue
        }
        throw new MakeError('*** ' + where, 2)
      }
    }
  }
}

export const make: CommandHandler = async (ctx) => {
  const args = ctx.args
  const files: string[] = []
  const goals: string[] = []
  const assignments: [string, string, string][] = []
  const options = {
    dry: false,
    silent: false,
    ignore: false,
    keep: false,
    always: false,
    environment: false,
  }
  let dir = ctx.cwd
  let printDirectory: boolean | undefined
  const value = (
    index: number,
    arg: string,
    short: string,
    long: string,
  ): [string, number] | undefined => {
    if (arg === short || arg === long) return [args[index + 1] ?? '', index + 1]
    if (arg.startsWith(long + '=')) return [arg.slice(long.length + 1), index]
    if (arg.startsWith(short) && arg.length > 2) return [arg.slice(2), index]
    return undefined
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const file = value(i, arg, '-f', '--file') ?? value(i, arg, '-f', '--makefile')
    if (file) {
      files.push(file[0])
      i = file[1]
      continue
    }
    const directory = value(i, arg, '-C', '--directory')
    if (directory) {
      dir = ctx.resolve(dir === ctx.cwd ? directory[0] : dir + '/' + directory[0])
      i = directory[1]
      if (printDirectory === undefined) printDirectory = true
      continue
    }
    if (/^-j\d*$|^--jobs(=\d+)?$|^-l\d*(\.\d+)?$|^--load-average/.test(arg)) {
      if ((arg === '-j' || arg === '--jobs' || arg === '-l') && /^\d+$/.test(args[i + 1] ?? '')) i++
      continue
    }
    if (arg === '--version' || arg === '-v') {
      ctx.stdout.write('GNU Make 4.3\nBuilt for x86_64-pc-linux-gnu\n')
      return 0
    }
    if (arg === '--no-print-directory') {
      printDirectory = false
      continue
    }
    if (arg === '-w' || arg === '--print-directory') {
      printDirectory = true
      continue
    }
    const long: Record<string, keyof typeof options> = {
      '--dry-run': 'dry',
      '--just-print': 'dry',
      '--recon': 'dry',
      '--silent': 'silent',
      '--quiet': 'silent',
      '--ignore-errors': 'ignore',
      '--keep-going': 'keep',
      '--always-make': 'always',
      '--environment-overrides': 'environment',
    }
    if (long[arg]) {
      options[long[arg]!] = true
      continue
    }
    if (/^-[a-zA-Z]+$/.test(arg)) {
      for (const flag of arg.slice(1)) {
        if (flag === 'n') options.dry = true
        else if (flag === 's') options.silent = true
        else if (flag === 'i') options.ignore = true
        else if (flag === 'k') options.keep = true
        else if (flag === 'B') options.always = true
        else if (flag === 'e') options.environment = true
        else if (flag === 'w') printDirectory = true
        else if (!'rRSqtpdj'.includes(flag))
          throw new CommandError("invalid option -- '" + flag + "'", 2)
      }
      continue
    }
    if (arg.startsWith('--')) continue
    const assignment = arg.match(/^([^=:\s]+)\s*(:=|::=|\+=|\?=|=)(.*)$/s)
    if (assignment) {
      assignments.push([assignment[1]!, assignment[2]!, assignment[3]!])
      continue
    }
    goals.push(arg)
  }
  const level = Number(ctx.env.MAKELEVEL ?? 0) || 0
  const state = new Make(ctx, dir, options, level)
  const show = printDirectory ?? level > 0
  const leave = () => {
    if (show) ctx.stdout.write(state.name + ": Leaving directory '" + dir + "'\n")
  }
  if (show) ctx.stdout.write(state.name + ": Entering directory '" + dir + "'\n")
  try {
    if (!(await ctx.fs.stat(dir)))
      throw new MakeError('*** ' + dir + ': No such file or directory.  Stop.')
    const set = (name: string, text: string) => state.set(name, text, false, 'default')
    set('MAKE', 'make')
    set('CURDIR', dir)
    set('SHELL', '/bin/sh')
    set('MAKEFLAGS', '')
    set('MAKECMDGOALS', goals.join(' '))
    set('MAKELEVEL', String(level))
    set('CC', 'cc')
    set('CXX', 'g++')
    set('RM', 'rm -f')
    set('AR', 'ar')
    for (const [name, op, text] of assignments)
      await state.assign(name, op === '+=' ? '=' : op, text, 'command line', false)
    if (files.length) for (const file of files) await state.load(file, file, false)
    else {
      let found = false
      for (const name of ['GNUmakefile', 'makefile', 'Makefile']) {
        if (await ctx.fs.stat(ctx.resolve(dir + '/' + name))) {
          await state.load(name, name, false)
          found = true
          break
        }
      }
      if (!found && !goals.length)
        throw new MakeError('*** No targets specified and no makefile found.  Stop.')
    }
    const configured = state.variables.get('.DEFAULT_GOAL')?.value
    const targets = goals.length
      ? goals
      : configured
        ? [await state.expand(configured)]
        : state.defaultGoal
          ? [state.defaultGoal]
          : []
    if (!targets.length) throw new MakeError('*** No targets.  Stop.')
    for (const goal of targets) {
      const ran = state.ran
      try {
        await state.build(goal)
      } catch (error) {
        if (error instanceof MakeError && options.keep && !error.message.includes('No rule')) {
          state.failed = true
          ctx.stderr.write(state.name + ': ' + error.message + '\n')
          continue
        }
        throw error
      }
      if (state.ran === ran && !state.failed) {
        const rule = state.rules.get(goal)
        const recipe =
          (rule?.recipe && rule.recipe.length) || (!rule && (await state.implicit(goal)))
        if (state.phony.has(goal) && !recipe)
          ctx.stdout.write(state.name + ": Nothing to be done for '" + goal + "'.\n")
        else if (!state.phony.has(goal))
          ctx.stdout.write(
            state.name +
              ': ' +
              (recipe
                ? "'" + goal + "' is up to date."
                : "Nothing to be done for '" + goal + "'.") +
              '\n',
          )
      }
    }
    if (state.failed) {
      ctx.stderr.write(state.name + ": Target '" + targets[0] + "' not remade because of errors.\n")
      leave()
      return 2
    }
  } catch (error) {
    if (error instanceof MakeError) {
      ctx.stderr.write(state.name + ': ' + error.message + '\n')
      leave()
      return error.status
    }
    throw error
  }
  leave()
  return 0
}

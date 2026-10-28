import type { AndOr, Assign, Command, Pipeline, Redirect, Script, Word } from './Syntax.ts'
import { forced, heredocs, newlines, sources, texts } from './Syntax.ts'

const RESERVED = new Set([
  '!',
  '[[',
  ']]',
  'case',
  'coproc',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
  '{',
  '}',
])

export function functionText(name: string, body: Command): string {
  const printer = new Printer(false)
  printer.out = (RESERVED.has(name) ? 'function ' : '') + name + ' () \n'
  printer.indentation = 4
  printer.inside++
  printer.out += '{ \n'
  const group = body.type === 'group' && !body.subshell
  if (group) printer.list(body.body)
  else printer.command(body)
  printer.flush('')
  printer.indentation = 0
  printer.inside--
  if (group && body.redirects.length) {
    printer.newline('} ')
    printer.redirects(body.redirects)
  } else printer.newline('}')
  return printer.out
}

export function wordText(word: Word): string {
  const source = sources.get(word)
  if (!source) return fallback(word)
  let text = ''
  let at = 0
  for (const edit of source.edits) {
    const start = edit.start - source.start
    if (start < at) continue
    text += source.text.slice(at, start)
    text += edit.body ? '$(' + comsub(edit.body) + ')' : quote(edit.value ?? '')
    at = edit.end - source.start
  }
  return (text + source.text.slice(at)).replaceAll('\\\n', '')
}

function comsub(body: Script): string {
  const printer = new Printer(true)
  printer.list(body)
  printer.flush('')
  return printer.out
}

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function fallback(word: Word): string {
  return word
    .map((part) => {
      if (part.type === 'text')
        return part.quoted
          ? part.value
            ? quote(part.value)
            : "''"
          : part.value.replace(/[\s'"\\$\x60;&|()<>*?[\]#~]/g, '\\$&')
      if (part.type === 'param') return '\${' + part.name + '}'
      if (part.type === 'command') return '$(' + comsub(part.body) + ')'
      if (part.type === 'arith') return '$((' + fallback(part.expr) + '))'
      if (part.type === 'tilde') return '~' + part.user
      return (part.output ? '>(' : '<(') + comsub(part.body) + ')'
    })
    .join('')
}

function assignText(assign: Assign): string {
  const index = texts.get(assign)
  let text =
    assign.name +
    (typeof index === 'string' ? index : assign.index ? '[' + wordText(assign.index) + ']' : '') +
    (assign.append ? '+=' : '=')
  if (assign.items)
    text +=
      '(' +
      assign.items
        .map((item, i) => {
          const key = assign.keys?.[i]
          return (key ? '[' + wordText(key) + ']=' : '') + wordText(item)
        })
        .join(' ') +
      ')'
  else if (assign.value) text += wordText(assign.value)
  return text
}

class Printer {
  out = ''
  indentation = 0
  skip = 0
  inside = 0
  connection = 0
  deferred: Redirect[] = []
  heredoc = false
  comsub: boolean

  constructor(comsub: boolean) {
    this.comsub = comsub
  }

  indent() {
    this.out += ' '.repeat(this.indentation)
  }

  lead() {
    if (this.skip) this.skip--
    else this.indent()
  }

  newline(text: string) {
    this.out += '\n'
    this.indent()
    this.out += text
  }

  semicolon() {
    const last = this.out[this.out.length - 1]
    if (last !== '&' && last !== '\n') this.out += ';'
  }

  flush(text: string) {
    const shown = text !== '' && (text[0] !== ';' || text.length > 1)
    if (shown) this.out += text
    if (!this.deferred.length) return
    this.bodies(this.deferred)
    if (shown) this.out += ' '
    this.deferred = []
  }

  bodies(list: Redirect[]) {
    this.out += '\n'
    for (const redirect of list) {
      const doc = heredocs.get(redirect)
      this.out += (doc?.body ?? '') + (doc?.delimiter ?? '') + '\n'
    }
    this.heredoc = true
  }

  list(script: Script) {
    const connection = script.length > 1 || script[script.length - 1]?.background === true
    if (connection) this.connection++
    script.forEach((item: AndOr, index) => {
      this.andOr(item)
      if (index > 0) this.flush('')
      const more = index < script.length - 1
      if (item.background) {
        this.flush(' &')
        if (more) {
          this.out += ' '
          this.skip++
        }
      } else if (more) {
        const separator = this.comsub && newlines.has(item) ? '\n' : ';'
        if (!this.deferred.length) {
          if (!this.heredoc) this.out += separator
          else this.heredoc = false
        } else this.flush(this.inside ? '' : ';')
        if (this.inside) this.out += '\n'
        else {
          if (separator === ';') this.out += ' '
          this.skip++
        }
      }
    })
    if (connection) {
      if (script.length === 1) this.flush('')
      this.connection--
    }
  }

  andOr(item: AndOr) {
    const connection = item.rest.length > 0
    if (connection) this.connection++
    this.pipeline(item.first)
    for (const next of item.rest) {
      this.flush(' ' + next.op + ' ')
      this.skip++
      this.pipeline(next.pipeline)
      this.flush('')
    }
    if (connection) this.connection--
  }

  pipeline(pipeline: Pipeline) {
    if (pipeline.negate) {
      this.lead()
      this.out += '! '
      this.skip++
    }
    const connection = pipeline.commands.length > 1
    if (connection) this.connection++
    pipeline.commands.forEach((command, index) => {
      if (index > 0) {
        this.flush(' |')
        this.out += ' '
        this.skip++
      }
      this.command(command)
      if (index > 0) this.flush('')
    })
    if (connection) this.connection--
  }

  loop(body: Script) {
    this.newline('do\n')
    this.indentation += 4
    this.list(body)
    this.flush('')
    this.semicolon()
    this.indentation -= 4
    this.newline('done')
  }

  conditional(clauses: (Command & { type: 'if' })['clauses'], otherwise: Script | undefined) {
    const [clause, ...rest] = clauses
    if (!clause) return
    this.out += 'if '
    this.skip++
    this.list(clause.cond)
    this.semicolon()
    this.out += ' then\n'
    this.indentation += 4
    this.list(clause.body)
    this.flush('')
    this.indentation -= 4
    if (rest.length || otherwise) {
      this.semicolon()
      this.newline('else\n')
      this.indentation += 4
      if (rest.length) {
        this.indent()
        this.conditional(rest, otherwise)
      } else if (otherwise) {
        this.list(otherwise)
        this.flush('')
      }
      this.indentation -= 4
    }
    this.semicolon()
    this.newline('fi')
  }

  command(command: Command) {
    this.lead()
    switch (command.type) {
      case 'simple': {
        const words = [
          ...command.assigns.map(assignText),
          ...command.words.map((word) => (Array.isArray(word) ? wordText(word) : assignText(word))),
        ]
        this.out += words.join(' ')
        if (command.redirects.length) {
          if (words.length) this.out += ' '
          this.redirects(command.redirects)
        }
        return
      }
      case 'for':
        this.out +=
          (command.select ? 'select ' : 'for ') +
          command.name +
          ' in ' +
          (command.items ? command.items.map(wordText).join(' ') : '"$@"') +
          ';'
        this.loop(command.body)
        break
      case 'cfor': {
        const parts = texts.get(command)
        const [init, cond, step] = (
          Array.isArray(parts) ? parts : [command.init, command.cond, command.step].map(wordText)
        ).map((part) => part.trim() || '1')
        this.out += 'for ((' + init + '; ' + cond + '; ' + step + '))'
        this.loop(command.body)
        break
      }
      case 'while':
        this.out += command.until ? 'until ' : 'while '
        this.skip++
        this.list(command.cond)
        this.flush('')
        this.semicolon()
        this.out += ' do\n'
        this.indentation += 4
        this.list(command.body)
        this.flush('')
        this.indentation -= 4
        this.semicolon()
        this.newline('done')
        break
      case 'if':
        this.conditional(command.clauses, command.otherwise)
        break
      case 'case':
        this.out += 'case ' + wordText(command.word) + ' in '
        this.indentation += 4
        for (const item of command.items) {
          this.newline('')
          this.out += item.patterns.map(wordText).join(' | ') + ')\n'
          this.indentation += 4
          this.list(item.body)
          this.indentation -= 4
          this.flush('')
          this.newline(item.next === 'fall' ? ';&' : item.next === 'test' ? ';;&' : ';;')
        }
        this.indentation -= 4
        this.newline('esac')
        break
      case 'coproc':
        this.out += 'coproc ' + (command.name === 'COPROC' ? '' : command.name + ' ')
        this.command(command.body)
        break
      case 'group':
        if (command.subshell) {
          this.out += '( '
          this.skip++
          this.list(command.body)
          this.flush('')
          this.out += ' )'
          break
        }
        this.out += '{ '
        if (!this.inside) this.skip++
        else {
          this.out += '\n'
          this.indentation += 4
        }
        this.list(command.body)
        this.flush('')
        if (this.inside) {
          this.out += '\n'
          this.indentation -= 4
          this.indent()
        } else {
          this.semicolon()
          this.out += ' '
        }
        this.out += '}'
        break
      case 'function': {
        this.out += 'function ' + command.name + ' () \n'
        this.indent()
        this.out += '{ \n'
        this.inside++
        this.indentation += 4
        const body = command.body
        const group = body.type === 'group' && !body.subshell
        if (group) this.list(body.body)
        else this.command(body)
        this.flush('')
        this.indentation -= 4
        this.inside--
        if (group && body.redirects.length) {
          this.newline('} ')
          this.redirects(body.redirects)
        } else this.newline('}')
        return
      }
      case 'arith': {
        const text = texts.get(command)
        this.out += '((' + (typeof text === 'string' ? text : wordText(command.expr)) + '))'
        break
      }
      case 'test':
        this.out +=
          '[[ ' +
          command.tokens
            .map((token) => ('op' in token ? token.op : wordText(token.word)))
            .join(' ') +
          ' ]]'
        break
    }
    if (command.redirects.length) {
      this.out += ' '
      this.redirects(command.redirects)
    }
  }

  redirects(list: Redirect[]) {
    this.heredoc = false
    const docs: Redirect[] = []
    list.forEach((redirect, index) => {
      const doc = heredocs.get(redirect)
      if (doc) {
        this.out +=
          (redirect.fd ? String(redirect.fd) : '') +
          '<<' +
          (doc.strip ? '-' : '') +
          (doc.quoted ? quote(doc.delimiter) : doc.delimiter)
        docs.push(redirect)
      } else this.out += redirectText(redirect)
      if (index < list.length - 1) this.out += ' '
    })
    if (!docs.length) return
    if (this.connection) this.deferred.push(...docs)
    else this.bodies(docs)
  }
}

function redirectText(redirect: Redirect): string {
  if (redirect.name !== undefined)
    return (
      '{' +
      redirect.name +
      '}' +
      redirectText({ fd: null, op: redirect.op, target: redirect.target }).replace(/^\d+/, '')
    )
  const target = wordText(redirect.target)
  const fd = redirect.fd
  switch (redirect.op) {
    case '<':
      return (fd !== null && fd !== 0 ? fd : '') + '< ' + target
    case '>':
      return (fd !== null && fd !== 1 ? fd : '') + (forced.has(redirect) ? '>| ' : '> ') + target
    case '>>':
      return (fd !== null && fd !== 1 ? fd : '') + '>> ' + target
    case '<>':
      return (fd !== null && fd !== 0 ? fd : '') + '<> ' + target
    case '<<<':
      return (fd !== null && fd !== 0 ? fd : '') + '<<< ' + target
    case '&>':
    case '&>>':
      return redirect.op + ' ' + target
    case '<&':
      return target === '-' ? (fd ?? 0) + '>&-' : (fd ?? 0) + '<&' + target
    case '>&':
      if (/^(\d+|-)$/.test(target)) return (fd ?? 1) + '>&' + target
      return (fd === null ? '' : fd) + '>&' + target
  }
  return (fd ?? '') + redirect.op + ' ' + target
}

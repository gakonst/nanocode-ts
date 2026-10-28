import * as Format from './internal/Format.ts'
import * as Workspace from './internal/Workspace.ts'
import * as LiveEvent from './LiveEvent.ts'

export type Body = 'text' | 'code' | 'diff'

export type Cell = {
  call_id: string
  tool: string
  name: string
  title: string
  input: string
  body: Body
  language: string
  output: string
  output_language: string
  status: Status
  started_at: number
  duration_ms?: number
  exit_code?: number
  images?: string[]
  details: string[]
  children: Cell[]
}

export type Status = 'running' | 'completed' | 'failed' | 'cancelled' | 'yielded'

const codeTools = new Set(['exec', 'code_mode', 'js'])

const imageUrl = /^(https?:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,])/i

const pragmaLine = /^\s*\/\/ @exec:[^\n]*(?:\n|$)/

export function clip(cell: Cell, options: clip.Options): Cell {
  const { limit, tail = false } = options
  const cut = (text: string) => {
    if (text.length <= limit) return text
    const dropped = `… ${text.length - limit} characters not kept`
    return tail ? `${dropped}\n${text.slice(-limit)}` : `${text.slice(0, limit)}\n${dropped}`
  }
  return {
    ...cell,
    input: cut(cell.input),
    output: cut(cell.output),
    details: [...cell.details],
    children: cell.children.map((child) => clip(child, options)),
  }
}

export declare namespace clip {
  type Options = {
    limit: number
    tail?: boolean | undefined
  }
}

export function create(options: create.Options): Cell {
  const { callId, startedAt = Date.now(), tool } = options
  return {
    call_id: callId,
    tool,
    name: tool,
    title: '',
    input: '',
    body: 'text',
    language: '',
    output: '',
    output_language: '',
    status: 'running',
    started_at: startedAt,
    details: [],
    children: [],
  }
}

export declare namespace create {
  type Options = {
    callId: string
    startedAt?: number | undefined
    tool: string
  }
}

function firstLine(text: string): { first: string; more: boolean } {
  const lines = text.trim().split('\n')
  return { first: lines[0] ?? '', more: lines.length > 1 }
}

function patchFiles(patch: string): string[] {
  return patch.split('\n').flatMap((line) => {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
    return match ? [match[1].trim()] : []
  })
}

function linesPatch(header: string, path: string, removed: string, added: string): string {
  const lines = [`*** ${header}: ${path}`]
  if (header === 'Update File') lines.push('@@')
  for (const line of removed ? removed.split('\n') : []) lines.push(`-${line}`)
  for (const line of added ? added.split('\n') : []) lines.push(`+${line}`)
  return lines.join('\n')
}

export function describe(cell: Cell, options: describe.Options): Cell {
  const value = Format.decode(options.args)
  const object =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const field = (key: string) =>
    typeof object[key] === 'string' ? (object[key] as string) : undefined
  const number = (key: string) =>
    typeof object[key] === 'number' || typeof object[key] === 'string'
      ? String(object[key])
      : undefined
  const command = (text: string) => {
    const { first, more } = firstLine(text)
    cell.name = 'run'
    cell.title = first
    cell.input = more ? text : ''
    cell.body = more ? 'code' : 'text'
    cell.language = more ? 'bash' : ''
  }
  cell.name = cell.tool
  cell.title = ''
  cell.input = ''
  cell.body = 'text'
  cell.language = ''
  cell.details = []
  if (codeTools.has(cell.tool)) {
    let source =
      typeof value === 'string'
        ? value
        : (field('code') ??
          field('source') ??
          field('input') ??
          (Object.keys(object).length ? JSON.stringify(object) : ''))
    const pragma = pragmaLine.exec(source)
    if (pragma) source = source.slice(pragma[0].length)
    cell.name = 'code'
    cell.input = source
    cell.body = 'code'
    cell.language = 'js'
    return cell
  }
  switch (cell.tool) {
    case 'wait': {
      cell.name = 'code'
      cell.title = `cell ${number('cell_id') ?? ''}${object.terminate === true ? ' · terminate' : ' · wait'}`
      break
    }
    case 'exec_command':
      command(field('cmd') ?? '')
      if (object.tty === true) cell.details.push('tty')
      break
    case 'Bash':
    case 'bash':
    case 'shell':
    case 'run_command':
      command(
        field('command') ??
          field('cmd') ??
          field('script') ??
          (typeof value === 'string' ? value : ''),
      )
      if (object.run_in_background === true) cell.details.push('background')
      break
    case 'write_stdin': {
      const chars = field('chars') ?? ''
      cell.name = chars ? 'stdin' : 'poll'
      cell.title = `session ${number('session_id') ?? ''}`
      cell.input = chars
      break
    }
    case 'apply_patch': {
      const patch = typeof value === 'string' ? value : (field('input') ?? field('patch') ?? '')
      cell.name = 'patch'
      cell.input = patch
      cell.title = patchFiles(patch).join(', ')
      cell.body = 'diff'
      break
    }
    case 'Edit':
    case 'edit_file': {
      const path = field('file_path') ?? field('path') ?? ''
      cell.name = 'edit'
      cell.title = path
      cell.input = linesPatch(
        'Update File',
        path,
        field('old_string') ?? '',
        field('new_string') ?? '',
      )
      cell.body = 'diff'
      if (object.replace_all === true) cell.details.push('all occurrences')
      break
    }
    case 'Write':
    case 'write_file': {
      const path = field('file_path') ?? field('path') ?? ''
      cell.name = 'write'
      cell.title = path
      cell.input = linesPatch('Add File', path, '', field('content') ?? '')
      cell.body = 'diff'
      break
    }
    case 'Read':
    case 'read_file':
      cell.name = 'read'
      cell.title = field('file_path') ?? field('path') ?? ''
      if (number('offset') || number('limit'))
        cell.details.push(
          [
            number('offset') && `from line ${number('offset')}`,
            number('limit') && `${number('limit')} lines`,
          ]
            .filter(Boolean)
            .join(', '),
        )
      break
    case 'Glob':
    case 'Grep':
      cell.name = cell.tool.toLowerCase()
      cell.title = [field('pattern'), field('path') && `in ${field('path')}`]
        .filter(Boolean)
        .join(' ')
      break
    case 'WebSearch':
    case 'web_search':
      cell.name = 'search'
      cell.title = field('query') ?? ''
      break
    case 'WebFetch':
    case 'fetch':
      cell.name = 'fetch'
      cell.title = field('url') ?? ''
      break
    case 'spawn_agent':
      cell.name = 'spawn agent'
      cell.title = field('role') ?? ''
      cell.input = field('task') ?? ''
      break
    default: {
      const strings = Object.entries(object).filter(([, entry]) => typeof entry === 'string') as [
        string,
        string,
      ][]
      const short = strings.find(([, entry]) => entry.length <= 80 && !entry.includes('\n'))
      if (typeof value === 'string') cell.input = value
      else if (Object.keys(object).length === 1 && strings.length === 1) {
        if (short) cell.title = short[1]
        else cell.input = strings[0][1]
      } else if (Object.keys(object).length) {
        if (short) cell.title = short[1]
        cell.input = JSON.stringify(object, null, 2)
        cell.body = 'code'
        cell.language = 'json'
      }
    }
  }
  return cell
}

export declare namespace describe {
  type Options = {
    args: unknown
  }
}

function textOf(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result))
    return result
      .map(textOf)
      .reduce(
        (text, part) =>
          !part ? text : !text || text.endsWith('\n') ? text + part : `${text}\n${part}`,
        '',
      )
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (Array.isArray(record.content_blocks)) return textOf(record.content_blocks)
    if (Array.isArray(record.content)) return textOf(record.content)
    if (Array.isArray(record.Content)) return textOf(record.Content)
    if (typeof record.Text === 'string') return record.Text
  }
  return ''
}

function imagesOf(result: unknown, found: string[] = []): string[] {
  if (Array.isArray(result)) {
    for (const item of result) imagesOf(item, found)
    return found
  }
  if (!result || typeof result !== 'object') return found
  const record = result as Record<string, unknown>
  const source =
    record.source && typeof record.source === 'object'
      ? (record.source as Record<string, unknown>)
      : undefined
  const nested =
    record.image_url && typeof record.image_url === 'object'
      ? (record.image_url as Record<string, unknown>).url
      : undefined
  const url =
    record.type === 'input_image' || record.type === 'image_url'
      ? typeof record.image_url === 'string'
        ? record.image_url
        : nested
      : record.type === 'image' && typeof record.data === 'string'
        ? `data:${typeof record.mimeType === 'string' ? record.mimeType : typeof record.mime_type === 'string' ? record.mime_type : 'image/png'};base64,${record.data}`
        : record.type === 'image' && source?.type === 'base64' && typeof source.data === 'string'
          ? `data:${typeof source.media_type === 'string' ? source.media_type : 'image/png'};base64,${source.data}`
          : record.type === 'image' && source?.type === 'url'
            ? source.url
            : undefined
  if (
    typeof url === 'string' &&
    (imageUrl.test(url.trim()) || Workspace.path(url)) &&
    !found.includes(url.trim())
  )
    found.push(url.trim())
  for (const key of ['content', 'content_blocks', 'Content', 'output'])
    if (Array.isArray(record[key])) imagesOf(record[key], found)
  return found
}

function humanize(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return text
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>
    if (!('stdout' in value) && !('stderr' in value)) return text
    const parts = ['stdout', 'stderr', 'output']
      .map((key) => value[key])
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .map((part) => part.trimEnd())
    if (typeof value.exit_code === 'number' && value.exit_code !== 0)
      parts.push(`exit code ${value.exit_code}`)
    return parts.join('\n')
  } catch {
    return text
  }
}

function codeStatus(header: string): Status | undefined {
  if (header === 'Script completed') return 'completed'
  if (header === 'Script failed') return 'failed'
  if (header === 'Script terminated') return 'cancelled'
  if (header.startsWith('Script running with cell ID ')) return 'yielded'
  return undefined
}

function stripCodeHeader(text: string): string {
  const lines = text.split('\n')
  if (!lines[0]?.startsWith('Script ')) return text
  let index = 1
  while (index < lines.length && /^(Wall time|Original token count|Chunk ID)\b/.test(lines[index]))
    index++
  if (lines[index] === 'Output:') index++
  return lines.slice(index).join('\n')
}

export function finish(cell: Cell, options: finish.Options): Cell {
  const { event } = options
  const raw = textOf(event.result)
  const structured =
    event.structured && typeof event.structured === 'object'
      ? (event.structured as Record<string, unknown>)
      : {}
  let status: Status =
    event.status === 'completed'
      ? 'completed'
      : event.status === 'cancelled'
        ? 'cancelled'
        : 'failed'
  if (typeof event.duration_ns === 'number') {
    if (event.duration_ns > 0) cell.duration_ms = event.duration_ns / 1e6
  } else if (cell.status === 'running') cell.duration_ms = LiveEvent.at(event) - cell.started_at
  if (codeTools.has(cell.tool) || cell.tool === 'wait') {
    const header = raw.split('\n', 1)[0] ?? ''
    status = codeStatus(header) ?? status
    const yielded = /^Script running with cell ID (\S+)/.exec(header)
    if (yielded && cell.tool !== 'wait') cell.title = `cell ${yielded[1]}`
    const output = humanize(stripCodeHeader(raw)).trimEnd()
    cell.output =
      status === 'cancelled' && cell.output && !output.includes(cell.output)
        ? `${cell.output}\n${output}`.trimEnd()
        : output
  } else if (cell.tool === 'exec_command' || cell.tool === 'write_stdin') {
    const [header, output] = raw.includes('Output:\n')
      ? raw.split(/Output:\n([\s\S]*)/, 2)
      : ['', raw]
    cell.output = (
      typeof structured.output === 'string' ? structured.output : (output ?? '')
    ).trimEnd()
    const code =
      typeof structured.exit_code === 'number'
        ? structured.exit_code
        : Number(/Process exited with code (-?\d+)/.exec(header ?? '')?.[1] ?? Number.NaN)
    if (Number.isFinite(code)) cell.exit_code = code
    const session = /Process running with session ID (\d+)/.exec(header ?? '')?.[1]
    if (session) cell.details.push(`session ${session} running`)
  } else {
    cell.output = (
      typeof structured.output === 'string' ? structured.output : humanize(raw)
    ).trimEnd()
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        if (typeof parsed.exit_code === 'number') cell.exit_code = parsed.exit_code
      } catch {}
    }
  }
  const images = imagesOf(event.structured, imagesOf(event.result))
  if (images.length) cell.images = images
  const output = cell.output.trim()
  cell.output_language =
    cell.output &&
    (output.startsWith('{') || output.startsWith('[')) &&
    (() => {
      try {
        JSON.parse(output)
        return true
      } catch {
        return false
      }
    })()
      ? 'json'
      : /^(diff --git|--- )/.test(cell.output)
        ? 'diff'
        : ''
  if (status === 'completed' && cell.exit_code !== undefined && cell.exit_code !== 0)
    cell.details.push(`exit ${cell.exit_code}`)
  cell.output = Format.plain(cell.output)
  cell.status = status
  return cell
}

export declare namespace finish {
  type Options = {
    event: LiveEvent.LiveEvent
  }
}

export function summary(cell: Cell): string {
  const head = [cell.name, cell.title].filter(Boolean).join(' ')
  const meta = [
    cell.status === 'completed' ? '' : cell.status,
    cell.duration_ms !== undefined ? Format.duration(cell.duration_ms) : '',
    ...cell.details,
  ]
    .filter(Boolean)
    .join(' · ')
  return meta ? `${head} · ${meta}` : head
}

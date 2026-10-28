import { CommandError, type CommandContext, type CommandHandler } from '../Shell.ts'

type Node = string | { bytes: Uint8Array } | Node[]

type ValType = number

type FuncType = { params: ValType[]; results: ValType[] }

type Func = {
  name?: string
  type: number
  locals: ValType[]
  names: Map<string, number>
  body: Node[]
  exports: string[]
}

type Label = string | undefined

const VALTYPES: Record<string, number> = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  v128: 0x7b,
  funcref: 0x70,
  externref: 0x6f,
}

const SIMPLE: Record<string, number[]> = {
  unreachable: [0x00],
  nop: [0x01],
  return: [0x0f],
  drop: [0x1a],
  select: [0x1b],
  'memory.size': [0x3f, 0x00],
  'memory.grow': [0x40, 0x00],
  current_memory: [0x3f, 0x00],
  grow_memory: [0x40, 0x00],
  'memory.copy': [0xfc, 0x0a, 0x00, 0x00],
  'memory.fill': [0xfc, 0x0b, 0x00],
}

const NUMERIC = [
  'i32.eqz i32.eq i32.ne i32.lt_s i32.lt_u i32.gt_s i32.gt_u i32.le_s i32.le_u i32.ge_s i32.ge_u',
  'i64.eqz i64.eq i64.ne i64.lt_s i64.lt_u i64.gt_s i64.gt_u i64.le_s i64.le_u i64.ge_s i64.ge_u',
  'f32.eq f32.ne f32.lt f32.gt f32.le f32.ge f64.eq f64.ne f64.lt f64.gt f64.le f64.ge',
  'i32.clz i32.ctz i32.popcnt i32.add i32.sub i32.mul i32.div_s i32.div_u i32.rem_s i32.rem_u i32.and i32.or i32.xor i32.shl i32.shr_s i32.shr_u i32.rotl i32.rotr',
  'i64.clz i64.ctz i64.popcnt i64.add i64.sub i64.mul i64.div_s i64.div_u i64.rem_s i64.rem_u i64.and i64.or i64.xor i64.shl i64.shr_s i64.shr_u i64.rotl i64.rotr',
  'f32.abs f32.neg f32.ceil f32.floor f32.trunc f32.nearest f32.sqrt f32.add f32.sub f32.mul f32.div f32.min f32.max f32.copysign',
  'f64.abs f64.neg f64.ceil f64.floor f64.trunc f64.nearest f64.sqrt f64.add f64.sub f64.mul f64.div f64.min f64.max f64.copysign',
  'i32.wrap_i64 i32.trunc_f32_s i32.trunc_f32_u i32.trunc_f64_s i32.trunc_f64_u i64.extend_i32_s i64.extend_i32_u i64.trunc_f32_s i64.trunc_f32_u i64.trunc_f64_s i64.trunc_f64_u',
  'f32.convert_i32_s f32.convert_i32_u f32.convert_i64_s f32.convert_i64_u f32.demote_f64 f64.convert_i32_s f64.convert_i32_u f64.convert_i64_s f64.convert_i64_u f64.promote_f32',
  'i32.reinterpret_f32 i64.reinterpret_f64 f32.reinterpret_i32 f64.reinterpret_i64 i32.extend8_s i32.extend16_s i64.extend8_s i64.extend16_s i64.extend32_s',
]
  .join(' ')
  .split(' ')

for (const [index, name] of NUMERIC.entries()) SIMPLE[name] = [0x45 + index]

const MEMORY: Record<string, [number, number]> = {
  'i32.load': [0x28, 2],
  'i64.load': [0x29, 3],
  'f32.load': [0x2a, 2],
  'f64.load': [0x2b, 3],
  'i32.load8_s': [0x2c, 0],
  'i32.load8_u': [0x2d, 0],
  'i32.load16_s': [0x2e, 1],
  'i32.load16_u': [0x2f, 1],
  'i64.load8_s': [0x30, 0],
  'i64.load8_u': [0x31, 0],
  'i64.load16_s': [0x32, 1],
  'i64.load16_u': [0x33, 1],
  'i64.load32_s': [0x34, 2],
  'i64.load32_u': [0x35, 2],
  'i32.store': [0x36, 2],
  'i64.store': [0x37, 3],
  'f32.store': [0x38, 2],
  'f64.store': [0x39, 3],
  'i32.store8': [0x3a, 0],
  'i32.store16': [0x3b, 1],
  'i64.store8': [0x3c, 0],
  'i64.store16': [0x3d, 1],
  'i64.store32': [0x3e, 2],
}

const ALIASES: Record<string, string> = {
  get_local: 'local.get',
  set_local: 'local.set',
  tee_local: 'local.tee',
  get_global: 'global.get',
  set_global: 'global.set',
  'i32.wrap/i64': 'i32.wrap_i64',
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "'": 39, '\\': 92 }

function fail(message: string): never {
  throw new CommandError('wat2wasm: ' + message, 1)
}

function tokenize(text: string): Node[] {
  const encoder = new TextEncoder()
  const stack: Node[][] = [[]]
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (/\s/.test(char)) {
      index++
      continue
    }
    if (text.startsWith(';;', index)) {
      const end = text.indexOf('\n', index)
      index = end < 0 ? text.length : end + 1
      continue
    }
    if (text.startsWith('(;', index)) {
      const end = text.indexOf(';)', index + 2)
      if (end < 0) fail('unterminated block comment')
      index = end + 2
      continue
    }
    if (char === '(') {
      const list: Node[] = []
      stack[stack.length - 1]!.push(list)
      stack.push(list)
      index++
      continue
    }
    if (char === ')') {
      if (stack.length < 2) fail('unexpected )')
      stack.pop()
      index++
      continue
    }
    if (char === '"') {
      const bytes: number[] = []
      index++
      for (;;) {
        if (index >= text.length) fail('unterminated string')
        const next = text[index]!
        if (next === '"') {
          index++
          break
        }
        if (next !== '\\') {
          const end = text.slice(index).search(/["\\]/)
          const chunk = end < 0 ? text.slice(index) : text.slice(index, index + end)
          bytes.push(...encoder.encode(chunk))
          index += chunk.length
          continue
        }
        const escape = text[index + 1] ?? ''
        if (escape in ESCAPES) {
          bytes.push(ESCAPES[escape]!)
          index += 2
        } else if (escape === 'u') {
          const end = text.indexOf('}', index)
          bytes.push(
            ...encoder.encode(
              String.fromCodePoint(Number.parseInt(text.slice(index + 3, end), 16)),
            ),
          )
          index = end + 1
        } else if (/^[0-9a-fA-F]{2}$/.test(text.slice(index + 1, index + 3))) {
          bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16))
          index += 3
        } else fail('bad string escape \\' + escape)
      }
      stack[stack.length - 1]!.push({ bytes: new Uint8Array(bytes) })
      continue
    }
    const match = /^[^\s()";]+/.exec(text.slice(index))
    if (!match) fail('unexpected ' + JSON.stringify(char))
    stack[stack.length - 1]!.push(match[0])
    index += match[0].length
  }
  if (stack.length !== 1) fail('missing )')
  return stack[0]!
}

function unsigned(value: number | bigint): number[] {
  let rest = BigInt(value)
  const out: number[] = []
  do {
    let byte = Number(rest & 0x7fn)
    rest >>= 7n
    if (rest !== 0n) byte |= 0x80
    out.push(byte)
  } while (rest !== 0n)
  return out
}

function signed(value: number | bigint): number[] {
  let rest = BigInt(value)
  const out: number[] = []
  for (;;) {
    const byte = Number(rest & 0x7fn)
    rest >>= 7n
    const done = (rest === 0n && (byte & 0x40) === 0) || (rest === -1n && (byte & 0x40) !== 0)
    out.push(done ? byte : byte | 0x80)
    if (done) return out
  }
}

function integer(atom: Node, bits: 32 | 64): bigint {
  if (typeof atom !== 'string') fail('expected a number')
  const clean = atom.replace(/_/g, '')
  const negative = clean.startsWith('-')
  const body = clean.replace(/^[+-]/, '')
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(body)) fail('not an integer: ' + atom)
  let value = BigInt(body)
  if (negative) value = -value
  const limit = 1n << BigInt(bits)
  if (value >= limit || value < -(limit >> 1n)) fail('integer out of range: ' + atom)
  if (value >= limit >> 1n) value -= limit
  return value
}

function float(atom: Node, bits: 32 | 64): number[] {
  if (typeof atom !== 'string') fail('expected a float')
  const clean = atom.replace(/_/g, '')
  const negative = clean.startsWith('-')
  const body = clean.replace(/^[+-]/, '')
  const value =
    body === 'inf'
      ? Infinity
      : body.startsWith('nan')
        ? Number.NaN
        : /^0x/i.test(body)
          ? hexFloat(body)
          : Number(body)
  if (Number.isNaN(value) && !body.startsWith('nan')) fail('not a float: ' + atom)
  const buffer = new DataView(new ArrayBuffer(bits / 8))
  if (bits === 32) buffer.setFloat32(0, negative ? -value : value, true)
  else buffer.setFloat64(0, negative ? -value : value, true)
  return [...new Uint8Array(buffer.buffer)]
}

function hexFloat(body: string): number {
  const match = /^0x([0-9a-f]*)(?:\.([0-9a-f]*))?(?:p([+-]?\d+))?$/i.exec(body)
  if (!match) return Number.NaN
  const whole = match[1] ? Number.parseInt(match[1], 16) : 0
  const fraction = match[2] ? Number.parseInt(match[2], 16) / 16 ** match[2].length : 0
  return (whole + fraction) * 2 ** Number(match[3] ?? 0)
}

function vector(items: number[][]): number[] {
  return [...unsigned(items.length), ...items.flat()]
}

function name(bytes: Uint8Array | string): number[] {
  const encoded = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  return [...unsigned(encoded.length), ...encoded]
}

function head(node: Node): string | undefined {
  return Array.isArray(node) && typeof node[0] === 'string' ? node[0] : undefined
}

function text(node: Node | undefined): string {
  if (!node || typeof node === 'string' || Array.isArray(node)) fail('expected a string')
  return new TextDecoder().decode(node.bytes)
}

function valtype(atom: Node | undefined): ValType {
  const value = typeof atom === 'string' ? VALTYPES[atom] : undefined
  if (value === undefined) fail('unknown value type ' + JSON.stringify(atom))
  return value
}

export function wat2wasm(source: string): Uint8Array {
  let fields = tokenize(source)
  if (fields.length === 1 && head(fields[0]!) === 'module')
    fields = (fields[0] as Node[])
      .slice(1)
      .filter((field) => typeof field !== 'string' || !field.startsWith('$'))
  const types: FuncType[] = []
  const typeNames = new Map<string, number>()
  const funcNames = new Map<string, number>()
  const globalNames = new Map<string, number>()
  const memoryNames = new Map<string, number>()
  const imports: number[][] = []
  const funcs: Func[] = []
  const globals: number[][] = []
  const exports: number[][] = []
  const datas: number[][] = []
  const elems: number[][] = []
  let tables: number[][] = []
  let memories: number[][] = []
  let start: number | undefined
  let importedFuncs = 0
  let importedGlobals = 0
  const signature = (params: ValType[], results: ValType[]) => {
    const key = params.join(',') + ':' + results.join(',')
    const found = types.findIndex(
      (type) => type.params.join(',') + ':' + type.results.join(',') === key,
    )
    if (found >= 0) return found
    types.push({ params, results })
    return types.length - 1
  }
  const typeUse = (items: Node[], names?: Map<string, number>) => {
    let explicit: number | undefined
    const params: ValType[] = []
    const results: ValType[] = []
    let rest = 0
    for (const item of items) {
      const kind = head(item)
      if (kind === 'type') {
        const ref = (item as Node[])[1]
        explicit =
          typeof ref === 'string' && ref.startsWith('$')
            ? (typeNames.get(ref) ?? fail('unknown type ' + ref))
            : Number(integer(ref ?? '', 32))
      } else if (kind === 'param') {
        const parts = (item as Node[]).slice(1)
        if (typeof parts[0] === 'string' && parts[0].startsWith('$')) {
          names?.set(parts[0], params.length)
          params.push(valtype(parts[1]))
        } else for (const part of parts) params.push(valtype(part))
      } else if (kind === 'result')
        for (const part of (item as Node[]).slice(1)) results.push(valtype(part))
      else break
      rest++
    }
    const type = explicit ?? signature(params, results)
    return {
      type,
      rest,
      params: explicit !== undefined && !params.length ? (types[explicit]?.params ?? []) : params,
    }
  }
  const exportsOf = (items: Node[]) => {
    const found: string[] = []
    let index = 0
    while (head(items[index] ?? '') === 'export') found.push(text((items[index++] as Node[])[1]))
    return { found, rest: index }
  }
  const limits = (items: Node[]) => {
    const numbers = items
      .filter((item) => typeof item === 'string' && /^[0-9]/.test(item))
      .map((item) => Number(integer(item, 64)))
    if (!numbers.length) fail('limits need a minimum')
    return numbers.length > 1
      ? [0x01, ...unsigned(numbers[0]!), ...unsigned(numbers[1]!)]
      : [0x00, ...unsigned(numbers[0]!)]
  }
  for (const field of fields) {
    const kind = head(field)
    const items = Array.isArray(field) ? field.slice(1) : []
    if (kind === 'type') {
      const label =
        typeof items[0] === 'string' && items[0].startsWith('$')
          ? (items.shift() as string)
          : undefined
      const func = items[0] as Node[] | undefined
      if (head(func ?? '') !== 'func') fail('type must be (func ...)')
      const params: ValType[] = []
      const results: ValType[] = []
      for (const item of func!.slice(1)) {
        const parts = (item as Node[]).slice(1)
        if (head(item) === 'param')
          for (const part of parts) {
            if (typeof part === 'string' && part.startsWith('$')) continue
            params.push(valtype(part))
          }
        else if (head(item) === 'result') for (const part of parts) results.push(valtype(part))
      }
      types.push({ params, results })
      if (label) typeNames.set(label, types.length - 1)
    }
  }
  for (const field of fields) {
    const kind = head(field)
    const items = Array.isArray(field) ? field.slice(1) : []
    if (kind === 'import') {
      const module = text(items[0])
      const field_ = text(items[1])
      const description = items[2] as Node[]
      const what = head(description)
      const parts = description.slice(1)
      const label =
        typeof parts[0] === 'string' && parts[0].startsWith('$')
          ? (parts.shift() as string)
          : undefined
      if (what === 'func') {
        if (label) funcNames.set(label, importedFuncs)
        importedFuncs++
        imports.push([...name(module), ...name(field_), 0x00, ...unsigned(typeUse(parts).type)])
      } else if (what === 'memory') {
        if (label) memoryNames.set(label, 0)
        imports.push([...name(module), ...name(field_), 0x02, ...limits(parts)])
      } else if (what === 'global') {
        if (label) globalNames.set(label, importedGlobals)
        importedGlobals++
        const type = parts[0]!
        imports.push([
          ...name(module),
          ...name(field_),
          0x03,
          ...(head(type) === 'mut' ? [valtype((type as Node[])[1]), 1] : [valtype(type), 0]),
        ])
      } else fail('unsupported import kind ' + what)
    } else if (kind === 'func') {
      const label =
        typeof items[0] === 'string' && items[0].startsWith('$')
          ? (items.shift() as string)
          : undefined
      const inline = head(items[0] ?? '') === 'import' ? (items.shift() as Node[]) : undefined
      const { found, rest } = exportsOf(items)
      const afterExports = items.slice(rest)
      const inlineImport =
        head(afterExports[0] ?? '') === 'import' ? (afterExports.shift() as Node[]) : inline
      if (inlineImport) {
        if (label) funcNames.set(label, importedFuncs)
        for (const exported of found)
          exports.push([...name(exported), 0x00, ...unsigned(importedFuncs)])
        importedFuncs++
        imports.push([
          ...name(text(inlineImport[1])),
          ...name(text(inlineImport[2])),
          0x00,
          ...unsigned(typeUse(afterExports).type),
        ])
        continue
      }
      const names = new Map<string, number>()
      const use = typeUse(afterExports, names)
      const body = afterExports.slice(use.rest)
      const locals: ValType[] = []
      while (head(body[0] ?? '') === 'local') {
        const parts = (body.shift() as Node[]).slice(1)
        if (typeof parts[0] === 'string' && parts[0].startsWith('$')) {
          names.set(parts[0], use.params.length + locals.length)
          locals.push(valtype(parts[1]))
        } else for (const part of parts) locals.push(valtype(part))
      }
      funcs.push({
        ...(label ? { name: label } : {}),
        type: use.type,
        locals,
        names,
        body,
        exports: found,
      })
    }
  }
  for (const [index, func] of funcs.entries()) {
    if (func.name) funcNames.set(func.name, importedFuncs + index)
    for (const exported of func.exports)
      exports.push([...name(exported), 0x00, ...unsigned(importedFuncs + index)])
  }
  const funcIndex = (ref: Node | undefined) =>
    typeof ref === 'string' && ref.startsWith('$')
      ? (funcNames.get(ref) ?? fail('unknown function ' + ref))
      : Number(integer(ref ?? '', 32))
  const globalIndex = (ref: Node | undefined) =>
    typeof ref === 'string' && ref.startsWith('$')
      ? (globalNames.get(ref) ?? fail('unknown global ' + ref))
      : Number(integer(ref ?? '', 32))
  const constant = (expr: Node): number[] => {
    const parts = Array.isArray(expr) ? expr : [expr]
    const op = parts[0]
    if (op === 'offset') return constant(parts[1]!)
    if (op === 'i32.const') return [0x41, ...signed(integer(parts[1]!, 32))]
    if (op === 'i64.const') return [0x42, ...signed(integer(parts[1]!, 64))]
    if (op === 'f32.const') return [0x43, ...float(parts[1]!, 32)]
    if (op === 'f64.const') return [0x44, ...float(parts[1]!, 64)]
    if (op === 'global.get') return [0x23, ...unsigned(globalIndex(parts[1]))]
    fail('unsupported constant expression ' + JSON.stringify(op))
  }
  for (const field of fields) {
    const kind = head(field)
    const items = Array.isArray(field) ? field.slice(1) : []
    const label =
      typeof items[0] === 'string' && items[0].startsWith('$')
        ? (items.shift() as string)
        : undefined
    if (kind === 'memory') {
      if (label) memoryNames.set(label, 0)
      const { found, rest } = exportsOf(items)
      for (const exported of found) exports.push([...name(exported), 0x02, 0x00])
      const parts = items.slice(rest)
      const data = parts.find((part) => head(part) === 'data') as Node[] | undefined
      if (data) {
        const bytes = data
          .slice(1)
          .flatMap((part) =>
            typeof part === 'object' && !Array.isArray(part) ? [...part.bytes] : [],
          )
        const pages = Math.max(1, Math.ceil(bytes.length / 65536))
        memories = [[0x01, ...unsigned(pages), ...unsigned(pages)]]
        datas.push([0x00, 0x41, 0x00, 0x0b, ...vector(bytes.map((byte) => [byte]))])
      } else memories = [limits(parts)]
    } else if (kind === 'global') {
      if (label) globalNames.set(label, importedGlobals + globals.length)
      const { found, rest } = exportsOf(items)
      for (const exported of found)
        exports.push([...name(exported), 0x03, ...unsigned(importedGlobals + globals.length)])
      const parts = items.slice(rest)
      const type = parts[0]!
      globals.push([
        ...(head(type) === 'mut' ? [valtype((type as Node[])[1]), 1] : [valtype(type), 0]),
        ...constant(parts[1]!),
        0x0b,
      ])
    } else if (kind === 'table') {
      const { found, rest } = exportsOf(items)
      for (const exported of found) exports.push([...name(exported), 0x01, 0x00])
      const parts = items.slice(rest)
      const element = parts.find((part) => head(part) === 'elem') as Node[] | undefined
      if (element) {
        const refs = element.slice(1).map(funcIndex)
        tables = [[0x70, 0x01, ...unsigned(refs.length), ...unsigned(refs.length)]]
        elems.push([0x00, 0x41, 0x00, 0x0b, ...vector(refs.map((ref) => unsigned(ref)))])
      } else
        tables = [
          [0x70, ...limits(parts.filter((part) => part !== 'funcref' && part !== 'anyfunc'))],
        ]
    } else if (kind === 'elem') {
      const offset = Array.isArray(items[0]) ? items.shift()! : ['i32.const', '0']
      const refs = items.filter((item) => item !== 'func').map(funcIndex)
      elems.push([0x00, ...constant(offset), 0x0b, ...vector(refs.map((ref) => unsigned(ref)))])
    } else if (kind === 'data') {
      if (head(items[0] ?? '') === 'memory') items.shift()
      const offset = Array.isArray(items[0]) ? items.shift()! : ['i32.const', '0']
      const bytes = items.flatMap((part) =>
        typeof part === 'object' && !Array.isArray(part) ? [...part.bytes] : [],
      )
      datas.push([0x00, ...constant(offset), 0x0b, ...vector(bytes.map((byte) => [byte]))])
    } else if (kind === 'export') {
      const exported = text(label === undefined ? items[0] : items[0])
      const target = items[1] as Node[]
      const what = head(target)
      const ref = target[1]
      if (what === 'func') exports.push([...name(exported), 0x00, ...unsigned(funcIndex(ref))])
      else if (what === 'memory') exports.push([...name(exported), 0x02, 0x00])
      else if (what === 'global')
        exports.push([...name(exported), 0x03, ...unsigned(globalIndex(ref))])
      else if (what === 'table') exports.push([...name(exported), 0x01, 0x00])
      else fail('unsupported export kind ' + what)
    } else if (kind === 'start') start = funcIndex(items[0] ?? label)
    else if (kind !== 'type' && kind !== 'import' && kind !== 'func')
      fail('unsupported module field ' + JSON.stringify(kind ?? field))
  }
  const code = funcs.map((func) => {
    const out: number[] = []
    const labels: Label[] = []
    const local = (ref: Node | undefined) =>
      typeof ref === 'string' && ref.startsWith('$')
        ? (func.names.get(ref) ?? fail('unknown local ' + ref))
        : Number(integer(ref ?? '', 32))
    const depth = (ref: Node | undefined) => {
      if (typeof ref === 'string' && ref.startsWith('$')) {
        const found = labels.lastIndexOf(ref)
        if (found < 0) fail('unknown label ' + ref)
        return labels.length - 1 - found
      }
      return Number(integer(ref ?? '', 32))
    }
    const blockType = (items: Node[], at: number) => {
      let index = at
      const label =
        typeof items[index] === 'string' && (items[index] as string).startsWith('$')
          ? (items[index++] as string)
          : undefined
      const params: ValType[] = []
      const results: ValType[] = []
      let explicit: number | undefined
      while (
        Array.isArray(items[index]) &&
        ['result', 'param', 'type'].includes(head(items[index]!) ?? '')
      ) {
        const item = items[index++] as Node[]
        if (head(item) === 'type')
          explicit =
            typeof item[1] === 'string' && item[1].startsWith('$')
              ? (typeNames.get(item[1]) ?? fail('unknown type ' + item[1]))
              : Number(integer(item[1] ?? '', 32))
        else
          for (const part of item.slice(1))
            (head(item) === 'result' ? results : params).push(valtype(part))
      }
      const encoded =
        explicit !== undefined
          ? signed(explicit)
          : !params.length && !results.length
            ? [0x40]
            : !params.length && results.length === 1
              ? [results[0]!]
              : signed(signature(params, results))
      return { label, encoded, next: index }
    }
    const immediates = (op: string, items: Node[], at: number): number => {
      let index = at
      const take = () => items[index++]
      if (op in SIMPLE) {
        out.push(...SIMPLE[op]!)
        return index
      }
      if (op in MEMORY) {
        const [opcode, natural] = MEMORY[op]!
        let offset = 0
        let align = natural
        while (
          typeof items[index] === 'string' &&
          /^(offset|align)=/.test(items[index] as string)
        ) {
          const [key, value] = (take() as string).split('=')
          if (key === 'offset') offset = Number(integer(value ?? '', 64))
          else align = Math.log2(Number(value))
        }
        out.push(opcode, ...unsigned(align), ...unsigned(offset))
        return index
      }
      switch (op) {
        case 'i32.const':
          out.push(0x41, ...signed(integer(take()!, 32)))
          return index
        case 'i64.const':
          out.push(0x42, ...signed(integer(take()!, 64)))
          return index
        case 'f32.const':
          out.push(0x43, ...float(take()!, 32))
          return index
        case 'f64.const':
          out.push(0x44, ...float(take()!, 64))
          return index
        case 'local.get':
          out.push(0x20, ...unsigned(local(take())))
          return index
        case 'local.set':
          out.push(0x21, ...unsigned(local(take())))
          return index
        case 'local.tee':
          out.push(0x22, ...unsigned(local(take())))
          return index
        case 'global.get':
          out.push(0x23, ...unsigned(globalIndex(take())))
          return index
        case 'global.set':
          out.push(0x24, ...unsigned(globalIndex(take())))
          return index
        case 'call':
          out.push(0x10, ...unsigned(funcIndex(take())))
          return index
        case 'call_indirect': {
          const use = [] as Node[]
          while (
            Array.isArray(items[index]) &&
            ['type', 'param', 'result'].includes(head(items[index]!) ?? '')
          )
            use.push(take()!)
          out.push(0x11, ...unsigned(typeUse(use).type), 0x00)
          return index
        }
        case 'br':
          out.push(0x0c, ...unsigned(depth(take())))
          return index
        case 'br_if':
          out.push(0x0d, ...unsigned(depth(take())))
          return index
        case 'br_table': {
          const targets: number[] = []
          while (
            typeof items[index] === 'string' &&
            (/^\$/.test(items[index] as string) || /^[0-9]/.test(items[index] as string))
          )
            targets.push(depth(take()))
          const fallback = targets.pop()
          if (fallback === undefined) fail('br_table needs a default label')
          out.push(
            0x0e,
            ...vector(targets.map((target) => unsigned(target))),
            ...unsigned(fallback),
          )
          return index
        }
        default:
          fail('unknown instruction ' + op)
      }
    }
    const flat = (items: Node[]) => {
      let index = 0
      while (index < items.length) {
        const item = items[index]!
        if (Array.isArray(item)) {
          folded(item)
          index++
          continue
        }
        if (typeof item !== 'string') fail('unexpected string in function body')
        const op = ALIASES[item] ?? item
        index++
        if (op === 'block' || op === 'loop' || op === 'if') {
          const type = blockType(items, index)
          index = type.next
          labels.push(type.label)
          out.push(op === 'block' ? 0x02 : op === 'loop' ? 0x03 : 0x04, ...type.encoded)
        } else if (op === 'else') {
          out.push(0x05)
          if (typeof items[index] === 'string' && (items[index] as string).startsWith('$')) index++
        } else if (op === 'end') {
          labels.pop()
          out.push(0x0b)
          if (typeof items[index] === 'string' && (items[index] as string).startsWith('$')) index++
        } else index = immediates(op, items, index)
      }
    }
    const folded = (node: Node[]) => {
      const op = ALIASES[head(node) ?? ''] ?? head(node)
      if (!op) fail('expected an instruction')
      if (op === 'block' || op === 'loop') {
        const type = blockType(node, 1)
        labels.push(type.label)
        out.push(op === 'block' ? 0x02 : 0x03, ...type.encoded)
        flat(node.slice(type.next))
        labels.pop()
        out.push(0x0b)
        return
      }
      if (op === 'if') {
        const type = blockType(node, 1)
        let rest = node.slice(type.next)
        const conditions = rest.filter((part) => head(part) !== 'then' && head(part) !== 'else')
        for (const condition of conditions) folded(condition as Node[])
        rest = rest.filter((part) => head(part) === 'then' || head(part) === 'else')
        labels.push(type.label)
        out.push(0x04, ...type.encoded)
        for (const part of rest) {
          if (head(part) === 'else') out.push(0x05)
          flat((part as Node[]).slice(1))
        }
        labels.pop()
        out.push(0x0b)
        return
      }
      const atoms: Node[] = [op]
      let index = 1
      while (
        index < node.length &&
        (!Array.isArray(node[index]) ||
          ['type', 'param', 'result'].includes(head(node[index]!) ?? ''))
      )
        atoms.push(node[index++]!)
      for (const child of node.slice(index)) folded(child as Node[])
      immediates(op, atoms, 1)
    }
    flat(func.body)
    const groups: number[][] = []
    for (const type of func.locals) {
      const last = groups[groups.length - 1]
      if (last && last[1] === type) last[0]!++
      else groups.push([1, type])
    }
    const body = [
      ...vector(groups.map(([count, type]) => [...unsigned(count!), type!])),
      ...out,
      0x0b,
    ]
    return [...unsigned(body.length), ...body]
  })
  const section = (id: number, payload: number[]) =>
    payload.length ? [id, ...unsigned(payload.length), ...payload] : []
  const bytes = [
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...(types.length
      ? section(
          1,
          vector(
            types.map((type) => [
              0x60,
              ...vector(type.params.map((value) => [value])),
              ...vector(type.results.map((value) => [value])),
            ]),
          ),
        )
      : []),
    ...(imports.length ? section(2, vector(imports)) : []),
    ...(funcs.length ? section(3, vector(funcs.map((func) => unsigned(func.type)))) : []),
    ...(tables.length ? section(4, vector(tables)) : []),
    ...(memories.length ? section(5, vector(memories)) : []),
    ...(globals.length ? section(6, vector(globals)) : []),
    ...(exports.length ? section(7, vector(exports)) : []),
    ...(start !== undefined ? section(8, unsigned(start)) : []),
    ...(elems.length ? section(9, vector(elems)) : []),
    ...(funcs.length ? section(10, vector(code)) : []),
    ...(datas.length ? section(11, vector(datas)) : []),
  ]
  return new Uint8Array(bytes)
}

export const wat: CommandHandler = async (ctx: CommandContext) => {
  let input: string | undefined
  let output: string | undefined
  for (let index = 0; index < ctx.args.length; index++) {
    const arg = ctx.args[index]!
    if (arg === '-o' || arg === '--output') output = ctx.args[++index]
    else if (arg.startsWith('--output=')) output = arg.slice(9)
    else if (arg === '-h' || arg === '--help') {
      ctx.stdout.write(
        "usage: wat2wasm FILE.wat [-o FILE.wasm]\nAssembles WebAssembly text (flat or folded instructions, MVP opcodes, memory, data, globals, tables, imports such as WASI's) into a binary module.\n",
      )
      return 0
    } else if (arg.startsWith('-') && arg !== '-') continue
    else input = arg
  }
  if (input === undefined) throw new CommandError('usage: wat2wasm FILE.wat [-o FILE.wasm]', 2)
  const source =
    input === '-'
      ? await ctx.stdin.text()
      : new TextDecoder().decode(await ctx.fs.read(ctx.resolve(input)))
  const bytes = wat2wasm(source)
  const validate = (globalThis as { WebAssembly?: { validate?(bytes: Uint8Array): boolean } })
    .WebAssembly?.validate
  let valid = true
  try {
    if (validate) valid = validate(bytes)
  } catch {}
  if (!valid)
    ctx.stderr.write(
      'wat2wasm: warning: the assembled module does not validate; check operand types and stack balance\n',
    )
  const target = output ?? (input === '-' ? 'out.wasm' : input.replace(/\.wat$/, '') + '.wasm')
  if (target === '-') ctx.stdout.write(String.fromCharCode(...bytes))
  else await ctx.fs.write(ctx.resolve(target), bytes)
  return valid ? 0 : 1
}

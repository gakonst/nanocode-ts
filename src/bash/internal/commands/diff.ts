import { CommandError, type CommandContext, type CommandHandler } from '../Shell.ts'
import { baseOf, byteLength, decode, encode } from '../Fs.ts'
import { globRegExp, posixRegExp } from '../Text.ts'
import { device } from './util.ts'

type Style = 'normal' | 'context' | 'unified' | 'ed' | 'forward' | 'rcs' | 'sdiff'

type Settings = {
  style: Style
  context: number
  horizon: number
  minimal: boolean
  heuristic: boolean
  ignoreCase: boolean
  white: number
  blank: boolean
  ignore: RegExp[]
  functions: RegExp[]
  text: boolean
  brief: boolean
  newFile: boolean
  unidirectional: boolean
  recursive: boolean
  report: boolean
  expandTabs: boolean
  initialTab: boolean
  suppressBlankEmpty: boolean
  suppressCommon: boolean
  leftColumn: boolean
  stripCr: boolean
  tabsize: number
  half: number
  column2: number
  labels: (string | undefined)[]
  excludes: RegExp[]
  start: string | undefined
  switches: string
}

type Change = { line0: number; line1: number; deleted: number; inserted: number; ignore: boolean }

type Lines = { lines: string[]; complete: boolean }

type Hunk = { first0: number; last0: number; first1: number; last1: number; kind: number }

type Context = {
  xv: Int32Array
  yv: Int32Array
  fd: Int32Array
  bd: Int32Array
  offset: number
  heuristic: boolean
  tooExpensive: number
  changed0: Uint8Array
  changed1: Uint8Array
  real0: Int32Array
  real1: Int32Array
}

type Partition = { xmid: number; ymid: number; lo: boolean; hi: boolean }

type Side = {
  name: string
  path: string
  state: 'unopened' | 'missing' | 'stdin' | 'error'
  kind: 'file' | 'directory' | 'device' | 'symlink'
  size: number
  mode: number
  mtime: number
}

const TABS = 1
const TRAILING = 2
const CHANGE = 4
const ALL = 5
const OLD = 1
const NEW = 2
const SNAKE = 20
const FAR = 0x7fffffff
const BLOCK = 4096
const TRY = "\ndiff: Try 'diff --help' for more information."
const NO_NEWLINE = '\\ No newline at end of file\n'

const VERSION =
  'diff (GNU diffutils) 3.10\n' +
  'Copyright (C) 2023 Free Software Foundation, Inc.\n' +
  'License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n' +
  'This is free software: you are free to change and redistribute it.\n' +
  'There is NO WARRANTY, to the extent permitted by law.\n\n' +
  'Written by Paul Eggert, Mike Haertel, David Hayes,\n' +
  'Richard Stallman, and Len Tower.\n'

const SHORT = '0123456789abBcC:dD:eEfF:hHiI:lL:nNpPqrsS:tTuU:vwW:x:X:yZ'

const LONG: Record<string, [number, string]> = {
  binary: [0, 'binary'],
  brief: [0, 'q'],
  'changed-group-format': [1, 'format'],
  color: [2, 'color'],
  context: [2, 'C'],
  ed: [0, 'e'],
  exclude: [1, 'x'],
  'exclude-from': [1, 'X'],
  'expand-tabs': [0, 't'],
  'forward-ed': [0, 'f'],
  'from-file': [1, 'from'],
  help: [0, 'help'],
  'horizon-lines': [1, 'horizon'],
  ifdef: [1, 'D'],
  'ignore-all-space': [0, 'w'],
  'ignore-blank-lines': [0, 'B'],
  'ignore-case': [0, 'i'],
  'ignore-file-name-case': [0, 'name-case'],
  'ignore-matching-lines': [1, 'I'],
  'ignore-space-change': [0, 'b'],
  'ignore-tab-expansion': [0, 'E'],
  'ignore-trailing-space': [0, 'Z'],
  'inhibit-hunk-merge': [0, 'h'],
  'initial-tab': [0, 'T'],
  label: [1, 'L'],
  'left-column': [0, 'left'],
  'line-format': [1, 'format'],
  minimal: [0, 'd'],
  'new-file': [0, 'N'],
  'new-group-format': [1, 'format'],
  'new-line-format': [1, 'format'],
  'no-dereference': [0, 'binary'],
  'no-ignore-file-name-case': [0, 'binary'],
  normal: [0, 'normal'],
  'old-group-format': [1, 'format'],
  'old-line-format': [1, 'format'],
  paginate: [0, 'l'],
  palette: [1, 'binary'],
  rcs: [0, 'n'],
  recursive: [0, 'r'],
  'report-identical-files': [0, 's'],
  'sdiff-merge-assist': [0, 'merge'],
  'show-c-function': [0, 'p'],
  'show-function-line': [1, 'F'],
  'side-by-side': [0, 'y'],
  'speed-large-files': [0, 'H'],
  'starting-file': [1, 'S'],
  'strip-trailing-cr': [0, 'cr'],
  'suppress-blank-empty': [0, 'blank-empty'],
  'suppress-common-lines': [0, 'common'],
  tabsize: [1, 'tabsize'],
  text: [0, 'a'],
  'to-file': [1, 'to'],
  'unchanged-group-format': [1, 'format'],
  'unchanged-line-format': [1, 'format'],
  'unidirectional-new-file': [0, 'P'],
  unified: [2, 'U'],
  version: [0, 'v'],
  width: [1, 'W'],
}

const WIDE =
  /[\u1100-\u115f\u231a\u231b\u2329\u232a\u23e9-\u23ec\u23f0\u23f3\u25fd\u25fe\u2614\u2615\u2648-\u2653\u267f\u2693\u26a1\u26aa\u26ab\u26bd\u26be\u26c4\u26c5\u26ce\u26d4\u26ea\u26f2\u26f3\u26f5\u26fa\u26fd\u2705\u270a\u270b\u2728\u274c\u274e\u2753-\u2755\u2757\u2795-\u2797\u27b0\u27bf\u2b1b\u2b1c\u2b50\u2b55\u2e80-\u303e\u3041-\u33ff\u3400-\u4dff\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{16fe0}-\u{16fe4}\u{16ff0}\u{16ff1}\u{17000}-\u{18d08}\u{1aff0}-\u{1affe}\u{1b000}-\u{1b2ff}\u{1f200}-\u{1f2ff}\u{20000}-\u{3fffd}]|(?![\u{1f1e6}-\u{1f1ff}])\p{Emoji_Presentation}/u
const WIDTH_ONE = /[\u00ad\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u{110bd}\u{110cd}]/u
const NARROW = /[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Cn}\u1160-\u11ff]/u

function wcwidth(c: string): number {
  if (WIDTH_ONE.test(c)) return 1
  if (NARROW.test(c)) return 0
  return WIDE.test(c) ? 2 : 1
}

function lower(text: string): string {
  return text.replace(/[A-Z]+/g, (match) => match.toLowerCase())
}

function expandTabs(text: string, tabsize: number): string {
  let out = ''
  let column = 0
  for (const c of text) {
    if (c === '\b') column -= column > 0 ? 1 : 0
    else if (c === '\t') {
      const spaces = tabsize - (column % tabsize)
      column += spaces
      out += ' '.repeat(spaces)
      continue
    } else if (c === '\r') column = 0
    else column += byteLength(c)
    out += c
  }
  return out
}

function keyOf(line: string, s: Settings): string {
  let text = line
  if (s.white === ALL) text = text.replace(/[ \t\v\f\r]+/g, '')
  else if (s.white === CHANGE) text = text.replace(/[ \t\v\f\r]+/g, ' ').replace(/ $/, '')
  else {
    if (s.white & TRAILING) text = text.replace(/[ \t\v\f\r]+$/, '')
    if (s.white & TABS) text = expandTabs(text, s.tabsize)
  }
  return s.ignoreCase ? lower(text) : text
}

function newlines(text: string, from: number, to: number): number {
  let count = 0
  for (let at = text.indexOf('\n', from); at >= 0 && at < to; at = text.indexOf('\n', at + 1))
    count++
  return count
}

function diag(
  xoff: number,
  xlim: number,
  yoff: number,
  ylim: number,
  minimal: boolean,
  c: Context,
): Partition {
  const { fd, bd, offset: o, xv, yv } = c
  const dmin = xoff - ylim
  const dmax = xlim - yoff
  const fmid = xoff - yoff
  const bmid = xlim - ylim
  let fmin = fmid
  let fmax = fmid
  let bmin = bmid
  let bmax = bmid
  const odd = ((fmid - bmid) & 1) !== 0
  fd[o + fmid] = xoff
  bd[o + bmid] = xlim
  for (let cost = 1; ; cost++) {
    let big = false
    if (fmin > dmin) fd[o + --fmin - 1] = -1
    else ++fmin
    if (fmax < dmax) fd[o + ++fmax + 1] = -1
    else --fmax
    for (let d = fmax; d >= fmin; d -= 2) {
      const tlo = fd[o + d - 1]!
      const thi = fd[o + d + 1]!
      const x0 = tlo < thi ? thi : tlo + 1
      let x = x0
      let y = x0 - d
      while (x < xlim && y < ylim && xv[x] === yv[y]) {
        x++
        y++
      }
      if (x - x0 > SNAKE) big = true
      fd[o + d] = x
      if (odd && bmin <= d && d <= bmax && bd[o + d]! <= x)
        return { xmid: x, ymid: y, lo: true, hi: true }
    }
    if (bmin > dmin) bd[o + --bmin - 1] = FAR
    else ++bmin
    if (bmax < dmax) bd[o + ++bmax + 1] = FAR
    else --bmax
    for (let d = bmax; d >= bmin; d -= 2) {
      const tlo = bd[o + d - 1]!
      const thi = bd[o + d + 1]!
      const x0 = tlo < thi ? tlo : thi - 1
      let x = x0
      let y = x0 - d
      while (xoff < x && yoff < y && xv[x - 1] === yv[y - 1]) {
        x--
        y--
      }
      if (x0 - x > SNAKE) big = true
      bd[o + d] = x
      if (!odd && fmin <= d && d <= fmax && x <= fd[o + d]!)
        return { xmid: x, ymid: y, lo: true, hi: true }
    }
    if (minimal) continue
    if (200 < cost && big && c.heuristic) {
      let best = 0
      const part: Partition = { xmid: 0, ymid: 0, lo: true, hi: false }
      for (let d = fmax; d >= fmin; d -= 2) {
        const dd = d - fmid
        const x = fd[o + d]!
        const y = x - d
        const v = (x - xoff) * 2 - dd
        if (v > 12 * (cost + Math.abs(dd)) && v > best) {
          if (xoff + SNAKE <= x && x < xlim && yoff + SNAKE <= y && y < ylim) {
            for (let k = 1; xv[x - k] === yv[y - k]; k++)
              if (k === SNAKE) {
                best = v
                part.xmid = x
                part.ymid = y
                break
              }
          }
        }
      }
      if (best > 0) return part
      best = 0
      part.lo = false
      part.hi = true
      for (let d = bmax; d >= bmin; d -= 2) {
        const dd = d - bmid
        const x = bd[o + d]!
        const y = x - d
        const v = (xlim - x) * 2 + dd
        if (v > 12 * (cost + Math.abs(dd)) && v > best) {
          if (xoff < x && x <= xlim - SNAKE && yoff < y && y <= ylim - SNAKE) {
            for (let k = 0; xv[x + k] === yv[y + k]; k++)
              if (k === SNAKE - 1) {
                best = v
                part.xmid = x
                part.ymid = y
                break
              }
          }
        }
      }
      if (best > 0) return part
    }
    if (cost >= c.tooExpensive) {
      let fxybest = -1
      let fxbest = 0
      for (let d = fmax; d >= fmin; d -= 2) {
        let x = Math.min(fd[o + d]!, xlim)
        let y = x - d
        if (ylim < y) {
          x = ylim + d
          y = ylim
        }
        if (fxybest < x + y) {
          fxybest = x + y
          fxbest = x
        }
      }
      let bxybest = FAR
      let bxbest = 0
      for (let d = bmax; d >= bmin; d -= 2) {
        let x = Math.max(xoff, bd[o + d]!)
        let y = x - d
        if (y < yoff) {
          x = yoff + d
          y = yoff
        }
        if (x + y < bxybest) {
          bxybest = x + y
          bxbest = x
        }
      }
      if (xlim + ylim - bxybest < fxybest - (xoff + yoff))
        return { xmid: fxbest, ymid: fxybest - fxbest, lo: true, hi: false }
      return { xmid: bxbest, ymid: bxybest - bxbest, lo: false, hi: true }
    }
  }
}

function compareseq(
  xoff: number,
  xlim: number,
  yoff: number,
  ylim: number,
  minimal: boolean,
  c: Context,
): void {
  const { xv, yv } = c
  for (;;) {
    while (xoff < xlim && yoff < ylim && xv[xoff] === yv[yoff]) {
      xoff++
      yoff++
    }
    while (xoff < xlim && yoff < ylim && xv[xlim - 1] === yv[ylim - 1]) {
      xlim--
      ylim--
    }
    if (xoff === xlim) {
      while (yoff < ylim) c.changed1[c.real1[yoff++]! + 1] = 1
      return
    }
    if (yoff === ylim) {
      while (xoff < xlim) c.changed0[c.real0[xoff++]! + 1] = 1
      return
    }
    const part = diag(xoff, xlim, yoff, ylim, minimal, c)
    if (xlim + ylim - (part.xmid + part.ymid) < part.xmid + part.ymid - (xoff + yoff)) {
      compareseq(part.xmid, xlim, part.ymid, ylim, part.hi, c)
      xlim = part.xmid
      ylim = part.ymid
      minimal = part.lo
    } else {
      compareseq(xoff, part.xmid, yoff, part.ymid, part.lo, c)
      xoff = part.xmid
      yoff = part.ymid
      minimal = part.hi
    }
  }
}

function discard(equivs: Int32Array[], classes: number, minimal: boolean, changed: Uint8Array[]) {
  const counts = equivs.map((list) => {
    const count = new Int32Array(classes + 1)
    for (const id of list) count[id]!++
    return count
  })
  const discarded = equivs.map((list) => new Uint8Array(list.length))
  for (let f = 0; f < 2; f++) {
    const list = equivs[f]!
    const marks = discarded[f]!
    const other = counts[1 - f]!
    let many = 5
    let tem = Math.floor(list.length / 64)
    while ((tem >>= 2) > 0) many *= 2
    for (let i = 0; i < list.length; i++) {
      const matches = other[list[i]!]!
      if (matches === 0) marks[i] = 1
      else if (matches > many) marks[i] = 2
    }
  }
  for (let f = 0; f < 2; f++) {
    const marks = discarded[f]!
    const end = marks.length
    for (let i = 0; i < end; i++) {
      if (marks[i] === 2) marks[i] = 0
      else if (marks[i] !== 0) {
        let j = i
        let provisional = 0
        for (; j < end; j++) {
          if (marks[j] === 0) break
          if (marks[j] === 2) provisional++
        }
        while (j > i && marks[j - 1] === 2) {
          marks[--j] = 0
          provisional--
        }
        const length = j - i
        if (provisional * 4 > length) {
          while (j > i) if (marks[--j] === 2) marks[j] = 0
        } else {
          let minimum = 1
          let tem = length >> 2
          while (0 < (tem >>= 2)) minimum <<= 1
          minimum++
          let consec = 0
          for (j = 0; j < length; j++)
            if (marks[i + j] !== 2) consec = 0
            else if (minimum === ++consec) j -= consec
            else if (minimum < consec) marks[i + j] = 0
          consec = 0
          for (j = 0; j < length; j++) {
            if (j >= 8 && marks[i + j] === 1) break
            if (marks[i + j] === 2) {
              consec = 0
              marks[i + j] = 0
            } else if (marks[i + j] === 0) consec = 0
            else consec++
            if (consec === 3) break
          }
          i += length - 1
          consec = 0
          for (j = 0; j < length; j++) {
            if (j >= 8 && marks[i - j] === 1) break
            if (marks[i - j] === 2) {
              consec = 0
              marks[i - j] = 0
            } else if (marks[i - j] === 0) consec = 0
            else consec++
            if (consec === 3) break
          }
        }
      }
    }
  }
  return equivs.map((list, f) => {
    const marks = discarded[f]!
    const kept: number[] = []
    const real: number[] = []
    for (let i = 0; i < list.length; i++)
      if (minimal || marks[i] === 0) {
        kept.push(list[i]!)
        real.push(i)
      } else changed[f]![i + 1] = 1
    return { kept: Int32Array.from(kept), real: Int32Array.from(real) }
  })
}

function shiftBoundaries(equivs: Int32Array[], changed: Uint8Array[]) {
  for (let f = 0; f < 2; f++) {
    const ch = changed[f]!
    const other = changed[1 - f]!
    const eq = equivs[f]!
    const end = eq.length
    let i = 0
    let j = 0
    for (;;) {
      while (i < end && !ch[i + 1]) {
        while (other[1 + j++]);
        i++
      }
      if (i === end) break
      let start = i
      while (ch[1 + ++i]);
      while (other[1 + j]) j++
      let length: number
      let corresponding: number
      do {
        length = i - start
        while (start && eq[start - 1] === eq[i - 1]) {
          ch[1 + --start] = 1
          ch[1 + --i] = 0
          while (ch[start]) start--
          while (other[1 + --j]);
        }
        corresponding = other[j] ? i : end
        while (i !== end && eq[start] === eq[i]) {
          ch[1 + start++] = 0
          ch[1 + i++] = 1
          while (ch[1 + i]) i++
          while (other[1 + ++j]) corresponding = i
        }
      } while (length !== i - start)
      while (corresponding < i) {
        ch[1 + --start] = 1
        ch[1 + --i] = 0
        while (other[1 + --j]);
      }
    }
  }
}

function analyze(texts: string[], s: Settings): { sides: Lines[]; script: Change[] } {
  const robust = s.style !== 'ed' && s.style !== 'forward'
  const raw = texts.map((text) => (s.stripCr ? text.replace(/\r\n/g, '\n') : text))
  const missing = raw.map((text) => text !== '' && !text.endsWith('\n'))
  const buf = raw.map((text, f) => (missing[f] ? text + '\n' : text))
  const [a, b] = buf as [string, string]
  const n0 = a.length
  const n1 = b.length
  const limit = Math.min(n0, n1)
  let p = 0
  while (p < limit && a.charCodeAt(p) === b.charCodeAt(p)) p++
  if (robust && n0 - Number(missing[0]) < p !== n1 - Number(missing[1]) < p) p--
  let horizon = s.horizon
  while (p !== 0 && (a[p - 1] !== '\n' || horizon-- > 0)) p--
  const prefixEnd = p
  let suffix0 = n0
  let suffix1 = n1
  if (!robust || missing[0] === missing[1]) {
    let p0 = n0
    let p1 = n1
    const stop = prefixEnd + (n0 < n1 ? 0 : n0 - n1)
    while (p0 !== stop)
      if (a.charCodeAt(--p0) !== b.charCodeAt(--p1)) {
        ++p0
        ++p1
        break
      }
    const at = p0
    let extra =
      s.horizon + ((p0 === 0 || a[p0 - 1] === '\n') && (p1 === 0 || b[p1 - 1] === '\n') ? 0 : 1)
    while (extra-- > 0 && p0 !== n0) p0 = a.indexOf('\n', p0) + 1
    suffix0 = p0
    suffix1 = p1 + (p0 - at)
  }
  const sides = buf.map((text, f) => {
    const lines = text.split('\n')
    lines.pop()
    return { lines, complete: !(robust && missing[f]) }
  })
  const prefix = newlines(a, 0, prefixEnd)
  const buffered = [newlines(a, prefixEnd, suffix0), newlines(b, prefixEnd, suffix1)]
  const classes = new Map<string, number>()
  const plain = s.white === 0 && !s.ignoreCase
  const equivs = buffered.map((count, f) => {
    const list = new Int32Array(count)
    const lines = sides[f]!.lines
    for (let i = 0; i < count; i++) {
      const line = lines[prefix + i]!
      let key = plain ? line : keyOf(line, s)
      if (robust && missing[f] && prefix + i === lines.length - 1 && s.white < TRAILING)
        key = '\n' + key
      let id = classes.get(key)
      if (id === undefined) classes.set(key, (id = classes.size + 1))
      list[i] = id
    }
    return list
  })
  const changed = buffered.map((count) => new Uint8Array(count + 2))
  const [x, y] = discard(equivs, classes.size, s.minimal, changed) as [
    { kept: Int32Array; real: Int32Array },
    { kept: Int32Array; real: Int32Array },
  ]
  let diags = x.kept.length + y.kept.length + 3
  let tooExpensive = 1
  for (; diags !== 0; diags >>= 2) tooExpensive <<= 1
  const size = x.kept.length + y.kept.length + 3
  compareseq(0, x.kept.length, 0, y.kept.length, s.minimal, {
    xv: x.kept,
    yv: y.kept,
    fd: new Int32Array(size),
    bd: new Int32Array(size),
    offset: y.kept.length + 1,
    heuristic: s.heuristic,
    tooExpensive: Math.max(4096, tooExpensive),
    changed0: changed[0]!,
    changed1: changed[1]!,
    real0: x.real,
    real1: y.real,
  })
  shiftBoundaries(equivs, changed)
  const [c0, c1] = changed as [Uint8Array, Uint8Array]
  const script: Change[] = []
  let i0 = buffered[0]!
  let i1 = buffered[1]!
  while (i0 >= 0 || i1 >= 0) {
    if (c0[i0] || c1[i1]) {
      const line0 = i0
      const line1 = i1
      while (c0[i0]) --i0
      while (c1[i1]) --i1
      script.push({
        line0: prefix + i0,
        line1: prefix + i1,
        deleted: line0 - i0,
        inserted: line1 - i1,
        ignore: false,
      })
    }
    i0--
    i1--
  }
  return { sides, script: script.reverse() }
}

const ESCAPES: Record<string, string> = {
  '\x07': 'a',
  '\b': 'b',
  '\t': 't',
  '\n': 'n',
  '\v': 'v',
  '\f': 'f',
  '\r': 'r',
  '"': '"',
  '\\': '\\',
}

function quoteName(name: string): string {
  const bytes = encode(name)
  let quote = false
  let out = ''
  for (const byte of bytes) {
    const c = String.fromCharCode(byte)
    if (byte === 32) quote = true
    if (ESCAPES[c]) {
      quote = true
      out += '\\' + ESCAPES[c]
    } else if (byte < 32 || byte >= 128) {
      quote = true
      out += '\\' + byte.toString(8).padStart(3, '0')
    } else out += c
  }
  return quote ? '"' + out + '"' : name
}

function shellQuote(arg: string): string {
  if (
    arg !== '' &&
    !/[ !"$&'()*;<=>?[\\^`|\x7f]/.test(arg) &&
    ![...arg].some((c) => c < ' ') &&
    !/^[#~]/.test(arg) &&
    arg !== '{' &&
    arg !== '}'
  )
    return arg
  return "'" + arg.replace(/'/g, "'\\''") + "'"
}

function stamp(mtime: number): string {
  const date = new Date(mtime)
  const two = (n: number) => String(n).padStart(2, '0')
  return (
    date.getUTCFullYear() +
    '-' +
    two(date.getUTCMonth() + 1) +
    '-' +
    two(date.getUTCDate()) +
    ' ' +
    two(date.getUTCHours()) +
    ':' +
    two(date.getUTCMinutes()) +
    ':' +
    two(date.getUTCSeconds()) +
    '.' +
    String(date.getUTCMilliseconds()).padStart(3, '0') +
    '000000 +0000'
  )
}

function settings(
  ctx: CommandContext,
): { s: Settings; operands: string[]; excludeFrom: string[]; from?: string; to?: string } | string {
  const args = ctx.args
  const raw: string[] = []
  const parsed: [string, string | undefined][] = []
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      raw.push(arg)
      operands.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = arg.slice(2, eq < 0 ? undefined : eq)
      const matches = LONG[name] ? [name] : Object.keys(LONG).filter((key) => key.startsWith(name))
      if (!matches.length) throw new CommandError("unrecognized option '" + arg + "'" + TRY, 2)
      if (matches.length > 1) throw new CommandError("option '" + arg + "' is ambiguous" + TRY, 2)
      const [kind, id] = LONG[matches[0]!]!
      raw.push(arg)
      if (eq >= 0) {
        if (kind === 0)
          throw new CommandError("option '--" + matches[0] + "' doesn't allow an argument" + TRY, 2)
        parsed.push([id, arg.slice(eq + 1)])
      } else if (kind === 1) {
        if (i + 1 >= args.length)
          throw new CommandError("option '--" + matches[0] + "' requires an argument" + TRY, 2)
        raw.push(args[++i]!)
        parsed.push([id, args[i]])
      } else parsed.push([id, undefined])
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      raw.push(arg)
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j]!
        const at = SHORT.indexOf(c)
        if (at < 0 || c === ':') throw new CommandError("invalid option -- '" + c + "'" + TRY, 2)
        if (SHORT[at + 1] === ':') {
          let value = arg.slice(j + 1)
          if (!value) {
            if (i + 1 >= args.length)
              throw new CommandError("option requires an argument -- '" + c + "'" + TRY, 2)
            value = args[++i]!
            raw.push(value)
          }
          parsed.push([c, value])
          break
        }
        parsed.push([c, undefined])
      }
      continue
    }
    operands.push(arg)
  }
  const s: Settings = {
    style: 'normal',
    context: 0,
    horizon: 0,
    minimal: false,
    heuristic: false,
    ignoreCase: false,
    white: 0,
    blank: false,
    ignore: [],
    functions: [],
    text: false,
    brief: false,
    newFile: false,
    unidirectional: false,
    recursive: false,
    report: false,
    expandTabs: false,
    initialTab: false,
    suppressBlankEmpty: false,
    suppressCommon: false,
    leftColumn: false,
    stripCr: false,
    tabsize: 0,
    half: 0,
    column2: 0,
    labels: [],
    excludes: [],
    start: undefined,
    switches: raw.map((arg) => ' ' + shellQuote(arg)).join(''),
  }
  let style: Style | undefined
  const setStyle = (next: Style) => {
    if (style !== undefined && style !== next)
      throw new CommandError('conflicting output style options' + TRY, 2)
    style = next
  }
  const number = (value: string, positive: boolean, message: string) => {
    if (!/^\s*[+-]?\d+$/.test(value) || Number(value) < (positive ? 1 : 0))
      throw new CommandError(message + " '" + value + "'" + TRY, 2)
    return Number(value)
  }
  let ocontext = -1
  let explicit = false
  let showFunction = false
  let width = 0
  let from: string | undefined
  let to: string | undefined
  let prev = ''
  const excludeFrom: string[] = []
  for (const [id, value] of parsed) {
    if (/^\d$/.test(id)) ocontext = /^\d$/.test(prev) ? 10 * ocontext + Number(id) : Number(id)
    else if (id === 'a') s.text = true
    else if (id === 'b') s.white = Math.max(s.white, CHANGE)
    else if (id === 'Z') s.white = s.white < CHANGE ? s.white | TRAILING : s.white
    else if (id === 'E') s.white = s.white < CHANGE ? s.white | TABS : s.white
    else if (id === 'w') s.white = ALL
    else if (id === 'B') s.blank = true
    else if (id === 'C' || id === 'U') {
      const lines = value === undefined ? 3 : number(value, false, 'invalid context length')
      setStyle(id === 'U' ? 'unified' : 'context')
      s.context = Math.max(s.context, lines)
      explicit = true
    } else if (id === 'c' || id === 'u') {
      setStyle(id === 'u' ? 'unified' : 'context')
      s.context = Math.max(s.context, 3)
    } else if (id === 'd') s.minimal = true
    else if (id === 'e') setStyle('ed')
    else if (id === 'f') setStyle('forward')
    else if (id === 'n') setStyle('rcs')
    else if (id === 'y') setStyle('sdiff')
    else if (id === 'normal') setStyle('normal')
    else if (id === 'F') s.functions.push(posixRegExp(value!, false))
    else if (id === 'H') s.heuristic = true
    else if (id === 'i') s.ignoreCase = true
    else if (id === 'I') s.ignore.push(posixRegExp(value!, false))
    else if (id === 'L') {
      if (s.labels.length >= 2) throw new CommandError('too many file label options', 2)
      s.labels.push(value)
    } else if (id === 'N') s.newFile = true
    else if (id === 'P') s.unidirectional = true
    else if (id === 'p') {
      showFunction = true
      s.functions.push(/^[\p{L}$_]/u)
    } else if (id === 'q') s.brief = true
    else if (id === 'r') s.recursive = true
    else if (id === 's') s.report = true
    else if (id === 'S') s.start = value
    else if (id === 't') s.expandTabs = true
    else if (id === 'T') s.initialTab = true
    else if (id === 'v') return VERSION
    else if (id === 'x') s.excludes.push(globRegExp(value!))
    else if (id === 'X') excludeFrom.push(value!)
    else if (id === 'W') {
      const next = number(value!, true, 'invalid width')
      if (width && width !== next) throw new CommandError('conflicting width options', 2)
      width = next
    } else if (id === 'from') from = value
    else if (id === 'to') to = value
    else if (id === 'horizon')
      s.horizon = Math.max(s.horizon, number(value!, false, 'invalid horizon length'))
    else if (id === 'left') s.leftColumn = true
    else if (id === 'cr') s.stripCr = true
    else if (id === 'blank-empty') s.suppressBlankEmpty = true
    else if (id === 'common') s.suppressCommon = true
    else if (id === 'tabsize') {
      const next = number(value!, true, 'invalid tabsize')
      if (s.tabsize && s.tabsize !== next) throw new CommandError('conflicting tabsize options', 2)
      s.tabsize = next
    } else if (id === 'color') {
      if (value === 'always') throw new CommandError("unsupported option '--color=always'", 2)
      if (value !== undefined && value !== 'auto' && value !== 'never')
        throw new CommandError("invalid color '" + value + "'" + TRY, 2)
    } else if (id !== 'h' && id !== 'binary')
      throw new CommandError("unsupported option '" + (id.length === 1 ? '-' + id : id) + "'", 2)
    prev = id
  }
  if (style === undefined) {
    if (showFunction) {
      setStyle('context')
      if (ocontext < 0) s.context = 3
    } else setStyle('normal')
  }
  s.style = style!
  if (
    ocontext >= 0 &&
    (s.style === 'context' || s.style === 'unified') &&
    (s.context < ocontext || (ocontext < s.context && !explicit))
  )
    s.context = ocontext
  if (!s.tabsize) s.tabsize = 8
  if (!width) width = 130
  const t = s.expandTabs ? 1 : s.tabsize
  const gutter = t + 3
  const unaligned = (width >> 1) + (gutter >> 1) + (width & gutter & 1)
  const off = unaligned - (unaligned % t)
  s.half = off <= 3 || width <= off ? 0 : Math.min(off - 3, width - off)
  s.column2 = s.half ? off : width
  if (s.horizon < s.context) s.horizon = s.context
  return { s, operands, excludeFrom, from, to }
}

function ignorable(line: string, s: Settings): boolean {
  if (s.blank) {
    if (line === '') return true
    if (s.white >= TRAILING && /^[ \t\n\v\f\r]*$/.test(line)) return true
  }
  return s.ignore.some((pattern) => pattern.test(line))
}

function analyzeHunk(hunk: Change[], sides: Lines[], s: Settings): Hunk {
  let trivial = s.blank || s.ignore.length > 0
  let from = 0
  let to = 0
  for (const change of hunk) {
    from += change.deleted
    to += change.inserted
    for (let i = change.line0; trivial && i < change.line0 + change.deleted; i++)
      if (!ignorable(sides[0]!.lines[i]!, s)) trivial = false
    for (let i = change.line1; trivial && i < change.line1 + change.inserted; i++)
      if (!ignorable(sides[1]!.lines[i]!, s)) trivial = false
  }
  const first = hunk[0]!
  const last = hunk[hunk.length - 1]!
  return {
    first0: first.line0,
    last0: last.line0 + last.deleted - 1,
    first1: first.line1,
    last1: last.line1 + last.inserted - 1,
    kind: trivial ? 0 : (from ? OLD : 0) | (to ? NEW : 0),
  }
}

function range(a: number, b: number, separator = ','): string {
  return b > a ? a + 1 + separator + (b + 1) : String(b + 1)
}

class Writer {
  out: string[] = []
  begun = false
  lastSearch = 0
  lastMatch = -1
  readonly s: Settings
  readonly sides: Lines[]
  readonly begin: () => void
  constructor(s: Settings, sides: Lines[], begin: () => void) {
    this.s = s
    this.sides = sides
    this.begin = begin
  }

  complete(f: number, i: number): boolean {
    const side = this.sides[f]!
    return side.complete || i < side.lines.length - 1
  }

  body(text: string, again?: string): string {
    if (!this.s.expandTabs) return text
    let out = ''
    let column = 0
    for (let k = 0; k < text.length; k++) {
      const c = text[k]!
      if (c === '\t') {
        const spaces = this.s.tabsize - (column % this.s.tabsize)
        column += spaces
        out += ' '.repeat(spaces)
      } else if (c === '\r') {
        out += c
        if (again !== undefined && k + 1 < text.length) out += again
        column = 0
      } else if (c === '\b') {
        if (column === 0) continue
        column--
        out += c
      } else {
        if (c >= ' ' && c <= '~') column++
        out += c
      }
    }
    return out
  }

  end(f: number, i: number): string {
    return this.complete(f, i) ? '\n' : '\n' + NO_NEWLINE
  }

  flagged(flag: string, f: number, i: number): string {
    const text = this.sides[f]!.lines[i]!
    const format = flag + (this.s.initialTab ? '\t' : ' ')
    const head = this.s.suppressBlankEmpty && text === '' ? (flag === ' ' ? '' : flag) : format
    return head + this.body(text, format) + this.end(f, i)
  }

  plain(f: number, i: number): string {
    return this.body(this.sides[f]!.lines[i]!) + (this.complete(f, i) ? '\n' : '')
  }

  write(text: string) {
    this.out.push(text)
  }

  normal(script: Change[]) {
    for (const change of script) {
      const h = analyzeHunk([change], this.sides, this.s)
      if (!h.kind) continue
      this.begin()
      this.write(range(h.first0, h.last0) + ' dac'[h.kind] + range(h.first1, h.last1) + '\n')
      if (h.kind & OLD)
        for (let i = h.first0; i <= h.last0; i++) this.write(this.flagged('<', 0, i))
      if (h.kind === (OLD | NEW)) this.write('---\n')
      if (h.kind & NEW)
        for (let i = h.first1; i <= h.last1; i++) this.write(this.flagged('>', 1, i))
    }
  }

  ed(script: Change[]) {
    for (const change of [...script].reverse()) {
      const h = analyzeHunk([change], this.sides, this.s)
      if (!h.kind) continue
      this.begin()
      this.write(range(h.first0, h.last0) + ' dac'[h.kind] + '\n')
      if (h.kind === OLD) continue
      let inserting = true
      for (let i = h.first1; i <= h.last1; i++) {
        if (!inserting) {
          this.write('a\n')
          inserting = true
        }
        if (this.sides[1]!.lines[i] === '.') {
          this.write('..\n.\ns/.//\n')
          inserting = false
        } else this.write(this.plain(1, i))
      }
      if (inserting) this.write('.\n')
    }
  }

  forward(script: Change[]) {
    for (const change of script) {
      const h = analyzeHunk([change], this.sides, this.s)
      if (!h.kind) continue
      this.begin()
      this.write(' dac'[h.kind] + range(h.first0, h.last0, ' ') + '\n')
      if (h.kind === OLD) continue
      for (let i = h.first1; i <= h.last1; i++) this.write(this.plain(1, i))
      this.write('.\n')
    }
  }

  rcs(script: Change[]) {
    for (const change of script) {
      const h = analyzeHunk([change], this.sides, this.s)
      if (!h.kind) continue
      this.begin()
      if (h.kind & OLD)
        this.write('d' + (h.first0 + 1) + ' ' + Math.max(1, h.last0 - h.first0 + 1) + '\n')
      if (h.kind & NEW) {
        this.write('a' + (h.last0 + 1) + ' ' + Math.max(1, h.last1 - h.first1 + 1) + '\n')
        for (let i = h.first1; i <= h.last1; i++) this.write(this.plain(1, i))
      }
    }
  }

  hunks(script: Change[]): Change[][] {
    const groups: Change[][] = []
    const context = this.s.context
    for (let k = 0; k < script.length; ) {
      let end = k
      while (end + 1 < script.length) {
        const top = script[end]!.line0 + script[end]!.deleted
        const next = script[end + 1]!
        if (next.line0 - top < (next.ignore ? context : 2 * context + 1)) end++
        else break
      }
      groups.push(script.slice(k, end + 1))
      k = end + 1
    }
    return groups
  }

  findFunction(linenum: number): string | undefined {
    const lines = this.sides[0]!.lines
    let i = linenum
    const last = this.lastSearch
    this.lastSearch = i
    while (last <= --i) {
      const line = lines[i]!
      if (this.s.functions.some((pattern) => pattern.test(line))) {
        this.lastMatch = i
        return line
      }
    }
    return this.lastMatch >= 0 ? lines[this.lastMatch] : undefined
  }

  functionLabel(line: string | undefined): string {
    if (line === undefined) return ''
    const start = line.length - line.replace(/^[ \t\v\f\r]+/, '').length
    const bytes = encode(line.slice(start)).slice(0, 40)
    return ' ' + decode(bytes).replace(/[ \t\n\v\f\r]+$/, '')
  }

  widen(h: Hunk) {
    const c = this.s.context
    const n0 = this.sides[0]!.lines.length
    const n1 = this.sides[1]!.lines.length
    return {
      first0: Math.max(h.first0 - c, 0),
      first1: Math.max(h.first1 - c, 0),
      last0: h.last0 < n0 - c ? h.last0 + c : n0 - 1,
      last1: h.last1 < n1 - c ? h.last1 + c : n1 - 1,
    }
  }

  context(script: Change[]) {
    for (const hunk of this.hunks(script)) {
      const h = analyzeHunk(hunk, this.sides, this.s)
      if (!h.kind) continue
      const { first0, last0, first1, last1 } = this.widen(h)
      const label = this.s.functions.length ? this.functionLabel(this.findFunction(first0)) : ''
      this.begin()
      const numbers = (a: number, b: number) => (b <= a ? String(b + 1) : a + 1 + ',' + (b + 1))
      this.write('***************' + label + '\n*** ' + numbers(first0, last0) + ' ****\n')
      if (h.kind & OLD) {
        let k = 0
        for (let i = first0; i <= last0; i++) {
          while (k < hunk.length && hunk[k]!.line0 + hunk[k]!.deleted <= i) k++
          const next = hunk[k]
          const flag = next && next.line0 <= i ? (next.inserted > 0 ? '!' : '-') : ' '
          this.write(this.flagged(flag, 0, i))
        }
      }
      this.write('--- ' + numbers(first1, last1) + ' ----\n')
      if (h.kind & NEW) {
        let k = 0
        for (let i = first1; i <= last1; i++) {
          while (k < hunk.length && hunk[k]!.line1 + hunk[k]!.inserted <= i) k++
          const next = hunk[k]
          const flag = next && next.line1 <= i ? (next.deleted > 0 ? '!' : '+') : ' '
          this.write(this.flagged(flag, 1, i))
        }
      }
    }
  }

  unified(script: Change[]) {
    const tab = this.s.initialTab ? '\t' : ''
    for (const hunk of this.hunks(script)) {
      const h = analyzeHunk(hunk, this.sides, this.s)
      if (!h.kind) continue
      const { first0, last0, first1, last1 } = this.widen(h)
      const label = this.s.functions.length ? this.functionLabel(this.findFunction(first0)) : ''
      this.begin()
      const numbers = (a: number, b: number) =>
        b <= a ? (b < a ? b + 1 + ',0' : String(b + 1)) : a + 1 + ',' + (b - a + 1)
      this.write(
        '@@ -' + numbers(first0, last0) + ' +' + numbers(first1, last1) + ' @@' + label + '\n',
      )
      let k = 0
      let i = first0
      let j = first1
      while (i <= last0 || j <= last1) {
        const next = hunk[k]
        const blank = (f: number, at: number) =>
          this.s.suppressBlankEmpty && this.sides[f]!.lines[at] === ''
        if (!next || i < next.line0) {
          if (!blank(0, i)) this.write(this.s.initialTab ? '\t' : ' ')
          this.write(this.body(this.sides[0]!.lines[i]!) + this.end(0, i))
          i++
          j++
          continue
        }
        for (let n = next.deleted; n--; i++)
          this.write(
            '-' + (blank(0, i) ? '' : tab) + this.body(this.sides[0]!.lines[i]!) + this.end(0, i),
          )
        for (let n = next.inserted; n--; j++)
          this.write(
            '+' + (blank(1, j) ? '' : tab) + this.body(this.sides[1]!.lines[j]!) + this.end(1, j),
          )
        k++
      }
    }
  }

  tabTo(from: number, to: number): string {
    let out = ''
    const size = this.s.tabsize
    if (!this.s.expandTabs)
      for (let tab = from + size - (from % size); tab <= to; tab += size) {
        out += '\t'
        from = tab
      }
    return out + ' '.repeat(Math.max(0, to - from))
  }

  halfLine(text: string, indent: number, bound: number): [string, number] {
    const size = this.s.tabsize
    let out = ''
    let inPos = 0
    let outPos = 0
    for (const c of text) {
      if (c === '\t') {
        const spaces = size - (inPos % size)
        if (inPos === outPos) {
          let stop = outPos + spaces
          if (this.s.expandTabs) {
            if (bound < stop) stop = bound
            for (; outPos < stop; outPos++) out += ' '
          } else if (stop < bound) {
            outPos = stop
            out += c
          }
        }
        inPos += spaces
      } else if (c === '\r') {
        out += c + this.tabTo(0, indent)
        inPos = outPos = 0
      } else if (c === '\b') {
        if (inPos !== 0 && --inPos < bound) {
          if (outPos <= inPos) for (; outPos < inPos; outPos++) out += ' '
          else {
            outPos = inPos
            out += c
          }
        }
      } else if (c >= ' ' && c <= '~') {
        if (inPos++ < bound) {
          outPos = inPos
          out += c
        }
      } else if (c === '\f' || c === '\v' || c === '\0' || (c >= '\udc80' && c <= '\udcff')) {
        if (inPos < bound) out += c
      } else {
        inPos += wcwidth(c)
        if (inPos <= bound) {
          outPos = inPos
          out += c
        }
      }
    }
    return [out, outPos]
  }

  sideLine(left: number | undefined, separator: string, right: number | undefined) {
    const half = this.s.half
    const column2 = this.s.column2
    let out = ''
    let column = 0
    let newline = false
    if (left !== undefined) {
      newline = this.complete(0, left)
      const [text, at] = this.halfLine(this.sides[0]!.lines[left]!, 0, half)
      out += text
      column = at
    }
    if (separator !== ' ') {
      const middle = Math.floor((half + column2 - 1) / 2)
      out += this.tabTo(column, middle)
      column = middle + 1
      if (separator === '|' && newline !== this.complete(1, right!))
        separator = newline ? '/' : '\\'
      out += separator
    }
    if (right !== undefined) {
      newline ||= this.complete(1, right)
      const text = this.sides[1]!.lines[right]!
      if (text !== '' || !this.complete(1, right)) {
        out += this.tabTo(column, column2)
        out += this.halfLine(text, column2, half)[0]
      }
    }
    this.write(newline ? out + '\n' : out)
  }

  sdiff(script: Change[]) {
    this.begin()
    let next0 = 0
    let next1 = 0
    const common = (limit0: number, limit1: number) => {
      let i0 = next0
      let i1 = next1
      if (!this.s.suppressCommon && (i0 !== limit0 || i1 !== limit1)) {
        if (!this.s.leftColumn) {
          while (i0 !== limit0 && i1 !== limit1) this.sideLine(i0++, ' ', i1++)
          while (i1 !== limit1) this.sideLine(undefined, ')', i1++)
        }
        while (i0 !== limit0) this.sideLine(i0++, '(', undefined)
      }
      next0 = limit0
      next1 = limit1
    }
    for (const change of script) {
      const h = analyzeHunk([change], this.sides, this.s)
      if (!h.kind) continue
      common(h.first0, h.first1)
      let kind = h.kind
      let first0 = h.first0
      let first1 = h.first1
      if (kind === (OLD | NEW)) {
        let i = first0
        let j = first1
        for (; i <= h.last0 && j <= h.last1; i++, j++) this.sideLine(i, '|', j)
        kind = (i <= h.last0 ? OLD : 0) | (j <= h.last1 ? NEW : 0)
        next0 = first0 = i
        next1 = first1 = j
      }
      if (kind & NEW) {
        for (let j = first1; j <= h.last1; j++) this.sideLine(undefined, '>', j)
        next1 = h.last1 + 1
      }
      if (kind & OLD) {
        for (let i = first0; i <= h.last0; i++) this.sideLine(i, '<', undefined)
        next0 = h.last0 + 1
      }
    }
    common(this.sides[0]!.lines.length, this.sides[1]!.lines.length)
  }
}

function fileType(side: Side): string {
  if (side.kind === 'directory') return 'directory'
  if (side.kind === 'device') return 'character special file'
  if (side.kind === 'symlink') return 'symbolic link'
  return side.size === 0 ? 'regular empty file' : 'regular file'
}

function joinName(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : dir + '/' + name
}

const diff: CommandHandler = async (ctx) => {
  let parsed: ReturnType<typeof settings>
  try {
    parsed = settings(ctx)
  } catch (error) {
    if (!(error instanceof CommandError) || error.message.startsWith('unsupported')) throw error
    ctx.stderr.write('diff: ' + error.message + '\n')
    return error.status
  }
  if (typeof parsed === 'string') {
    ctx.stdout.write(parsed)
    return 0
  }
  const { s, operands } = parsed
  for (const path of parsed.excludeFrom) {
    const stat = await ctx.fs.stat(ctx.resolve(path))
    if (!stat || stat.kind !== 'file')
      throw new CommandError(path + ': No such file or directory', 2)
    for (const glob of decode(await ctx.fs.read(ctx.resolve(path))).split('\n'))
      if (glob) s.excludes.push(globRegExp(glob))
  }
  const noOutput = s.style !== 'sdiff' || s.suppressCommon
  let stdin: string | undefined
  const label = (f: number, name: string) => s.labels[f] ?? name
  const stdout = (text: string) => ctx.stdout.write(text)
  const perror = (name: string) =>
    ctx.stderr.write('diff: ' + name + ': No such file or directory\n')
  const read = async (side: Side): Promise<string> => {
    if (side.state === 'missing') return ''
    if (side.state === 'stdin') return (stdin ??= ctx.stdin.read())
    const special = device(side.path)
    if (special !== undefined && !(await ctx.fs.stat(side.path))) return special
    return decode(await ctx.fs.read(side.path))
  }
  const binary = (text: string) => {
    const at = text.indexOf('\0')
    return at >= 0 && byteLength(text.slice(0, at)) < BLOCK
  }
  const compareTexts = async (sides: Side[], parent: boolean): Promise<number> => {
    const texts = [await read(sides[0]!), await read(sides[1]!)]
    const names = sides.map((side, f) => label(f, side.name))
    if (!s.text && (binary(texts[0]!) || binary(texts[1]!))) {
      if (texts[0] === texts[1]) return 0
      stdout((s.brief ? 'Files ' : 'Binary files ') + names[0] + ' and ' + names[1] + ' differ\n')
      return 1
    }
    const { sides: lines, script } = analyze(texts, s)
    let changes = script.length ? 1 : 0
    if (s.blank || s.ignore.length)
      changes = script.some((change) => analyzeHunk([change], lines, s).kind) ? 1 : 0
    if (s.brief) {
      if (changes) stdout('Files ' + names[0] + ' and ' + names[1] + ' differ\n')
    } else if (changes || !noOutput) {
      const quoted = names.map(quoteName)
      const writer: Writer = new Writer(s, lines, () => {
        if (writer.begun) return
        writer.begun = true
        if (parent) writer.write('diff' + s.switches + ' ' + quoted[0] + ' ' + quoted[1] + '\n')
        const marks =
          s.style === 'context' ? ['***', '---'] : s.style === 'unified' ? ['---', '+++'] : []
        marks.forEach((mark, f) =>
          writer.write(
            mark + ' ' + (s.labels[f] ?? quoted[f] + '\t' + stamp(sides[f]!.mtime)) + '\n',
          ),
        )
      })
      if (s.blank || s.ignore.length)
        for (const change of script) change.ignore = !analyzeHunk([change], lines, s).kind
      if (s.style === 'normal') writer.normal(script)
      else if (s.style === 'context') writer.context(script)
      else if (s.style === 'unified') writer.unified(script)
      else if (s.style === 'ed') writer.ed(script)
      else if (s.style === 'forward') writer.forward(script)
      else if (s.style === 'rcs') writer.rcs(script)
      else writer.sdiff(script)
      stdout(writer.out.join(''))
    }
    if (s.style === 'ed' || s.style === 'forward')
      texts.forEach((text, f) => {
        if (text !== '' && !text.endsWith('\n')) {
          ctx.stderr.write('diff: ' + names[f] + ': No newline at end of file\n\n')
          changes = 2
        }
      })
    return changes
  }
  const statSide = async (name: string, path: string): Promise<Side> => {
    const side: Side = {
      name,
      path,
      state: 'unopened',
      kind: 'file',
      size: 0,
      mode: 0o644,
      mtime: 0,
    }
    if (name === '-') return { ...side, state: 'stdin', mtime: Date.now() }
    const stat = await ctx.fs.stat(path)
    if (stat)
      return { ...side, kind: stat.kind, size: stat.size, mode: stat.mode, mtime: stat.mtime }
    if (device(path) !== undefined) return { ...side, kind: 'device' }
    return { ...side, state: 'error' }
  }
  const compareDirs = async (sides: Side[], top: boolean): Promise<number> => {
    const lists: string[][] = []
    for (const side of sides) {
      const names = side.state === 'missing' ? [] : await ctx.fs.list(side.path)
      lists.push(names.filter((name) => !s.excludes.some((glob) => glob.test(name))).sort())
    }
    let [a, b] = lists as [string[], string[]]
    if (s.start !== undefined && top) {
      const start = s.start
      a = a.filter((name) => name >= start)
      b = b.filter((name) => name >= start)
    }
    let status = 0
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      const order =
        i >= a.length ? 1 : j >= b.length ? -1 : a[i]! < b[j]! ? -1 : a[i]! > b[j]! ? 1 : 0
      const result = await compareFiles(
        sides,
        order > 0 ? null : a[i++]!,
        order < 0 ? null : b[j++]!,
      )
      status = Math.max(status, result)
    }
    return status
  }
  const compareFiles = async (
    parent: Side[] | null,
    name0: string | null,
    name1: string | null,
  ): Promise<number> => {
    if (
      !((name0 !== null && name1 !== null) || (s.unidirectional && name1 !== null) || s.newFile)
    ) {
      stdout('Only in ' + parent![name0 === null ? 1 : 0]!.name + ': ' + (name0 ?? name1) + '\n')
      return 1
    }
    const given = [name0 !== null, name1 !== null]
    const base = [name0 ?? name1!, name1 ?? name0!]
    const names = parent ? base.map((name, f) => joinName(parent[f]!.name, name)) : base
    const paths = parent
      ? base.map((name, f) => joinName(parent[f]!.path, name))
      : names.map((name) => (name === '-' ? '' : ctx.resolve(name)))
    const sides: Side[] = []
    for (let f = 0; f < 2; f++) {
      const empty: Side = {
        name: names[f]!,
        path: paths[f]!,
        state: 'missing',
        kind: 'file',
        size: 0,
        mode: 0,
        mtime: 0,
      }
      sides.push(given[f] ? await statSide(names[f]!, paths[f]!) : empty)
    }
    for (let f = 0; f < 2; f++) {
      const side = sides[f]!
      const other = sides[1 - f]!
      if (
        (s.newFile || (f === 0 && s.unidirectional)) &&
        (side.state === 'unopened'
          ? side.kind === 'file' && (side.mode & 0o777) === 0 && side.size === 0
          : side.state === 'error' &&
            !parent &&
            (other.state === 'unopened' || other.state === 'stdin'))
      )
        side.state = 'missing'
    }
    for (let f = 0; f < 2; f++)
      if (sides[f]!.state === 'missing')
        sides[f] = { ...sides[f]!, kind: sides[1 - f]!.kind, size: 0, mtime: 0 }
    let status = 0
    for (const side of sides)
      if (side.state === 'error') {
        perror(side.name)
        status = 2
      }
    const dir = (f: number) => sides[f]!.kind === 'directory'
    if (status === 0 && !parent && dir(0) !== dir(1)) {
      const file = dir(0) ? 1 : 0
      const folder = 1 - file
      if (sides[file]!.name === '-') throw new CommandError("cannot compare '-' to a directory", 2)
      const name = joinName(sides[folder]!.name, baseOf(sides[file]!.name))
      const path = joinName(sides[folder]!.path, baseOf(sides[file]!.name))
      sides[folder] = await statSide(name, path)
      if (sides[folder]!.state === 'error') {
        perror(name)
        status = 2
      }
    }
    const missing = (f: number) => sides[f]!.state === 'missing'
    if (status !== 0 || (missing(0) && missing(1))) return status
    if (
      !missing(0) &&
      !missing(1) &&
      sides[0]!.path === sides[1]!.path &&
      sides[0]!.state === sides[1]!.state &&
      noOutput
    )
      status = 0
    else if (dir(0) && dir(1)) {
      if (parent && !s.recursive) {
        stdout('Common subdirectories: ' + sides[0]!.name + ' and ' + sides[1]!.name + '\n')
      } else status = await compareDirs(sides, !parent)
    } else if (
      dir(0) ||
      dir(1) ||
      (parent && (sides[0]!.kind !== 'file' || sides[1]!.kind !== 'file'))
    ) {
      if (missing(0) || missing(1)) {
        if ((dir(0) || dir(1)) && s.recursive && (s.newFile || (s.unidirectional && missing(0))))
          status = await compareDirs(sides, false)
        else {
          stdout('Only in ' + parent![missing(0) ? 1 : 0]!.name + ': ' + base[0] + '\n')
          status = 1
        }
      } else {
        stdout(
          'File ' +
            label(0, sides[0]!.name) +
            ' is a ' +
            fileType(sides[0]!) +
            ' while file ' +
            label(1, sides[1]!.name) +
            ' is a ' +
            fileType(sides[1]!) +
            '\n',
        )
        status = 1
      }
    } else status = await compareTexts(sides, parent !== null)
    if (status === 0 && s.report && !dir(0))
      stdout(
        'Files ' +
          label(0, sides[0]!.name) +
          ' and ' +
          label(1, sides[1]!.name) +
          ' are identical\n',
      )
    return status
  }
  if (parsed.from !== undefined && parsed.to !== undefined)
    throw new CommandError('--from-file and --to-file both specified', 2)
  if (parsed.from !== undefined || parsed.to !== undefined) {
    let status = 0
    for (const operand of operands)
      status = Math.max(
        status,
        await compareFiles(null, parsed.from ?? operand, parsed.to ?? operand),
      )
    return status
  }
  if (operands.length < 2)
    throw new CommandError(
      "missing operand after '" + (ctx.args[ctx.args.length - 1] ?? 'diff') + "'" + TRY,
      2,
    )
  if (operands.length > 2) throw new CommandError("extra operand '" + operands[2] + "'" + TRY, 2)
  return compareFiles(null, operands[0]!, operands[1]!)
}

export const diffCommands: Record<string, CommandHandler> = { diff }

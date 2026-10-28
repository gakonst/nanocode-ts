import { CommandError, type CommandHandler } from '../Shell.ts'
import { FsError } from '../../FileSystem.ts'
import { decode, encode, parentOf } from '../Fs.ts'
import { options } from './util.ts'
import { mkdirs } from './files.ts'

type Hunk = { oldStart: number; old: string[]; next: string[]; oldEol: boolean; newEol: boolean }

type FilePatch = { from: string; to: string; hunks: Hunk[] }

function headerPath(line: string): string {
  let path = line.slice(4).split('\t')[0].trim()
  if (path.startsWith('"') && path.endsWith('"')) path = JSON.parse(path) as string
  return path
}

function parsePatch(text: string): FilePatch[] {
  const lines = text.split('\n')
  const patches: FilePatch[] = []
  let current: FilePatch | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      current = { from: headerPath(line), to: headerPath(lines[i + 1]), hunks: [] }
      patches.push(current)
      i++
      continue
    }
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (!header || !current) continue
    let oldCount = header[2] === undefined ? 1 : Number(header[2])
    let newCount = header[4] === undefined ? 1 : Number(header[4])
    const hunk: Hunk = {
      oldStart: Number(header[1]),
      old: [],
      next: [],
      oldEol: true,
      newEol: true,
    }
    let last = ''
    while (
      (oldCount > 0 || newCount > 0 || lines[i + 1]?.startsWith('\\')) &&
      i + 1 < lines.length
    ) {
      const body = lines[++i]
      if (body.startsWith('\\')) {
        if (last === '-' || last === ' ') hunk.oldEol = false
        if (last === '+' || last === ' ') hunk.newEol = false
        continue
      }
      const kind = body === '' ? ' ' : body[0]
      const content = body.slice(1)
      last = kind
      if (kind === ' ') {
        hunk.old.push(content)
        hunk.next.push(content)
        oldCount--
        newCount--
      } else if (kind === '-') {
        hunk.old.push(content)
        oldCount--
      } else if (kind === '+') {
        hunk.next.push(content)
        newCount--
      } else {
        i--
        break
      }
    }
    current.hunks.push(hunk)
  }
  return patches
}

function strip(path: string, count: number | undefined): string {
  if (count === undefined) return path.split('/').pop() ?? path
  return path
    .split('/')
    .filter((_, index) => index >= count)
    .join('/')
}

function find(lines: string[], block: string[], start: number): number {
  const fits = (at: number) =>
    at >= 0 &&
    at + block.length <= lines.length &&
    block.every((line, index) => lines[at + index] === line)
  for (let delta = 0; delta <= lines.length; delta++) {
    if (fits(start + delta)) return start + delta
    if (delta && fits(start - delta)) return start - delta
  }
  return -1
}

export const patch: CommandHandler = async (ctx) => {
  const parsed = options(ctx.args, {
    flags: 'REfsNtu',
    values: 'pidrBo',
    long: {
      reverse: 'R',
      forward: 'N',
      'dry-run': 'n',
      silent: 's',
      quiet: 's',
      force: 'f',
      strip: 'p',
      input: 'i',
      directory: 'd',
      unified: 'u',
      batch: 't',
      'no-backup-if-mismatch': '',
    },
  })
  const level = parsed.values.get('p')?.at(-1)
  const strips = level === undefined ? undefined : Number(level)
  const reverse = parsed.flags.has('R')
  const dry = parsed.flags.has('n')
  const quiet = parsed.flags.has('s')
  const base = parsed.values.get('d')?.at(-1)
  const resolve = (path: string) => ctx.resolve(base ? base + '/' + path : path)
  const input =
    parsed.values.get('i')?.at(-1) ?? (parsed.operands.length > 1 ? parsed.operands[1] : undefined)
  let text: string
  try {
    text =
      input === undefined || input === '-'
        ? ctx.stdin.read()
        : decode(await ctx.fs.read(ctx.resolve(input)))
  } catch (error) {
    if (error instanceof FsError)
      throw new CommandError("can't open patch file " + input + ': No such file or directory', 2)
    throw error
  }
  const patches = parsePatch(text)
  if (!patches.length) {
    ctx.stderr.write('patch: **** Only garbage was found in the patch input.\n')
    return 2
  }
  let status = 0
  for (const file of patches) {
    const from = reverse ? file.to : file.from
    const to = reverse ? file.from : file.to
    const target = parsed.operands[0] ?? strip(from === '/dev/null' ? to : from, strips)
    const path = resolve(target)
    const creating = from === '/dev/null'
    const deleting = to === '/dev/null'
    let original = ''
    if (!creating) {
      try {
        original = decode(await ctx.fs.read(path))
      } catch (error) {
        if (!(error instanceof FsError)) throw error
        ctx.stderr.write("patch: **** Can't find file " + target + ' : No such file or directory\n')
        status = 1
        continue
      }
    }
    if (!quiet) ctx.stdout.write((dry ? 'checking file ' : 'patching file ') + target + '\n')
    const lines = original === '' ? [] : original.split('\n')
    let eol = original === '' || original.endsWith('\n')
    if (eol && lines.length) lines.pop()
    let offset = 0
    let failed = 0
    let rejects = '--- ' + file.from + '\n+++ ' + file.to + '\n'
    file.hunks.forEach((hunk, index) => {
      const old = reverse ? hunk.next : hunk.old
      const next = reverse ? hunk.old : hunk.next
      const expected = Math.max(0, hunk.oldStart - (old.length ? 1 : 0) + offset)
      const at = old.length ? find(lines, old, expected) : Math.min(expected, lines.length)
      if (at < 0) {
        failed++
        ctx.stdout.write('Hunk #' + (index + 1) + ' FAILED at ' + hunk.oldStart + '.\n')
        rejects +=
          '@@ -' +
          hunk.oldStart +
          ',' +
          hunk.old.length +
          ' +' +
          hunk.oldStart +
          ',' +
          hunk.next.length +
          ' @@\n' +
          hunk.old.map((line) => '-' + line + '\n').join('') +
          hunk.next.map((line) => '+' + line + '\n').join('')
        return
      }
      if (at !== expected && !quiet)
        ctx.stdout.write(
          'Hunk #' +
            (index + 1) +
            ' succeeded at ' +
            (at + 1) +
            ' (offset ' +
            (at - expected) +
            ' line' +
            (Math.abs(at - expected) === 1 ? '' : 's') +
            ').\n',
        )
      lines.splice(at, old.length, ...next)
      offset += next.length - old.length + (at - expected)
      if (at + next.length >= lines.length) eol = reverse ? hunk.oldEol : hunk.newEol
    })
    if (failed) {
      ctx.stdout.write(
        failed +
          ' out of ' +
          file.hunks.length +
          ' hunk' +
          (file.hunks.length === 1 ? '' : 's') +
          ' FAILED' +
          (dry ? '' : ' -- saving rejects to file ' + target + '.rej') +
          '\n',
      )
      status = 1
      if (!dry) await ctx.fs.write(path + '.rej', encode(rejects))
      continue
    }
    if (dry) continue
    if (deleting && !lines.length) {
      await ctx.fs.remove(path)
      continue
    }
    await mkdirs(ctx.fs, parentOf(path))
    await ctx.fs.write(path, encode(lines.join('\n') + (lines.length && eol ? '\n' : '')))
  }
  return status
}

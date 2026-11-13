import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { root } from './wasm.mjs'

export const pin = JSON.parse(readFileSync(join(root, 'python-revision.json'), 'utf8'))

const paths = ['Cargo.toml', 'Cargo.lock', 'crates/core', 'crates/patches']

const maxDataSegments = 100_000
const pageBytes = 65536
const segmentHeader = 1 + 1 + 5 + 1 + 5

export const warm = String.raw`import sys, os, io, json, re, collections, itertools, functools, math, string, pathlib, datetime, textwrap, csv, base64, struct, dataclasses, enum, typing, argparse, hashlib, shutil, glob, fnmatch, heapq, bisect, copy, operator, decimal, fractions, urllib.parse, html, difflib, pprint, time, contextlib, abc, traceback, zlib, gzip, binascii, unicodedata, codecs, locale, ast, tokenize, inspect, types, weakref, numbers
assert not {'random', '_random', 'tempfile', 'uuid', 'secrets'} & set(sys.modules), sorted(sys.modules)
json.loads(json.dumps({"a": [1, 2.5, "x", None]}))
re.compile(r"\w+").findall("a b c")
`

function run(command, cwd) {
  const result = spawnSync(command[0], command.slice(1), { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function source() {
  if (process.env.NANOCODE_PYTHON_SOURCE) return process.env.NANOCODE_PYTHON_SOURCE
  const directory = join(root, 'target', 'python-source', pin.revision)
  if (existsSync(join(directory, 'crates', 'core', 'python', 'Cargo.toml'))) return directory
  const sdk = join(root, '..', 'nanocodex')
  const held = spawnSync('git', ['cat-file', '-e', pin.revision + '^{commit}'], { cwd: sdk })
  if (held.status !== 0) run(['git', 'fetch', '--depth', '1', pin.repository, pin.revision], sdk)
  const partial = directory + '.partial'
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(partial, { recursive: true })
  run(['sh', '-c', 'revision=$1; shift; git archive "$revision" "$@" | tar -x -C "$0"', partial, pin.revision, ...paths], sdk)
  renameSync(partial, directory)
  return directory
}

function link(target) {
  const path = join(root, 'target', 'python-sdk')
  const current = (() => {
    try {
      return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  })()
  if (current === target) return
  rmSync(path, { recursive: true, force: true })
  mkdirSync(join(root, 'target'), { recursive: true })
  symlinkSync(target, path)
}

export function build() {
  link(source())
  const result = spawnSync(
    'cargo',
    ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--target-dir', '../target/python'],
    { cwd: join(root, 'python'), stdio: 'inherit' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return join(root, 'target', 'python', 'wasm32-unknown-unknown', 'release', 'nanocode_python_wasm.wasm')
}

function leb(bytes, at) {
  let value = 0
  let shift = 0
  for (;;) {
    const byte = bytes[at++]
    value += (byte & 0x7f) * 2 ** shift
    shift += 7
    if (byte < 0x80) return [value, at]
  }
}

function uleb(value) {
  const out = []
  do {
    let byte = value % 128
    value = Math.floor(value / 128)
    if (value > 0) byte |= 0x80
    out.push(byte)
  } while (value > 0)
  return out
}

function sleb(value) {
  const out = []
  for (;;) {
    const byte = value & 0x7f
    value >>= 7
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
      out.push(byte)
      return out
    }
    out.push(byte | 0x80)
  }
}

function expression(bytes, at) {
  for (;;) {
    const op = bytes[at++]
    if (op === 0x0b) return at
    if (op === 0x41 || op === 0x42) while (bytes[at++] >= 0x80);
    else if (op === 0x43) at += 4
    else if (op === 0x44) at += 8
    else if (op === 0x23) at = leb(bytes, at)[1]
    else throw new Error('python.wasm has a constant expression with opcode ' + op)
  }
}

function join8(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function segments(memory) {
  const runs = []
  let at = 0
  while (at < memory.length) {
    while (at < memory.length && memory[at] === 0) at++
    if (at === memory.length) break
    let end = at
    let zeros = 0
    while (end < memory.length) {
      if (memory[end] !== 0) zeros = 0
      else if (++zeros > segmentHeader) {
        end++
        break
      }
      end++
    }
    runs.push([at, end - zeros])
    at = end
  }
  if (runs.length <= maxDataSegments) return runs
  const gaps = runs.slice(1).map((run, index) => run[0] - runs[index][1]).sort((a, b) => a - b)
  const widest = gaps[runs.length - maxDataSegments - 1]
  const merged = [runs[0]]
  for (const run of runs.slice(1)) {
    const last = merged[merged.length - 1]
    if (run[0] - last[1] <= widest) last[1] = run[1]
    else merged.push(run)
  }
  return merged
}

function warmed(module) {
  let exports
  const view = (ptr, len) => new Uint8Array(exports.memory.buffer, ptr >>> 0, len >>> 0)
  const reply = (data) => {
    view(exports.python_reply(data.length), data.length).set(data)
    return BigInt(data.length)
  }
  const root = new Uint8Array(24)
  new DataView(root.buffer).setUint32(0, 1, true)
  new DataView(root.buffer).setUint32(4, 0o755, true)
  const imports = {
    python: {
      host_fs: (op, path, len) => (op === 0 && len === 1 && view(path, 1)[0] === 0x2f ? reply(root) : op === 0 || op === 1 || op === 3 ? -2n : -30n),
      host_now: () => performance.now(),
      host_panic(ptr, len) {
        throw new Error('python.wasm panicked: ' + new TextDecoder().decode(view(ptr, len)))
      },
      host_random(ptr, len) {
        for (let at = 0; at < len; at += 65536) crypto.getRandomValues(view(ptr + at, Math.min(65536, len - at)))
      },
      host_stopped: () => 0,
      host_time: () => Date.now(),
    },
  }
  exports = new WebAssembly.Instance(module, imports).exports
  const text = new TextEncoder()
  const field = (bytes) => [...new Uint8Array(new Uint32Array([bytes.length]).buffer), ...bytes]
  const u64 = (value) => [...new Uint8Array(new BigUint64Array([value]).buffer)]
  const request = Uint8Array.from([
    ...new Uint8Array(new Uint32Array([2]).buffer),
    ...field(text.encode('-c')),
    ...field(text.encode(warm)),
    ...field(text.encode('/')),
    ...new Uint8Array(new Uint32Array([0]).buffer),
    ...field([]),
    ...u64(1n << 20n),
    ...u64(0n),
    ...u64(2n ** 64n - 1n),
    ...u64(2n ** 64n - 1n),
    ...u64(1000n),
    ...u64(2n ** 64n - 1n),
  ])
  view(exports.python_input(request.length), request.length).set(request)
  const len = exports.python_run()
  const out = view(exports.python_output(), len).slice()
  const data = new DataView(out.buffer)
  if (data.getUint32(0, true) !== 0 || data.getUint32(4, true) !== 0) {
    const stdout = data.getUint32(8, true)
    throw new Error('the warm-up run ended with ' + data.getUint32(0, true) + '/' + data.getUint32(4, true) + ': ' + new TextDecoder().decode(out.subarray(12 + stdout)))
  }
  return new Uint8Array(exports.memory.buffer)
}

export function bake(bytes) {
  const memory = warmed(new WebAssembly.Module(bytes))
  const runs = segments(memory)
  const parts = [bytes.subarray(0, 8)]
  let at = 8
  while (at < bytes.length) {
    const begin = at
    const id = bytes[at]
    const [size, start] = leb(bytes, at + 1)
    const body = bytes.subarray(start, start + size)
    at = start + size
    if (id === 8) throw new Error('python.wasm has a start function')
    if (id === 5) {
      const [count, limits] = leb(body, 0)
      if (count !== 1 || body[limits] > 1) throw new Error('python.wasm has an unexpected memory section')
      const [, rest] = leb(body, limits + 1)
      const replaced = [1, body[limits], ...uleb(memory.length / pageBytes), ...body.subarray(rest)]
      parts.push(Uint8Array.from([5, ...uleb(replaced.length), ...replaced]))
      continue
    }
    if (id === 6) {
      let [count, cursor] = leb(body, 0)
      let mutable = 0
      for (; count > 0; count--) {
        mutable += body[cursor + 1]
        cursor = expression(body, cursor + 2)
      }
      if (mutable !== 1) throw new Error('python.wasm has ' + mutable + ' mutable globals, and the snapshot restores only the stack pointer')
    }
    if (id === 11) {
      const data = join8([Uint8Array.from(uleb(runs.length)), ...runs.flatMap(([from, to]) => [Uint8Array.from([0, 0x41, ...sleb(from), 0x0b, ...uleb(to - from)]), memory.subarray(from, to)])])
      parts.push(Uint8Array.from([11, ...uleb(data.length)]), data)
      continue
    }
    if (id === 12) {
      const count = uleb(runs.length)
      parts.push(Uint8Array.from([12, ...uleb(count.length), ...count]))
      continue
    }
    parts.push(bytes.subarray(begin, at))
  }
  return join8(parts)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(build())

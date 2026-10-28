import { fingerprint } from '../../fingerprint.ts'
import type { Pyodide } from './python.ts'

export const SNAPSHOT_PACKAGES = ['numpy', 'matplotlib']

const WORKLOAD = String.raw`
import os
os.environ["MPLBACKEND"] = "Agg"
import io, gc
import numpy, numpy.linalg, numpy.fft, numpy.random
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
figure, axes = plt.subplots()
axes.plot([0, 1, 2], [0, 1, 4], label="y")
axes.set_title("x")
axes.legend()
figure.savefig(io.BytesIO(), format="png")
plt.close(figure)
del figure, axes
gc.collect()
`

const MAGIC = 'NCPYSNAP'

const FORMAT = 1

export type SnapshotMeta = {
  format: number
  pyodide: string
  libs: [string, string][]
  handles: [number, string][]
  streams: { fd: number; path: string; flags: number; position: number }[]
  layout: number[]
  table: number
  heap: number
  header: number
  files: [string, number][]
  packages: [string, string][]
}

export type PyodideLoader = {
  loadPyodide(config: Record<string, unknown>): Promise<unknown>
  createPyodideModule(settings: Record<string, unknown>): Promise<unknown>
}

type Dso = { name: string; refcount: number; global: boolean; exports: unknown }

type Stream = { fd: number; path: string; flags: number; position: number } | null

type Emscripten = {
  HEAPU8: Uint8Array
  HEAPU32: Uint32Array
  wasmTable: WebAssembly.Table
  LDSO: { loadedLibsByName: Record<string, Dso>; loadedLibsByHandle: Record<number, Dso> }
  newDSO(name: string, handle: undefined, syms: string): Dso
  loadWebAssemblyModule(
    binary: WebAssembly.Module,
    flags: Record<string, unknown>,
    name: string,
    scope: Record<string, unknown>,
    handle: undefined,
  ): unknown
  _emscripten_get_sbrk_ptr(): number
  _emscripten_stack_get_current(): number
  __hiwire_get(index: number): Record<string, unknown>
  FS: {
    streams: Stream[]
    open(path: string, flags: number): { fd: number; position: number }
    readdir(path: string): string[]
    lstat(path: string): { mode: number; size: number }
    isDir(mode: number): boolean
    isFile(mode: number): boolean
    readFile(path: string): Uint8Array
    writeFile(path: string, data: Uint8Array, options?: { mode?: number }): void
    mkdirTree(path: string): void
  }
}

type Instance = Pyodide & {
  _module: Emscripten
  loadedPackages: Record<string, string>
  makeMemorySnapshot(): Uint8Array
}

const SKIP = ['/dev', '/proc', '/tmp', '/home']

function wrap(
  loader: PyodideLoader,
  hook: (module: Emscripten) => void,
  after?: (module: Emscripten) => Promise<void>,
): (settings: Record<string, unknown>) => Promise<unknown> {
  return async (settings) => {
    const previous = settings.preRun as
      | ((module: unknown) => void)
      | ((module: unknown) => void)[]
      | undefined
    let ran = false
    let failure: { error: unknown } | undefined
    settings.preRun = [
      () => {
        ran = true
        try {
          hook(settings as unknown as Emscripten)
        } catch (error) {
          failure = { error }
        }
      },
      ...(Array.isArray(previous) ? previous : previous ? [previous] : []),
    ]
    const module = await loader.createPyodideModule(settings)
    if (failure) throw failure.error
    if (!ran) throw new Error('Pyodide snapshot: the runtime started without its hook')
    if (after) await after(module as Emscripten)
    return module
  }
}

function preload(
  module: Emscripten,
  libs: [string, WebAssembly.Module][],
  ctors: (() => void)[],
): number[] {
  const layout = [module.wasmTable.length, sbrk(module)]
  const Original = WebAssembly.Instance
  const replacement = function (compiled: WebAssembly.Module, imports: WebAssembly.Imports) {
    if (!imports['GOT.mem']) return new Original(compiled, imports)
    const env = imports.env as Record<string, unknown>
    layout.push(Number(env.__memory_base), Number(env.__table_base))
    const instance = new Original(compiled, imports)
    const exports: Record<string, unknown> = { ...instance.exports }
    const ctor = exports.__wasm_call_ctors as (() => void) | undefined
    if (ctor) ctors.push(ctor)
    delete exports.__wasm_call_ctors
    return { exports }
  }
  ;(WebAssembly as unknown as Record<string, unknown>).Instance = replacement
  try {
    for (const [path, compiled] of libs) {
      if (module.LDSO.loadedLibsByName[path]) continue
      const dso = module.newDSO(path, undefined, 'loading')
      dso.refcount = 1
      dso.global = false
      dso.exports = module.loadWebAssemblyModule(
        compiled,
        {
          global: false,
          nodelete: false,
          loadAsync: false,
          rpath: { parentLibPath: path, paths: [] },
        },
        path,
        {},
        undefined,
      )
    }
  } finally {
    ;(WebAssembly as unknown as Record<string, unknown>).Instance = Original
  }
  return layout
}

function sbrk(module: Emscripten): number {
  return module.HEAPU32[module._emscripten_get_sbrk_ptr() >>> 2]!
}

function grow(module: Emscripten, bytes: number): void {
  if (module.HEAPU8.length >= bytes) return
  const resize = (
    module.LDSO.loadedLibsByName.__main__?.exports as Record<string, unknown> | undefined
  )?.emscripten_resize_heap as ((bytes: number) => boolean) | undefined
  if (!resize?.(bytes) || module.HEAPU8.length < bytes)
    throw new Error('Pyodide snapshot: cannot grow memory to ' + bytes + ' bytes')
}

function walk(module: Emscripten, path: string, out: [string, number][]): void {
  for (const name of module.FS.readdir(path).sort()) {
    if (name === '.' || name === '..') continue
    const full = (path === '/' ? '' : path) + '/' + name
    if (SKIP.includes(full)) continue
    const stat = module.FS.lstat(full)
    if (module.FS.isDir(stat.mode)) walk(module, full, out)
    else if (module.FS.isFile(stat.mode)) out.push([full, stat.size])
  }
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

export async function snapshotPyodide(
  loader: PyodideLoader,
  config: Record<string, unknown>,
  version: string,
): Promise<{ meta: SnapshotMeta; chunks: Uint8Array[] }> {
  const quiet = { messageCallback: () => {}, errorCallback: () => {} }
  const probe = (await loader.loadPyodide({ ...config })) as Instance
  const booted: [string, number][] = []
  walk(probe._module, '/', booted)
  const before = new Set(booted.map(([path]) => path))
  await probe.loadPackage(SNAPSHOT_PACKAGES, quiet)
  const installed: [string, number][] = []
  walk(probe._module, '/', installed)
  const files = installed
    .filter(([path]) => !before.has(path))
    .map(([path]) => [path, probe._module.FS.readFile(path).slice()] as const)
  const packages = Object.entries(probe.loadedPackages).map(
    ([name, channel]) => [name, String(channel)] as [string, string],
  )
  const names = Object.keys(probe._module.LDSO.loadedLibsByName).filter(
    (name) => name !== '__main__',
  )
  const libs = names.map((name) => [name, probe._module.FS.readFile(name).slice()] as const)
  const Compile = WebAssembly.Module as unknown as new (bytes: Uint8Array) => WebAssembly.Module
  const compiled = libs.map(
    ([name, bytes]) => [name, new Compile(bytes)] as [string, WebAssembly.Module],
  )
  const ctors: (() => void)[] = []
  let preloaded = 0
  let layout: number[] = []
  const pyodide = (await loader.loadPyodide({
    ...config,
    _makeSnapshot: true,
    createPyodideModule: wrap(loader, (module) => {
      layout = preload(module, compiled, ctors)
      preloaded = module.wasmTable.length
    }),
  })) as Instance
  for (const ctor of ctors) ctor()
  const module = pyodide._module
  for (const [path, bytes] of files) {
    module.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/')
    module.FS.writeFile(path, bytes)
  }
  pyodide.runPython(WORKLOAD)
  const extra = Object.keys(module.LDSO.loadedLibsByName).filter(
    (name) => name !== '__main__' && !names.includes(name),
  )
  if (extra.length)
    throw new Error('Pyodide snapshot: libraries loaded outside the preload: ' + extra.join(', '))
  for (let index = preloaded; index < module.wasmTable.length; index++)
    if (module.wasmTable.get(index) !== null)
      throw new Error('Pyodide snapshot: table slot ' + index + ' was filled after the preload')
  const heap = sbrk(module)
  if (module._emscripten_stack_get_current() >= heap)
    throw new Error('Pyodide snapshot: the stack is above the heap')
  const image = pyodide.makeMemorySnapshot()
  const header = image
    .subarray(0, new DataView(image.buffer, image.byteOffset).getUint32(4, true))
    .slice()
  const kept = files.filter(([path]) => !names.includes(path))
  const meta: SnapshotMeta = {
    format: FORMAT,
    pyodide: version,
    libs: libs.map(([name, bytes]) => [name, fingerprint(bytes)]),
    handles: Object.entries(module.LDSO.loadedLibsByHandle).map(([handle, dso]) => [
      Number(handle),
      dso.name,
    ]),
    streams: module.FS.streams.flatMap((stream, fd) =>
      stream && fd > 2
        ? [{ fd, path: stream.path, flags: stream.flags, position: stream.position }]
        : [],
    ),
    layout,
    table: module.wasmTable.length,
    heap,
    header: header.length,
    files: kept.map(([path, bytes]) => [path, bytes.length]),
    packages,
  }
  const encoded = new TextEncoder().encode(JSON.stringify(meta))
  return {
    meta,
    chunks: [
      new TextEncoder().encode(MAGIC),
      u32(encoded.length),
      encoded,
      header,
      module.HEAPU8.slice(0, heap),
      ...kept.map(([, bytes]) => bytes),
    ],
  }
}

class Reader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  #chunk: Uint8Array = new Uint8Array()
  #offset = 0

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader()
  }

  async into(target: Uint8Array): Promise<void> {
    let filled = 0
    while (filled < target.length) {
      if (this.#offset >= this.#chunk.length) {
        const next = await this.#reader.read()
        if (next.done) throw new Error('Pyodide snapshot: the snapshot ended early')
        this.#chunk = next.value
        this.#offset = 0
        continue
      }
      const count = Math.min(target.length - filled, this.#chunk.length - this.#offset)
      target.set(this.#chunk.subarray(this.#offset, this.#offset + count), filled)
      this.#offset += count
      filled += count
    }
  }

  async bytes(length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length)
    await this.into(out)
    return out
  }

  async end(): Promise<void> {
    if (this.#offset < this.#chunk.length || !(await this.#reader.read()).done)
      throw new Error('Pyodide snapshot: unexpected bytes after the snapshot')
  }

  cancel(): void {
    this.#reader.cancel().catch(() => {})
  }
}

export async function restorePyodide(
  loader: PyodideLoader,
  config: Record<string, unknown>,
  stream: ReadableStream<Uint8Array>,
  resolve: (key: string, path: string) => WebAssembly.Module | Promise<WebAssembly.Module>,
  version: string,
): Promise<Pyodide> {
  const reader = new Reader(stream)
  try {
    const magic = new TextDecoder().decode(await reader.bytes(MAGIC.length))
    if (magic !== MAGIC) throw new Error('Pyodide snapshot: not a snapshot')
    const length = new DataView((await reader.bytes(4)).buffer).getUint32(0, true)
    const meta = JSON.parse(new TextDecoder().decode(await reader.bytes(length))) as SnapshotMeta
    if (meta.format !== FORMAT || meta.pyodide !== version)
      throw new Error(
        'Pyodide snapshot: made for Pyodide ' + meta.pyodide + ' format ' + meta.format,
      )
    const header = await reader.bytes(meta.header)
    const libs = await Promise.all(
      meta.libs.map(
        async ([path, key]) => [path, await resolve(key, path)] as [string, WebAssembly.Module],
      ),
    )
    const pyodide = (await loader.loadPyodide({
      ...config,
      _loadSnapshot: header,
      createPyodideModule: wrap(
        loader,
        (module) => {
          const layout = preload(module, libs, [])
          if (layout.join() !== meta.layout.join())
            throw new Error(
              'Pyodide snapshot: libraries landed at ' +
                JSON.stringify(layout) +
                ', not ' +
                JSON.stringify(meta.layout),
            )
          grow(module, meta.heap)
          if (module.wasmTable.length < meta.table)
            module.wasmTable.grow(meta.table - module.wasmTable.length)
          if (module.wasmTable.length !== meta.table)
            throw new Error(
              'Pyodide snapshot: the function table has ' +
                module.wasmTable.length +
                ' slots, not ' +
                meta.table,
            )
        },
        (module) => reader.into(module.HEAPU8.subarray(0, meta.heap)),
      ),
    })) as Instance
    const module = pyodide._module
    for (const [handle, name] of meta.handles)
      module.LDSO.loadedLibsByHandle[handle] = module.LDSO.loadedLibsByName[name]!
    const made = new Set<string>()
    const place = (path: string, data: Uint8Array) => {
      const parent = path.slice(0, path.lastIndexOf('/')) || '/'
      if (!made.has(parent)) {
        module.FS.mkdirTree(parent)
        made.add(parent)
      }
      module.FS.writeFile(path, data)
    }
    for (const [path, size] of meta.files) place(path, await reader.bytes(size))
    await reader.end()
    for (const [path] of meta.libs) place(path, new Uint8Array())
    for (const stream of meta.streams) {
      const opened = module.FS.open(stream.path, stream.flags)
      if (opened.fd !== stream.fd)
        throw new Error(
          'Pyodide snapshot: ' + stream.path + ' opened as fd ' + opened.fd + ', not ' + stream.fd,
        )
      opened.position = stream.position
    }
    for (const [name, channel] of meta.packages) pyodide.loadedPackages[name] = channel
    return pyodide
  } catch (error) {
    reader.cancel()
    throw error
  }
}

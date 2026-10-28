import { fingerprint } from '../../fingerprint.ts'
import {
  HELPER,
  type Pyodide,
  type PyodideFS,
  type PythonReply,
  type PythonRequest,
} from './python.ts'

type Stat = { mode: number; size: number; mtime: Date | number }

type Tracking = { dirty: Set<string>; gone: Set<string> }

type FS = PyodideFS & {
  lstat(path: string): Stat
  isLink(mode: number): boolean
  cwd(): string
  trackingDelegate: Record<string, unknown>
  truncate(path: unknown, length: number): void
}

type Runner = {
  pyodide: Pyodide
  fs: FS
  start: (request: string) => PromiseLike<unknown>
  cancel: () => unknown
  micropip: boolean
  installed: Set<string>
  tracking: Tracking | null
}

const WRITES = 1 | 2 | 64 | 512 | 1024

function track(runner: Runner): void {
  const { fs } = runner
  const absolute = (path: string) =>
    path.startsWith('/') ? path : (fs.cwd() === '/' ? '' : fs.cwd()) + '/' + path
  const delegate = fs.trackingDelegate
  delegate.onOpenFile = (path: string, flags: number) => {
    if (runner.tracking && flags & WRITES) runner.tracking.dirty.add(absolute(path))
  }
  delegate.onWriteToFile = (path: string) => runner.tracking?.dirty.add(absolute(path))
  delegate.onMovePath = (from: string, to: string) => {
    runner.tracking?.gone.add(absolute(from))
    runner.tracking?.dirty.add(absolute(to))
  }
  delegate.onDeletePath = (path: string) => runner.tracking?.gone.add(absolute(path))
  const truncate = fs.truncate.bind(fs)
  fs.truncate = (path: unknown, length: number) => {
    if (typeof path === 'string') runner.tracking?.dirty.add(absolute(path))
    truncate(path, length)
  }
}

const ALLOWED = ['/workspace', '/tmp', '/home/user']
const LIMIT = 4 * 1024 * 1024
const REPLY_BYTES = 6 * 1024 * 1024
const LARGE_BYTES = 6 * 1024 * 1024
const decoder = new TextDecoder('utf-8')

function allowed(path: string): boolean {
  return ALLOWED.some((root) => path === root || path.startsWith(root + '/'))
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/')
}

function join(base: string, name: string): string {
  return base === '/' ? '/' + name : base + '/' + name
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

function kind(fs: FS, path: string): 'dir' | 'file' | 'link' | 'other' | undefined {
  try {
    const stat = fs.lstat(path)
    return fs.isLink(stat.mode)
      ? 'link'
      : fs.isDir(stat.mode)
        ? 'dir'
        : fs.isFile(stat.mode)
          ? 'file'
          : 'other'
  } catch {
    return undefined
  }
}

function names(fs: FS, path: string): string[] {
  return fs
    .readdir(path)
    .filter((name) => name !== '.' && name !== '..')
    .sort()
}

function remove(fs: FS, path: string): void {
  const found = kind(fs, path)
  if (found === 'dir') {
    for (const name of names(fs, path)) remove(fs, join(path, name))
    fs.rmdir(path)
  } else if (found) fs.unlink(path)
}

function mkdirs(fs: FS, path: string): void {
  if (kind(fs, path) !== 'dir') fs.mkdirTree(path)
}

function stamp(fs: FS, path: string): string | undefined {
  if (kind(fs, path) !== 'file') return undefined
  return fingerprint(fs.readFile(path))
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

function unbase64(text: string): Uint8Array {
  const raw = atob(text)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function same(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function text(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(Math.min(total, LIMIT))
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= bytes.length) break
    const part = chunk.subarray(0, bytes.length - offset)
    bytes.set(part, offset)
    offset += part.length
  }
  return decoder.decode(bytes) + (total > LIMIT ? '\n[output truncated]\n' : '')
}

export type PythonServerState = {
  load(): Promise<string[][] | undefined>
  save(installs: string[][]): Promise<void>
}

export function pythonServer(
  load: () => Promise<Pyodide>,
): (request: PythonRequest, state?: PythonServerState) => Promise<PythonReply> {
  let runner: Promise<Runner> | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let mirror: string | undefined
  const stamps = new Map<string, string | undefined>()

  const boot = (): Promise<Runner> => {
    runner ??= (async () => {
      const pyodide = await load()
      const fs = pyodide.FS as FS
      for (const root of ALLOWED) mkdirs(fs, root)
      const namespace = (pyodide.globals.get('dict') as () => { get(name: string): unknown })()
      pyodide.runPython(HELPER, { globals: namespace })
      const created: Runner = {
        pyodide,
        fs,
        start: namespace.get('start') as Runner['start'],
        cancel: namespace.get('cancel') as Runner['cancel'],
        micropip: false,
        installed: new Set<string>(),
        tracking: null,
      }
      track(created)
      return created
    })()
    runner.catch(() => {
      runner = undefined
    })
    return runner
  }

  const wipe = (fs: FS) => {
    for (const root of ALLOWED) {
      if (kind(fs, root) !== 'dir') continue
      for (const name of names(fs, root)) remove(fs, join(root, name))
    }
    stamps.clear()
  }

  const place = (fs: FS, files: [string, string][], dirs: string[], append: boolean) => {
    for (const path of [...dirs].sort()) if (allowed(path)) mkdirs(fs, path)
    for (const [path, data] of files) {
      if (!allowed(path)) continue
      mkdirs(fs, parentOf(path))
      if (kind(fs, path) === 'dir') remove(fs, path)
      const bytes = unbase64(data)
      if (append && kind(fs, path) === 'file') {
        const before = fs.readFile(path)
        const joined = new Uint8Array(before.length + bytes.length)
        joined.set(before)
        joined.set(bytes, before.length)
        fs.writeFile(path, joined)
      } else fs.writeFile(path, bytes)
      stamps.set(path, stamp(fs, path))
    }
  }

  const prune = (fs: FS, roots: string[], wanted: Set<string>, dirs: Set<string>) => {
    const visit = (path: string) => {
      const found = kind(fs, path)
      if (found === 'dir') {
        for (const name of names(fs, path)) visit(join(path, name))
        if (!dirs.has(path) && !roots.includes(path) && names(fs, path).length === 0) fs.rmdir(path)
        return
      }
      if (found && !wanted.has(path)) {
        fs.unlink(path)
        stamps.delete(path)
      }
    }
    for (const root of roots) visit(root)
  }

  const fetchFiles = (fs: FS, paths: string[], span?: [number, number]) => {
    const files: [string, string][] = [],
      more: string[] = [],
      large: [string, number][] = []
    let budget = REPLY_BYTES
    for (const path of paths) {
      if (!allowed(path) || kind(fs, path) !== 'file') continue
      const data = fs.readFile(path)
      if (span) {
        files.push([path, base64(data.subarray(span[0], span[0] + span[1]))])
        stamps.set(path, fingerprint(data))
        continue
      }
      if (data.length > LARGE_BYTES) {
        large.push([path, data.length])
        continue
      }
      if (budget <= 0) {
        more.push(path)
        continue
      }
      budget -= data.length
      files.push([path, base64(data)])
      stamps.set(path, fingerprint(data))
    }
    return { files, more, large }
  }

  const changed = (fs: FS, roots: string[], touched: Set<string>) => {
    const dirs: string[] = [],
      files: [string, string | null][] = [],
      more: string[] = [],
      large: [string, number][] = []
    const seen = new Set<string>()
    let budget = REPLY_BYTES
    const visit = (path: string) => {
      if (seen.has(path)) return
      seen.add(path)
      const found = kind(fs, path)
      if (found === 'dir') {
        dirs.push(path)
        for (const name of names(fs, path)) visit(join(path, name))
        return
      }
      if (found !== 'file') return
      if (!touched.has(path) && stamps.has(path)) {
        files.push([path, null])
        return
      }
      const data = fs.readFile(path)
      const now = fingerprint(data)
      if (stamps.get(path) === now) {
        files.push([path, null])
        return
      }
      if (data.length > LARGE_BYTES) {
        files.push([path, null])
        large.push([path, data.length])
        stamps.set(path, now)
        return
      }
      if (budget <= 0) {
        files.push([path, null])
        more.push(path)
        return
      }
      budget -= data.length
      files.push([path, base64(data)])
      stamps.set(path, now)
    }
    for (const root of roots) visit(root)
    return { dirs, files, more, large }
  }

  const collect = (fs: FS, roots: string[], before: Map<string, Uint8Array>) => {
    const dirs: string[] = [],
      files: [string, string | null][] = []
    const seen = new Set<string>()
    const visit = (path: string) => {
      if (seen.has(path)) return
      seen.add(path)
      const found = kind(fs, path)
      if (found === 'dir') {
        dirs.push(path)
        for (const name of names(fs, path)) visit(join(path, name))
        return
      }
      if (found !== 'file') return
      const data = fs.readFile(path)
      files.push([path, same(before.get(path), data) ? null : base64(data)])
    }
    for (const root of roots) visit(root)
    return { dirs, files }
  }

  const replay = async (python: Runner, installs: string[][]) => {
    const missing = installs.filter((argv) => !python.installed.has(JSON.stringify(argv)))
    if (!missing.length) return
    const { pyodide } = python
    if (!python.micropip) {
      await pyodide.loadPackage('micropip', { messageCallback: () => {}, errorCallback: () => {} })
      python.micropip = true
    }
    pyodide.setStdout({ write: (buffer: Uint8Array) => buffer.length })
    pyodide.setStderr({ write: (buffer: Uint8Array) => buffer.length })
    for (const argv of missing) {
      await python.start(
        JSON.stringify({
          kind: 'pip',
          target: '',
          argv,
          filename: '',
          cwd: '/home/user',
          env: { HOME: '/home/user' },
          path0: '',
        }),
      )
      python.installed.add(JSON.stringify(argv))
    }
  }

  const execute = async (
    python: Runner,
    request: PythonRequest,
    state?: PythonServerState,
  ): Promise<{ status: number; stdout: string; stderr: string; touched: Set<string> }> => {
    const { pyodide, fs } = python
    const out: Uint8Array[] = [],
      err: Uint8Array[] = []
    const errText = (message: string) => err.push(new TextEncoder().encode(message))
    if (request.kind === 'version')
      return {
        status: 0,
        stdout: 'Python ' + String(pyodide.runPython('import sys; sys.version.split()[0]')) + '\n',
        stderr: '',
        touched: new Set(),
      }
    const cwd = allowed(request.cwd) ? request.cwd : '/workspace'
    mkdirs(fs, cwd)
    let target = request.target
    if (request.kind === 'file') {
      if (kind(fs, request.filename) !== 'file')
        return {
          status: 2,
          stdout: '',
          stderr:
            "python3: can't open file '" +
            request.filename +
            "': [Errno 2] No such file or directory\n",
          touched: new Set(),
        }
      target = decoder.decode(fs.readFile(request.filename))
    }
    const messages = {
      messageCallback: () => {},
      errorCallback: (message: string) => errText(message + '\n'),
    }
    try {
      if (request.kind === 'pip' && !python.micropip) {
        await pyodide.loadPackage('micropip', messages)
        python.micropip = true
      }
      if (request.kind === 'module')
        await pyodide.loadPackagesFromImports('import ' + target, messages)
      else if (request.kind !== 'pip') await pyodide.loadPackagesFromImports(target, messages)
    } catch (error) {
      errText('python3: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    }
    const input = new TextEncoder().encode(request.kind === 'stdin' ? '' : request.stdin)
    let offset = 0
    const sink = (chunks: Uint8Array[]) => ({
      isatty: false,
      write(buffer: Uint8Array) {
        chunks.push(buffer.slice())
        return buffer.length
      },
    })
    pyodide.setStdin({
      isatty: false,
      read(buffer) {
        const count = Math.min(buffer.length, input.length - offset)
        buffer.set(input.subarray(offset, offset + count))
        offset += count
        return count
      },
    })
    pyodide.setStdout(sink(out))
    pyodide.setStderr(sink(err))
    const deadline = Date.now() + Math.max(1000, request.timeoutMs || 30000)
    let quiet = false
    pyodide.setInterruptBuffer({
      get 0() {
        return !quiet && Date.now() > deadline ? 2 : 0
      },
      set 0(_value: number) {},
    })
    const env = {
      ...request.env,
      PWD: cwd,
      HOME: '/home/user',
      MPLBACKEND: 'Agg',
      PYTHONDONTWRITEBYTECODE: '1',
    }
    const path0 =
      request.kind === 'file' ? parentOf(request.filename) : request.kind === 'module' ? cwd : ''
    const timer = setTimeout(
      () => {
        quiet = true
        try {
          python.cancel()
        } catch {}
        quiet = false
      },
      Math.max(0, deadline - Date.now()),
    )
    let status: number
    const tracking: Tracking = { dirty: new Set(), gone: new Set() }
    python.tracking = tracking
    try {
      status = Number(
        await python.start(
          JSON.stringify({
            kind: request.kind,
            target,
            argv: request.argv,
            filename: request.filename,
            cwd,
            env,
            path0,
          }),
        ),
      )
    } finally {
      python.tracking = null
      clearTimeout(timer)
      pyodide.setInterruptBuffer(undefined)
    }
    if (
      request.kind === 'pip' &&
      status === 0 &&
      (request.argv[0] === 'install' || request.argv[0] === 'uninstall')
    ) {
      python.installed.add(JSON.stringify(request.argv))
      if (state) await state.save([...((await state.load()) ?? []), request.argv])
    }
    return {
      status,
      stdout: text(out),
      stderr: text(err),
      touched: new Set([...tracking.dirty, ...tracking.gone]),
    }
  }

  const mirrored = async (
    python: Runner,
    request: PythonRequest,
    roots: string[],
    state?: PythonServerState,
  ): Promise<PythonReply> => {
    const { fs } = python
    const id = request.mirror!
    const empty: PythonReply = {
      status: 0,
      stdout: '',
      stderr: '',
      dirs: [],
      files: [],
      mirror: id,
    }
    if (mirror !== id) {
      wipe(fs)
      mirror = id
    }
    if (request.fetch) return { ...empty, ...fetchFiles(fs, request.fetch, request.range) }
    place(fs, request.files, request.dirs, Boolean(request.append))
    if (request.sync) return empty
    const keep = request.keep ?? []
    const missing = keep.filter(
      (path) => !allowed(path) || stamps.get(path) === undefined || kind(fs, path) !== 'file',
    )
    if (missing.length) return { ...empty, missing }
    prune(
      fs,
      roots,
      new Set([...keep, ...request.files.map(([path]) => path)]),
      new Set(request.dirs),
    )
    const { touched, ...result } = await execute(python, request, state)
    for (const path of touched) if (!roots.some((root) => within(path, root))) stamps.delete(path)
    return { ...empty, ...result, ...changed(fs, roots, touched) }
  }

  const run = async (request: PythonRequest, state?: PythonServerState): Promise<PythonReply> => {
    const roots = request.roots
    const refused = roots.filter((root) => !allowed(root))
    if (refused.length)
      return {
        status: 1,
        stdout: '',
        stderr:
          'python3 runs only under /workspace, /tmp or /home/user, not ' +
          refused.join(', ') +
          '\n',
        dirs: [],
        files: [],
      }
    const python = await boot()
    if (state && request.kind !== 'version') await replay(python, (await state.load()) ?? [])
    if (request.mirror) return mirrored(python, request, roots, state)
    const { fs } = python
    mirror = undefined
    const before = new Map(request.files.map(([path, data]) => [path, unbase64(data)] as const))
    for (const root of roots) {
      if (kind(fs, root) === 'dir') for (const name of names(fs, root)) remove(fs, join(root, name))
      else remove(fs, root)
    }
    for (const path of [...request.dirs].sort()) mkdirs(fs, path)
    for (const [path, data] of before) {
      mkdirs(fs, parentOf(path))
      fs.writeFile(path, data)
    }
    const { touched: _touched, ...result } = await execute(python, request, state)
    return { ...result, ...collect(fs, roots, before) }
  }

  return (request, state) => {
    const next = queue.then(() => run(request, state))
    queue = next.catch(() => {})
    return next
  }
}

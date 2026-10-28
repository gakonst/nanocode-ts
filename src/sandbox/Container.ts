import type * as Contracts from '../Contracts.ts'
import * as Shell from './internal/Shell.ts'

export type Process = {
  readonly stdout: ReadableStream | null
  readonly stderr: ReadableStream | null
  readonly exitCode: Promise<number>
  kill(signal?: number): void
}

export type Instance = string | { vcpu: number; memoryMib: number; diskMb: number }

export type Handle = {
  readonly running: boolean
  start(options?: {
    image?: string
    enableInternet: boolean
    entrypoint?: string[]
    env?: Record<string, string>
    instance?: Instance
  }): void
  exec(
    cmd: string[],
    options?: {
      cwd?: string
      env?: Record<string, string>
      stdin?: ReadableStream
      stdout?: 'pipe' | 'ignore'
      stderr?: 'pipe' | 'ignore' | 'combined'
    },
  ): Promise<Process>
  setInactivityTimeout(durationMs: number): Promise<void>
  destroy(error?: unknown): Promise<void>
}

export type Workspace = Contracts.WorkspaceHost & {
  ready(): Promise<void>
  stop(): Promise<void>
}

export const defaultImage = 'cloudflare/debian-trixie'

export const defaultInactivityTimeoutMs = 10 * 60_000

export const defaultEnv = { DEBIAN_FRONTEND: 'noninteractive', HOME: '/root', LANG: 'C.UTF-8' }

export const defaultSetup =
  'command -v git >/dev/null && command -v python3 >/dev/null && command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl git procps python3 python3-pip python3-venv xz-utils >/dev/null; }'

export function create(container: Handle, options: create.Options = {}): Workspace {
  const cwd = options.cwd ?? Shell.cwd
  const limit = options.outputLimit ?? Shell.outputLimitBytes
  const env = { ...defaultEnv, ...options.env }
  let booting: Promise<void> | undefined

  const exec = async (argv: string[], stdin?: string, at = cwd) => {
    const process = await container.exec(argv, {
      cwd: at,
      env,
      ...(stdin !== undefined ? { stdin: new Blob([stdin]).stream() } : {}),
    })
    const stdout = Shell.collector({ limit: Number.MAX_SAFE_INTEGER })
    const stderr = Shell.collector({ limit: Number.MAX_SAFE_INTEGER })
    const [code] = await Promise.all([
      process.exitCode,
      Shell.drain(process.stdout, { into: stdout }),
      Shell.drain(process.stderr, { into: stderr }),
    ])
    return { code, stdout: stdout.text(), stderr: stderr.text() }
  }

  const boot = async () => {
    if (!container.running)
      container.start({
        image: options.image ?? defaultImage,
        enableInternet: options.enableInternet ?? true,
        entrypoint: ['sleep', 'infinity'],
        env,
        ...(options.instance ? { instance: options.instance } : {}),
      })
    await container.setInactivityTimeout(options.inactivityTimeoutMs ?? defaultInactivityTimeoutMs)

    const setup = options.setup ?? (options.enableInternet === false ? '' : defaultSetup)
    const prepared = await exec(
      ['bash', '-c', 'mkdir -p "$1" && ' + (setup || 'true'), 'bash', cwd],
      undefined,
      '/',
    )
    if (prepared.code !== 0)
      throw new Error(
        'the container setup failed with exit code ' +
          prepared.code +
          ': ' +
          prepared.stderr.slice(-2000),
      )

    for (const [path, content] of Object.entries(options.files ?? {}))
      await write(path, content, false)
  }

  const ready = () => {
    if (!container.running) booting = undefined
    return (booting ??= boot().catch((error) => {
      booting = undefined
      throw error
    }))
  }

  const write = async (path: string, contents: string, wait = true) => {
    if (wait) await ready()
    const result = await exec(
      [
        'bash',
        '-c',
        'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
        'bash',
        Shell.resolve(path, { cwd }),
      ],
      contents,
    )
    if (result.code !== 0)
      throw new Error(
        result.stderr.trim() || 'writing ' + path + ' failed with exit code ' + result.code,
      )
  }

  return {
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ready,
    stop: async () => {
      booting = undefined
      if (container.running) await container.destroy()
    },
    read: async (path) => {
      await ready()
      const result = await exec([
        'bash',
        '-c',
        '[ -d "$1" ] && exit 21; [ -e "$1" ] || exit 44; exec cat -- "$1"',
        'bash',
        Shell.resolve(path, { cwd }),
      ])
      if (result.code === 44) return null
      if (result.code === 21) throw new Error('EISDIR: ' + path + ' is a directory')
      if (result.code !== 0)
        throw new Error(
          result.stderr.trim() || 'reading ' + path + ' failed with exit code ' + result.code,
        )
      return result.stdout
    },
    write: (path, contents) => write(path, contents),
    remove: async (path) => {
      await ready()
      const result = await exec(['rm', '-rf', '--', Shell.resolve(path, { cwd })])
      if (result.code !== 0)
        throw new Error(
          result.stderr.trim() || 'removing ' + path + ' failed with exit code ' + result.code,
        )
    },
    run: async (request, signal) => {
      await ready()
      const stdout = Shell.collector({ limit })
      const stderr = Shell.collector({ limit })
      const started = Date.now()
      const process = await container.exec(
        Shell.argv(request.command, { timeoutMs: request.timeout_ms }),
        {
          cwd: Shell.resolve(request.cwd || cwd, { cwd }),
          env,
          ...(request.stdin !== undefined ? { stdin: new Blob([request.stdin]).stream() } : {}),
        },
      )

      const kill = () => process.kill(15)
      signal.addEventListener('abort', kill, { once: true })
      try {
        const [code] = await Promise.all([
          process.exitCode,
          Shell.drain(process.stdout, { into: stdout }),
          Shell.drain(process.stderr, { into: stderr }),
        ])
        return Shell.output({
          elapsedMs: Date.now() - started,
          exitCode: code,
          stderr,
          stdout,
          timeoutMs: request.timeout_ms,
        })
      } finally {
        signal.removeEventListener('abort', kill)
      }
    },
  }
}

export declare namespace create {
  type Options = {
    cwd?: string
    enableInternet?: boolean
    env?: Record<string, string>
    files?: Record<string, string>
    image?: string
    inactivityTimeoutMs?: number
    instance?: Instance
    instructions?: string
    outputLimit?: number
    setup?: string
  }
}

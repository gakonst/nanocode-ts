/**
 * Workspace host over a Cloudflare Container: it boots the container, prepares the workspace, and
 * runs file operations and shell commands in it.
 *
 * @module
 */
import type * as Contracts from '../Contracts.ts'
import * as Shell from './internal/Shell.ts'

/** Process that a container runs. */
export type Process = {
  /** Standard output, when piped. */
  readonly stdout: ReadableStream | null
  /** Standard error, when piped. */
  readonly stderr: ReadableStream | null
  /** Settles with the exit code of the process. */
  readonly exitCode: Promise<number>
  /** Sends a signal to the process. */
  kill(signal?: number): void
}

/** Instance type of a container: a named type, or explicit resources. */
export type Instance = string | { vcpu: number; memoryMib: number; diskMb: number }

/** Capabilities of the container binding that a workspace uses. */
export type Handle = {
  /** Whether the container runs. */
  readonly running: boolean
  /** Starts the container. */
  start(options?: {
    image?: string
    enableInternet: boolean
    entrypoint?: string[]
    env?: Record<string, string>
    instance?: Instance
  }): void
  /** Runs a process in the container. */
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
  /** Sets the idle time in milliseconds after which the platform stops the container. */
  setInactivityTimeout(durationMs: number): Promise<void>
  /** Stops the container. */
  destroy(error?: unknown): Promise<void>
}

/** Workspace host over a container. */
export type Workspace = Contracts.WorkspaceHost & {
  /** Boots the container and prepares the workspace, once. */
  ready(): Promise<void>
  /** Stops the container. */
  stop(): Promise<void>
}

/** Image that a container starts from by default. */
export const defaultImage = 'cloudflare/debian-trixie'

/** Idle time in milliseconds after which the platform stops a container by default. */
export const defaultInactivityTimeoutMs = 10 * 60_000

/** Environment variables of every command, before the host's own. */
export const defaultEnv = { DEBIAN_FRONTEND: 'noninteractive', HOME: '/root', LANG: 'C.UTF-8' }

/** Setup script that installs the base tools when the container has internet access. */
export const defaultSetup =
  'command -v git >/dev/null && command -v python3 >/dev/null && command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl git procps python3 python3-pip python3-venv xz-utils >/dev/null; }'

/**
 * Returns a workspace host over `container`. The first operation boots the container, runs the
 * setup script, and writes the initial files.
 */
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
    /** Working directory of the workspace. Defaults to `/workspace`. */
    cwd?: string
    /** Whether the container has internet access. Defaults to `true`. */
    enableInternet?: boolean
    /** Environment variables of every command, merged over `defaultEnv`. */
    env?: Record<string, string>
    /** Files to write into the workspace after setup, by path. */
    files?: Record<string, string>
    /** Image to start. Defaults to `defaultImage`. */
    image?: string
    /** Idle time in milliseconds before the platform stops the container. */
    inactivityTimeoutMs?: number
    /** Instance type of the container. */
    instance?: Instance
    /** Workspace instructions for the model. */
    instructions?: string
    /** Largest output in bytes that a command keeps from each stream. Defaults to 4 MiB. */
    outputLimit?: number
    /** Setup script. Defaults to `defaultSetup` with internet access, and to none without it. */
    setup?: string
  }
}

import * as Stream from 'node:stream'
import { Sandbox, type NetworkPolicy, type SandboxRegion } from '@vercel/sandbox'
import type * as Contracts from '../Contracts.ts'
import * as Shell from './internal/Shell.ts'

export type Workspace = Contracts.WorkspaceHost & {
  sandbox(): Promise<Sandbox>
  stop(): Promise<void>
}

export const defaultLeaseMs = 5 * 60_000

export function create(options: create.Options): Workspace {
  const cwd = options.cwd ?? Shell.cwd
  const lease = options.leaseMs ?? defaultLeaseMs
  const limit = options.outputLimit ?? Shell.outputLimitBytes
  let opening: Promise<Sandbox> | undefined

  const prepare = async (sandbox: Sandbox) => {
    const user = await sandbox.getDefaultUser()
    await sandbox.runCommand({
      cmd: 'bash',
      args: [
        '-c',
        'mkdir -p "$1" && chown "$2" "$1"',
        'bash',
        cwd,
        user.username + ':' + user.group,
      ],
      sudo: true,
    })
    const files = Object.entries(options.files ?? {})
    if (files.length)
      await sandbox.writeFiles(
        files.map(([path, content]) => ({ path: Shell.resolve(path, { cwd }), content })),
      )
  }

  const open = () =>
    (opening ??= Sandbox.getOrCreate({
      name: options.name,
      ...options.credentials,
      timeout: lease,
      persistent: options.persistent ?? true,
      ...(options.image ? { image: options.image } : {}),
      ...(options.vcpus ? { resources: { vcpus: options.vcpus } } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.tags ? { tags: options.tags } : {}),
      ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
      ...(options.region ? { region: options.region } : {}),
      onCreate: prepare,
    }).catch((error) => {
      opening = undefined
      throw error
    }))

  const hold = async (sandbox: Sandbox, extra: number) => {
    const expires = sandbox.expiresAt?.getTime()
    if (expires === undefined || expires <= Date.now()) return
    const short = Date.now() + lease + extra - expires
    if (short > 1000) await sandbox.extendTimeout(short).catch(() => {})
  }

  const ready = async (extra = 0) => {
    const sandbox = await open()
    await hold(sandbox, extra)
    return sandbox
  }

  return {
    ...(options.instructions ? { instructions: options.instructions } : {}),
    sandbox: () => open(),
    stop: async () => {
      const current = opening
      opening = undefined
      if (current) await (await current).stop()
    },
    read: async (path) => {
      const sandbox = await ready()
      const buffer = await sandbox.readFileToBuffer({ path: Shell.resolve(path, { cwd }) })
      return buffer === null ? null : new TextDecoder().decode(buffer)
    },
    write: async (path, contents) => {
      const sandbox = await ready()
      const target = Shell.resolve(path, { cwd })
      await sandbox.fs.mkdir(target.slice(0, target.lastIndexOf('/')) || '/', { recursive: true })
      await sandbox.writeFiles([{ path: target, content: contents }])
    },
    remove: async (path) => {
      const sandbox = await ready()
      await sandbox.fs.rm(Shell.resolve(path, { cwd }), { recursive: true, force: true })
    },
    run: async (request, signal) => {
      const sandbox = await ready(request.timeout_ms ?? 0)
      const stdout = Shell.collector({ limit })
      const stderr = Shell.collector({ limit })
      const started = Date.now()
      const [cmd, ...args] = Shell.argv(request.command, { timeoutMs: request.timeout_ms })
      const command = await sandbox.runCommand({
        cmd: cmd!,
        args,
        cwd: Shell.resolve(request.cwd || cwd, { cwd }),
        detached: true,
        ...(request.stdin !== undefined
          ? { stdin: Stream.Readable.from([Buffer.from(request.stdin)]) }
          : {}),
        signal,
      })
      const kill = () => void command.kill('SIGTERM').catch(() => {})
      signal.addEventListener('abort', kill, { once: true })
      const keep = setInterval(() => void hold(sandbox, 0), Math.max(lease / 2, 10_000))
      try {
        for await (const line of command.logs())
          (line.stream === 'stdout' ? stdout : stderr).push(line.data)
        const done = await command.wait()
        return Shell.output({
          elapsedMs: Date.now() - started,
          exitCode: done.exitCode,
          stderr,
          stdout,
          timeoutMs: request.timeout_ms,
        })
      } finally {
        clearInterval(keep)
        signal.removeEventListener('abort', kill)
      }
    },
  }
}

export declare namespace create {
  type Options = {
    credentials?: { token: string; projectId: string; teamId: string }
    cwd?: string
    env?: Record<string, string>
    files?: Record<string, string>
    image?: string
    instructions?: string
    leaseMs?: number
    name: string
    networkPolicy?: NetworkPolicy
    outputLimit?: number
    persistent?: boolean
    region?: SandboxRegion
    tags?: Record<string, string>
    vcpus?: number
  }
}

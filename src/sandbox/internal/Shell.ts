/**
 * Shell helpers that the sandbox workspaces share: output collection, path resolution, and the
 * `timeout` wrapper of each command.
 *
 * @module
 */
import type * as Contracts from '../../Contracts.ts'

/** Working directory of a sandbox workspace. */
export const cwd = '/workspace'

/** Largest output in bytes that a command keeps from each of its streams. */
export const outputLimitBytes = 4 * 1024 * 1024

/** Seconds that `timeout` waits after its signal before it kills a command. */
export const killAfterSeconds = 5

/** Byte collector with a size limit. */
export type Collector = {
  /** Appends a chunk, and drops the bytes past the limit. */
  push(chunk: Uint8Array | string): void
  /** Whether the collector dropped bytes. */
  readonly truncated: boolean
  /** Decodes the kept bytes as UTF-8. */
  text(): string
}

/** Returns a collector that keeps at most `limit` bytes. */
export function collector(options: collector.Options): Collector {
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false

  return {
    push(chunk) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
      const room = options.limit - size
      if (bytes.length > room) truncated = true
      if (room <= 0) return

      const kept = bytes.length > room ? bytes.subarray(0, room) : bytes
      chunks.push(kept)
      size += kept.length
    },
    get truncated() {
      return truncated
    },
    text() {
      const joined = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        joined.set(chunk, offset)
        offset += chunk.length
      }
      return new TextDecoder().decode(joined)
    },
  }
}

export declare namespace collector {
  type Options = {
    /** Largest number of bytes to keep. */
    limit: number
  }
}

/** Reads `stream` to its end into a collector. */
export async function drain(
  stream: ReadableStream<Uint8Array> | null | undefined,
  options: drain.Options,
): Promise<void> {
  if (!stream) return

  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    options.into.push(value)
  }
}

export declare namespace drain {
  type Options = {
    /** Collector that receives the chunks. */
    into: Collector
  }
}

/** Resolves `path` against the working directory, and removes `.` and `..` segments. */
export function resolve(path: string, options: resolve.Options): string {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : options.cwd + '/' + path).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

export declare namespace resolve {
  type Options = {
    /** Directory that a relative path starts from. */
    cwd: string
  }
}

/** Returns the argument vector that runs `command` in `bash` under `timeout`. */
export function argv(command: string, options: argv.Options): string[] {
  return [
    'timeout',
    '--kill-after=' + killAfterSeconds,
    options.timeoutMs === null ? '0' : Math.max(options.timeoutMs, 1) / 1000 + 's',
    'bash',
    '-c',
    command,
  ]
}

export declare namespace argv {
  type Options = {
    /** Deadline in milliseconds, or `null` for no deadline. */
    timeoutMs: number | null
  }
}

/** Returns the shell output of a finished command, with a note when its deadline expired. */
export function output(options: output.Options): Contracts.ShellOutput {
  const { elapsedMs, exitCode, stderr, stdout, timeoutMs } = options

  const timedOut =
    timeoutMs !== null && (exitCode === 124 || exitCode === 137) && elapsedMs >= timeoutMs
  const note = timedOut
    ? (stderr.text() ? '\n' : '') + 'command timed out after ' + timeoutMs / 1000 + ' s'
    : ''

  return {
    stdout: stdout.text(),
    stderr: stderr.text() + note,
    exit_code: exitCode,
    truncated: stdout.truncated || stderr.truncated,
  }
}

export declare namespace output {
  type Options = {
    /** Milliseconds from the start of the command to its exit. */
    elapsedMs: number
    /** Exit code of the command. */
    exitCode: number
    /** Collector of the standard error stream. */
    stderr: Collector
    /** Collector of the standard output stream. */
    stdout: Collector
    /** Deadline in milliseconds, or `null` for no deadline. */
    timeoutMs: number | null
  }
}

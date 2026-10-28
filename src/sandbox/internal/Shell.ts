import type * as Contracts from '../../Contracts.ts'

export const cwd = '/workspace'

export const outputLimitBytes = 4 * 1024 * 1024

export const killAfterSeconds = 5

export type Collector = {
  push(chunk: Uint8Array | string): void
  readonly truncated: boolean
  text(): string
}

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
    limit: number
  }
}

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
    into: Collector
  }
}

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
    cwd: string
  }
}

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
    timeoutMs: number | null
  }
}

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
    elapsedMs: number
    exitCode: number
    stderr: Collector
    stdout: Collector
    timeoutMs: number | null
  }
}

import type * as Contracts from '../Contracts.ts'

export const SANDBOX_CWD = '/workspace'
export const SANDBOX_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024
export const SANDBOX_KILL_AFTER_SECONDS = 5

export type Collector = {
  push(chunk: Uint8Array | string): void
  readonly truncated: boolean
  text(): string
}

export function collector(limit: number): Collector {
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  return {
    push(chunk) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
      const room = limit - size
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

export async function drain(
  stream: ReadableStream<Uint8Array> | null | undefined,
  into: Collector,
): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    into.push(value)
  }
}

export function resolvePath(cwd: string, path: string): string {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : cwd + '/' + path).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

export function timeoutArgv(command: string, timeoutMs: number | null): string[] {
  return [
    'timeout',
    '--kill-after=' + SANDBOX_KILL_AFTER_SECONDS,
    timeoutMs === null ? '0' : Math.max(timeoutMs, 1) / 1000 + 's',
    'bash',
    '-c',
    command,
  ]
}

export function shellOutput(
  stdout: Collector,
  stderr: Collector,
  exitCode: number,
  timeoutMs: number | null,
  elapsedMs: number,
): Contracts.ShellOutput {
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

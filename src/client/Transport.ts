import type * as InternalFiles from '../internal/Files.ts'
import * as Format from './internal/Format.ts'
import type * as LiveEvent from './LiveEvent.ts'
import type * as Transcript from './Transcript.ts'

export type Attachment = InternalFiles.Attachment

export type Files = {
  maxBytes?: number
  maxFiles?: number
  read(path: string, signal?: AbortSignal): Promise<Blob>
  scope?(): string | undefined
  upload(file: Blob, name: string, signal?: AbortSignal): Promise<Attachment>
}

export type Parameters = {
  attachments?: readonly Attachment[]
  changed?(): void
  note(kind: Transcript.EntryKind, text: string): void
  prompt: string
  push(event: LiveEvent.LiveEvent): void
  signal: AbortSignal
}

export type Transport = {
  cancel?(): Promise<void>
  files?: Files
  restore?(state: unknown): void
  resume?(parameters: Omit<Parameters, 'prompt'>): Promise<void>
  send(parameters: Parameters): Promise<void>
  snapshot?(): unknown
  steer?(parameters: Parameters): Promise<boolean>
}

export function prompt(text: string, options: prompt.Options = {}): string {
  const { attachments = [] } = options
  if (!attachments.length) return text
  const lines = attachments.map(
    (item) => `Attached: ${item.path} (${item.type || 'file'}, ${Format.bytes(item.size)})`,
  )
  return text ? text + '\n\n' + lines.join('\n') : lines.join('\n')
}

export declare namespace prompt {
  type Options = {
    attachments?: readonly Attachment[] | undefined
  }
}

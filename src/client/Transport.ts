/**
 * Chat transports: the contract between the chat store and a backend that runs turns, uploads
 * files, and reports live events.
 *
 * @module
 */
import type * as InternalFiles from '../internal/Files.ts'
import * as Format from './internal/Format.ts'
import type * as LiveEvent from './LiveEvent.ts'
import type * as Transcript from './Transcript.ts'

/** File that a prompt carries, after its upload to the workspace. */
export type Attachment = InternalFiles.Attachment

/** File access of a transport. */
export type Files = {
  /** Largest upload in bytes. */
  maxBytes?: number
  /** Largest number of files in one prompt. */
  maxFiles?: number
  /** Reads one workspace file. */
  read(path: string, signal?: AbortSignal): Promise<Blob>
  /** Returns the key of the workspace that uploads go to, or `undefined` when it has none yet. */
  scope?(): string | undefined
  /** Uploads one file to the workspace. */
  upload(file: Blob, name: string, signal?: AbortSignal): Promise<Attachment>
}

/** Parameters of one transport call. */
export type Parameters = {
  /** Files that the prompt carries. */
  attachments?: readonly Attachment[]
  /** Reports a change to the transport's snapshot. */
  changed?(): void
  /** Posts one note to the transcript. */
  note(kind: Transcript.EntryKind, text: string): void
  /** Prompt text. */
  prompt: string
  /** Queues one live event. */
  push(event: LiveEvent.LiveEvent): void
  /** Aborts when the chat store drops the call. */
  signal: AbortSignal
}

/** Backend of a chat store. */
export type Transport = {
  /** Cancels the running turn. */
  cancel?(): Promise<void>
  /** File access, when the backend accepts uploads. */
  files?: Files
  /** Reads back a snapshot that `snapshot` returned. */
  restore?(state: unknown): void
  /** Follows the running turn of the restored session. */
  resume?(parameters: Omit<Parameters, 'prompt'>): Promise<void>
  /** Runs one turn for a prompt. */
  send(parameters: Parameters): Promise<void>
  /** Returns the state that resumes the session, such as a session identifier and a cursor. */
  snapshot?(): unknown
  /** Sends a prompt into the running turn, and returns whether the turn took it. */
  steer?(parameters: Parameters): Promise<boolean>
}

/** Returns the prompt text with one line for each attachment. */
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
    /** Files that the prompt carries. */
    attachments?: readonly Attachment[] | undefined
  }
}

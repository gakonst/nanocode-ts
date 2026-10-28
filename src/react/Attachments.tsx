'use client'

import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import * as Format from '../client/internal/Format.ts'
import type * as Transport from '../client/Transport.ts'
import { Image } from './Image.tsx'
import { useConfig, usePart } from './Provider.tsx'

export type PendingAttachment = {
  id: string
  name: string
  size: number
  type: string
  preview?: string
  status: 'uploading' | 'ready' | 'failed'
  error?: string
  attachment?: Transport.Attachment
}

export type Attachments = {
  enabled: boolean
  items: readonly PendingAttachment[]
  ready: Transport.Attachment[]
  uploading: boolean
  dragging: boolean
  add(files: Iterable<File> | ArrayLike<File>): void
  remove(id: string): void
  clear(): void
  open(): void
  input: {
    ref: { current: HTMLInputElement | null }
    type: 'file'
    multiple: true
    hidden: true
    tabIndex: -1
    onChange(event: ChangeEvent<HTMLInputElement>): void
  }
  onPaste(event: ClipboardEvent): void
  drop: {
    onDragOver(event: DragEvent): void
    onDragLeave(event: DragEvent): void
    onDrop(event: DragEvent): void
  }
}

export const maxAttachments = 8

function pastedName(file: File): string {
  if (file.name && file.name !== 'image.png' && file.name !== 'image.jpeg') return file.name
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `pasted-${stamp}.${(file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`
}

export function useAttachments(options: { max?: number } = {}): Attachments {
  const config = useConfig()
  const files = config.files
  const max = Math.min(options.max ?? files?.maxFiles ?? maxAttachments, maxAttachments)
  const [items, setItems] = useState<PendingAttachment[]>([])
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)
  const count = useRef(0)
  count.current = items.length
  const update = (id: string, next: Partial<PendingAttachment>) =>
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...next } : item)))

  const add = useCallback(
    (list: Iterable<File> | ArrayLike<File>) => {
      if (!files) return
      for (const file of Array.from(list)) {
        const id = Math.random().toString(36).slice(2)
        const name = pastedName(file)
        const base: PendingAttachment = {
          id,
          name,
          size: file.size,
          type: file.type,
          status: 'uploading',
          ...(file.type.startsWith('image/') && file.type !== 'image/svg+xml'
            ? { preview: URL.createObjectURL(file) }
            : {}),
        }
        if (count.current >= max) {
          setItems((current) => [
            ...current,
            { ...base, status: 'failed', error: `at most ${max} attachments per message` },
          ])
          continue
        }
        if (files.maxBytes !== undefined && file.size > files.maxBytes) {
          setItems((current) => [
            ...current,
            { ...base, status: 'failed', error: `larger than ${Format.bytes(files.maxBytes!)}` },
          ])
          continue
        }
        count.current++
        setItems((current) => [...current, base])
        files.upload(file, name).then(
          (attachment) =>
            update(id, {
              status: 'ready',
              attachment,
              name: attachment.name,
              type: attachment.type,
            }),
          (error: unknown) =>
            update(id, {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            }),
        )
      }
    },
    [files, max],
  )

  const remove = useCallback(
    (id: string) =>
      setItems((current) => {
        const found = current.find((item) => item.id === id)
        if (found?.preview) URL.revokeObjectURL(found.preview)
        return current.filter((item) => item.id !== id)
      }),
    [],
  )

  const clear = useCallback(() => setItems([]), [])

  const ready = useMemo(
    () =>
      items.flatMap((item) =>
        item.status === 'ready' && item.attachment ? [item.attachment] : [],
      ),
    [items],
  )

  return {
    enabled: Boolean(files),
    items,
    ready,
    uploading: items.some((item) => item.status === 'uploading'),
    dragging,
    add,
    remove,
    clear,
    open: () => input.current?.click(),
    input: {
      ref: input,
      type: 'file',
      multiple: true,
      hidden: true,
      tabIndex: -1,
      onChange: (event) => {
        if (event.target.files) add(event.target.files)
        event.target.value = ''
      },
    },
    onPaste: (event) => {
      const pasted = Array.from(event.clipboardData?.files ?? [])
      if (!files || !pasted.length) return
      event.preventDefault()
      add(pasted)
    },
    drop: {
      onDragOver: (event) => {
        if (!files || !Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
        event.preventDefault()
        setDragging(true)
      },
      onDragLeave: () => setDragging(false),
      onDrop: (event) => {
        setDragging(false)
        if (!files || !event.dataTransfer?.files.length) return
        event.preventDefault()
        add(event.dataTransfer.files)
      },
    },
  }
}

export function AttachmentList(props: AttachmentList.Props) {
  const part = usePart()
  if (!props.items.length) return null
  return (
    <div {...part('attachments', { editable: Boolean(props.onRemove) })}>
      {props.items.map((item, index) => {
        const pending = 'status' in item ? item : undefined
        const path = pending ? pending.attachment?.path : (item as Transport.Attachment).path
        const image = item.type.startsWith('image/')
        const status = pending?.status ?? 'ready'
        return (
          <span
            key={pending?.id ?? path ?? index}
            title={pending?.error ?? path ?? item.name}
            {...part('attachment', { image, status })}
          >
            {image &&
              (pending?.preview ? (
                <img alt="" src={pending.preview} {...part('attachmentThumb')} />
              ) : path ? (
                <span {...part('attachmentThumb')}>
                  <Image alt={item.name} src={path} />
                </span>
              ) : null)}
            <span {...part('attachmentName')}>{item.name}</span>
            <span {...part('attachmentSize')}>
              {pending?.error ?? (status === 'uploading' ? 'uploading' : Format.bytes(item.size))}
            </span>
            {props.onRemove && pending && (
              <button
                aria-label={`Remove ${item.name}`}
                onClick={() => props.onRemove!(pending.id)}
                type="button"
                {...part('attachmentRemove')}
              >
                ×
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

export declare namespace AttachmentList {
  type Props = {
    items: readonly (PendingAttachment | Transport.Attachment)[]
    onRemove?(id: string): void
  }
}

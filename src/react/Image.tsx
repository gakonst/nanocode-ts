'use client'

/**
 * Images of a transcript, including images that a workspace file holds.
 *
 * @module
 */
import { useContext, useEffect, useState } from 'react'
import * as Workspace from '../client/internal/Workspace.ts'
import type * as Transport from '../client/Transport.ts'
import { ConfigContext, usePart, useSkin } from './Provider.tsx'

const imageUrl = /^(https?:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,])/i

/** Returns the source of an image that renders, or `undefined`. */
export function imageSource(src: unknown): string | undefined {
  if (typeof src !== 'string') return undefined
  const value = src.trim()
  return imageUrl.test(value) || Workspace.path(value) ? value : undefined
}

const fileTtlMs = 15_000

const fileCache = new WeakMap<
  Transport.Files,
  Map<string, { at: number; url: Promise<{ url: string; type: string }> }>
>()

/** Returns an object URL of a workspace file. */
export function useWorkspaceFile(path: string | undefined): {
  url?: string
  type?: string
  failed: boolean
} {
  const files = useContext(ConfigContext)?.files
  const [state, setState] = useState<{
    key?: string
    url?: string
    type?: string
    failed: boolean
  }>({ failed: false })
  const key = files && path ? (files.scope?.() ?? '') + '\0' + path : undefined
  useEffect(() => {
    if (!files || !path || !key) return
    let cache = fileCache.get(files)
    if (!cache) fileCache.set(files, (cache = new Map()))
    let entry = cache.get(key)
    if (!entry || Date.now() - entry.at > fileTtlMs) {
      const url = files
        .read(path)
        .then((blob) => ({ url: URL.createObjectURL(blob), type: blob.type }))
      entry = { at: Date.now(), url }
      cache.set(key, entry)
      url.catch(() => {
        if (cache!.get(key)?.url === url) cache!.delete(key)
      })
    }
    let active = true
    entry.url.then(
      (found) => {
        if (active) setState({ key, url: found.url, type: found.type, failed: false })
      },
      () => {
        if (active) setState({ key, failed: true })
      },
    )
    return () => {
      active = false
    }
  }, [files, path, key])
  if (!files || !path) return { failed: true }
  return state.key === key
    ? {
        ...(state.url ? { url: state.url } : {}),
        ...(state.type ? { type: state.type } : {}),
        failed: state.failed,
      }
    : { failed: false }
}

function WorkspaceImage(props: WorkspaceImage.Props) {
  const part = usePart()
  const skin = useSkin()
  const file = useWorkspaceFile(props.path)
  const [broken, setBroken] = useState(false)
  const failed = file.failed || broken
  const own = part('image', { failed, loading: !file.url && !failed, source: 'workspace' })
  const style = skin.parts?.image ? own.style : { height: 'auto', maxWidth: '100%', ...own.style }
  const label = props.alt || props.path
  if (!file.url || failed)
    return (
      <span
        title={props.path}
        {...part('image', { failed, loading: !failed, source: 'workspace' })}
      >
        {label}
      </span>
    )
  const raster = /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(file.type ?? '')
  return (
    <a
      href={raster ? file.url : undefined}
      rel="noreferrer"
      target="_blank"
      title={props.title ?? props.alt ?? props.path}
      {...part('figure', { failed })}
    >
      <img
        {...own}
        alt={props.alt ?? ''}
        decoding="async"
        onError={() => setBroken(true)}
        src={file.url}
        style={style}
      />
    </a>
  )
}

declare namespace WorkspaceImage {
  type Props = {
    path: string
    alt?: string
    title?: string
  }
}

function openData(src: string) {
  const comma = src.indexOf(',')
  const head = src.slice(5, comma)
  const body = src.slice(comma + 1)
  const type = head.split(';')[0] || 'image/png'
  const bytes = head.endsWith(';base64')
    ? Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(body))
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const opened = open(url, '_blank')
  if (opened) opened.opener = null
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Image from a URL or a workspace file. */
export function Image(props: Image.Props) {
  const part = usePart()
  const skin = useSkin()
  const [failed, setFailed] = useState(false)
  const src = imageSource(props.src)
  const path = Workspace.path(src)
  if (path)
    return (
      <WorkspaceImage
        alt={props.alt}
        path={path}
        {...(props.title ? { title: props.title } : {})}
      />
    )
  if (!src) return props.alt ? <span {...part('image', { failed: true })}>{props.alt}</span> : null
  const data = src.startsWith('data:')
  const own = part('image', { failed, source: data ? 'data' : 'url' })
  const style = skin.parts?.image ? own.style : { height: 'auto', maxWidth: '100%', ...own.style }
  return (
    <a
      href={src}
      onClick={(event) => {
        if (!data || event.button !== 0) return
        event.preventDefault()
        try {
          openData(src)
        } catch {}
      }}
      rel="noreferrer"
      target="_blank"
      title={props.title ?? props.alt}
      {...part('figure', { failed })}
    >
      {failed ? (
        props.alt || src
      ) : (
        <img
          {...own}
          alt={props.alt ?? ''}
          decoding="async"
          loading="lazy"
          onError={() => setFailed(true)}
          src={src}
          style={style}
        />
      )}
    </a>
  )
}

export declare namespace Image {
  type Props = {
    src: string
    alt?: string
    title?: string
  }
}

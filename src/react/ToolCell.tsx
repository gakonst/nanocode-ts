'use client'

import { useContext, useEffect, useState } from 'react'
import * as Format from '../client/internal/Format.ts'
import type * as Tool from '../client/Tool.ts'
import { Tokens } from './Code.tsx'
import { Image } from './Image.tsx'
import { useExpanded, usePart, useSkin } from './Provider.tsx'

export const spinner = ['◐', '◓', '◑', '◒']

const statusIcons: Record<Tool.Cell['status'], string> = {
  running: spinner[0],
  completed: '✓',
  failed: '✗',
  cancelled: '⊘',
  yielded: '↻',
}

const inputLines = 12

const outputLines = 10

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function Section(props: Section.Props) {
  const part = usePart()
  const lines = props.text.split('\n')
  const body = (text: string) => (
    <pre data-language={props.language} {...part('body', { part: props.part, size: props.size })}>
      <Tokens code={text} language={props.language} />
    </pre>
  )
  if (lines.length <= props.limit) return body(props.text)
  const shown = props.tail ? lines.slice(-props.limit) : lines.slice(0, props.limit)
  const more = (
    <button onClick={props.onMore} type="button" {...part('more')}>
      {props.tail
        ? `… ${lines.length - props.limit} earlier lines`
        : `… ${lines.length - props.limit} more lines`}
    </button>
  )
  return (
    <div {...part('section')}>
      {props.tail && more}
      {body(shown.join('\n'))}
      {!props.tail && more}
    </div>
  )
}

declare namespace Section {
  type Props = {
    text: string
    language: string
    part: 'error' | 'input' | 'output'
    size: 'full' | 'nested' | 'normal'
    limit: number
    tail: boolean
    onMore(): void
  }
}

function lineCount(text: string): string {
  const lines = text.split('\n').length
  return lines === 1 ? '1 line' : lines.toLocaleString('en-US') + ' lines'
}

export function ToolCell(props: ToolCell.Props) {
  const part = usePart()
  const { cell, live = false, nested = false, collapsed = false } = props
  const expanded = useExpanded()
  const open = expanded.open.has(cell.call_id)
  const running = cell.status === 'running'
  const now = useNow(running && live)
  const unsuccessful =
    cell.status === 'failed' || (cell.exit_code !== undefined && cell.exit_code !== 0)
  const input = cell.input.replace(/\s+$/, '')
  const output = cell.output.replace(/\s+$/, '')
  const images = cell.images ?? []
  const icons = useSkin().icons
  const glyph = icons?.[cell.status] ?? (running ? spinner : statusIcons[cell.status])
  const icon = typeof glyph === 'string' ? glyph : glyph[Math.floor(now / 120) % glyph.length]
  const shown = open || !collapsed
  return (
    <div
      data-call={cell.call_id}
      {...part('tool', { collapsed, nested, open, status: cell.status })}
    >
      <button
        aria-expanded={open}
        onClick={() => expanded.toggle(cell.call_id)}
        type="button"
        {...part('header')}
      >
        <span aria-label={cell.status} {...part('icon', { status: cell.status })}>
          {icon}
        </span>
        <span {...part('name')}>{cell.name}</span>
        {cell.title && <span {...part('title')}>{cell.title}</span>}
        <span {...part('meta')}>
          {running
            ? ` · ${Format.duration(now - cell.started_at)}`
            : cell.duration_ms !== undefined
              ? ` · ${Format.duration(cell.duration_ms)}`
              : ''}
          {cell.status === 'cancelled' || cell.status === 'failed' ? ` · ${cell.status}` : ''}
          {cell.details.map((detail) => ` · ${detail}`).join('')}
          {collapsed && nested && !running && output ? ` · ${lineCount(output)}` : ''}
        </span>
      </button>
      {shown && input && (!nested || open || cell.body === 'diff') && (
        <Section
          language={cell.body === 'diff' ? 'diff' : cell.language}
          limit={open ? Infinity : inputLines}
          onMore={() => expanded.toggle(cell.call_id, true)}
          part="input"
          size={open ? 'full' : nested ? 'nested' : 'normal'}
          tail={live && running}
          text={input}
        />
      )}
      {(shown || collapsed) && cell.children.length > 0 && (
        <div {...part('children')}>
          {cell.children.map((child) => (
            <ToolCell cell={child} collapsed={collapsed} key={child.call_id} live={live} nested />
          ))}
        </div>
      )}
      {shown && output && (!nested || open || unsuccessful) && (
        <Section
          language={cell.output_language}
          limit={open ? Infinity : outputLines}
          onMore={() => expanded.toggle(cell.call_id, true)}
          part={unsuccessful ? 'error' : 'output'}
          size={open ? 'full' : nested ? 'nested' : 'normal'}
          tail={live && running}
          text={output}
        />
      )}
      {shown && images.length > 0 && (
        <div {...part('images', { nested })}>
          {images.map((src, index) => (
            <Image alt={`${cell.name} image ${index + 1}`} key={index} src={src} />
          ))}
        </div>
      )}
    </div>
  )
}

export declare namespace ToolCell {
  type Props = {
    cell: Tool.Cell
    live?: boolean
    nested?: boolean
    collapsed?: boolean
  }
}

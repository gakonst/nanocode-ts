import type { Vars } from 'zyzz'
import { ellipsis, flicker, style, variants, vars } from './Theme.ts'

export const chat = variants({
  base: {
    backgroundColor: 'surface',
    border: '1px solid',
    borderColor: 'rule',
    color: 'text',
    display: 'flex',
    flexDirection: 'column',
    selectors: { '[data-xframe] &': { inset: '0 !custom', position: 'fixed', zIndex: 200 } },
  },
  variants: {
    expanded: {
      false: {},
      true: {
        borderInline: 'none',
        bottom: '0',
        left: '0',
        position: 'fixed',
        right: '0',
        top: 'nav',
        zIndex: 90,
      },
    },
  },
  defaultVariants: { expanded: false },
})

export const log = variants({
  base: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'sm',
    height: '18rem !custom',
    overflowY: 'auto',
    padding: 'md',
    selectors: { '[data-xframe] &': { flex: '1 !custom', height: 'auto !custom', minHeight: '0' } },
  },
  variants: {
    expanded: {
      false: {},
      true: { flex: '1 !custom', height: 'auto !custom', minHeight: '0', paddingInline: 'gutter' },
    },
  },
  defaultVariants: { expanded: false },
})

export const turn = style({ display: 'flex', flexDirection: 'column', gap: 'xs', minWidth: '0' })

export const speaker = variants({
  base: { fontStyle: 'normal', fontVariationSettings: '"wght" 700', margin: '0' },
  variants: { who: { agent: { color: 'agent' }, you: { color: 'accent' } } },
})

export const entry = variants({
  base: {
    margin: '0',
    minWidth: '0',
    overflowWrap: 'break-word',
    whiteSpace: 'pre-wrap',
    '@media (prefers-reduced-motion: reduce)': { '::after': { animationName: 'none' } },
  },
  variants: {
    kind: {
      assistant: {},
      cell: { whiteSpace: 'normal' },
      error: { color: 'accent' },
      reasoning: {
        color: 'middle',
        fontStyle: 'italic',
        '::before': {
          color: 'agent',
          content: '"thinking  "',
          fontStyle: 'normal',
          fontVariationSettings: '"wght" 700',
        },
      },
      tool: { fontStyle: 'italic', opacity: 'dim' },
      user: {},
    },
    live: {
      false: {},
      true: {
        '::after': {
          animationDuration: '1s',
          animationIterationCount: 'infinite',
          animationName: flicker,
          animationTimingFunction: 'steps(1, end)',
          color: 'accent',
          content: '"▌"',
          fontStyle: 'normal',
        },
      },
    },
  },
  defaultVariants: { live: false },
})

export const code = variants({
  base: {
    margin: '0',
    overflowWrap: 'anywhere',
    paddingBlock: 'sm',
    paddingInline: 'indent',
    whiteSpace: 'pre-wrap',
  },
  variants: {
    framed: {
      false: {},
      true: {
        backgroundColor: 'bg',
        border: '1px solid',
        borderColor: 'rule',
        color: 'text',
        marginBlock: 'sm',
      },
    },
  },
  defaultVariants: { framed: false },
})

export const inline = style({ fontVariationSettings: '"wght" 500' })

export const strong = style({ fontVariationSettings: '"wght" 700', fontWeight: 'normal' })

export const image = style({
  border: '1px solid',
  borderColor: 'rule',
  display: 'block',
  height: 'auto !custom',
  marginBlock: 'sm',
  maxWidth: 'min(100%, 24rem) !custom',
})

export const figure = style({
  color: 'middle',
  display: 'inline-block',
  maxWidth: '100% !custom',
  verticalAlign: 'top',
})

export const images = style({ display: 'flex', flexWrap: 'wrap', gap: 'sm', marginLeft: 'cell' })

export const markdown = style({ display: 'contents' })

export const paragraph = style({
  margin: '0',
  selectors: {
    '[data-live="true"] > &:last-child, [data-live="true"] > [data-nc="markdown"] > &:last-child': {
      display: 'inline',
    },
  },
})

export const heading = style({
  fontSize: 'inherit !custom',
  fontVariationSettings: '"wght" 700',
  lineHeight: 'inherit !custom',
  margin: '0',
  '::before': { color: 'accent', content: '"# "' },
})

export const list = style({ marginBlock: '0', paddingLeft: '3ch !custom' })

export const item = style({ '::marker': { color: 'middle' } })

export const quote = style({
  borderLeft: '1px solid',
  borderLeftColor: 'rule',
  color: 'middle',
  marginBlock: '0',
  marginInline: '0',
  paddingLeft: '1.5ch !custom',
})

export const table = style({
  borderCollapse: 'collapse',
  display: 'block',
  marginBlock: 'xs',
  maxWidth: '100% !custom',
  overflowX: 'auto',
  whiteSpace: 'normal',
})

export const cell = variants({
  base: {
    border: '1px solid',
    borderColor: 'rule',
    paddingBlock: '0',
    paddingInline: 'cell',
    textAlign: 'left',
    verticalAlign: 'top',
  },
  variants: {
    align: { center: { textAlign: 'center' }, left: {}, right: { textAlign: 'right' } },
    header: { false: {}, true: { fontVariationSettings: '"wght" 700', fontWeight: 'normal' } },
  },
  defaultVariants: { header: false },
})

export const rule = style({
  border: 'none',
  borderTop: '1px solid',
  borderTopColor: 'rule',
  marginBlock: 'xs',
  marginInline: '0',
})

export const em = style({ fontStyle: 'italic' })

export const strike = style({ textDecorationLine: 'line-through' })

export const link = style({
  color: 'text',
  textDecorationColor: 'accent',
  textDecorationLine: 'underline',
  textUnderlineOffset: '0.24ch !custom',
})

export const tool = variants({
  base: { display: 'flex', flexDirection: 'column', minWidth: '0' },
  variants: {
    status: { cancelled: {}, completed: {}, failed: {}, running: {}, yielded: {} },
    open: { false: {}, true: {} },
    nested: { false: {}, true: {} },
  },
  defaultVariants: { nested: false, open: false },
})

export const header = style({
  alignItems: 'baseline',
  backgroundColor: 'transparent',
  border: 'none',
  color: 'inherit !custom',
  cursor: 'pointer',
  display: 'flex',
  font: 'inherit !custom',
  minWidth: '0',
  padding: '0',
  textAlign: 'left',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  ':focus-visible': { outline: '1px solid', outlineColor: 'text', outlineOffset: '1px' },
})

export const icon = variants({
  base: { display: 'inline-block', flexShrink: 0, textAlign: 'center', width: '2ch !custom' },
  variants: {
    status: {
      cancelled: { color: 'middle' },
      completed: { color: 'agent' },
      failed: { color: 'accent' },
      running: { color: 'accent' },
      yielded: { color: 'accent' },
    },
  },
})

export const name = style({
  flexShrink: 0,
  fontVariationSettings: '"wght" 700',
  paddingLeft: '0.5ch !custom',
  selectors: {
    [`${header}:hover &`]: { textDecorationColor: 'accent', textDecorationLine: 'underline' },
  },
})

export const title = style({
  flexShrink: 1,
  minWidth: '0',
  overflow: 'hidden',
  paddingLeft: 'cell',
  textOverflow: 'ellipsis',
})

export const meta = style({ color: 'middle', flexShrink: 0, whiteSpace: 'pre' })

export const body = variants({
  base: {
    borderLeft: '1px solid',
    borderLeftColor: 'rule',
    marginBlock: '0',
    marginLeft: 'cell',
    marginRight: '0',
    maxHeight: '24rem !custom',
    overflow: 'auto',
    overflowWrap: 'anywhere',
    paddingBlock: '0.125rem !custom',
    paddingLeft: '1.5ch !custom',
    paddingRight: '0',
    whiteSpace: 'pre-wrap',
  },
  variants: {
    size: {
      full: { maxHeight: 'none !custom' },
      nested: { maxHeight: '12rem !custom' },
      normal: {},
    },
    part: {
      error: { color: 'accent', marginTop: 'xs' },
      input: { backgroundColor: 'wash' },
      output: { color: 'middle', marginTop: 'xs' },
    },
  },
  defaultVariants: { size: 'normal' },
})

export const section = style({ display: 'flex', flexDirection: 'column' })

export const more = style({
  alignSelf: 'flex-start',
  backgroundColor: 'transparent',
  border: 'none',
  color: 'middle',
  cursor: 'pointer',
  font: 'inherit !custom',
  marginLeft: 'cell',
  padding: '0',
  paddingLeft: '1.5ch !custom',
  textDecoration: 'none',
  ':hover': { color: 'text', textDecorationColor: 'accent', textDecorationLine: 'underline' },
})

export const children = style({
  borderLeft: '1px solid',
  borderLeftColor: 'rule',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem !custom',
  marginLeft: 'cell',
  marginTop: 'xs',
  paddingLeft: '0.5ch !custom',
})

export const picker = style({
  borderTop: '1px solid',
  borderTopColor: 'rule',
  display: 'flex',
  flexDirection: 'column',
  maxHeight: '16rem !custom',
  overflowY: 'auto',
  paddingBlock: 'sm',
  paddingInline: 'md',
})

export const pickerTitle = style({ fontVariationSettings: '"wght" 700', margin: '0' })

export const pickerHeader = style({
  color: 'middle',
  fontVariationSettings: '"wght" 700',
  margin: '0',
})

export const pickerMuted = style({ color: 'middle', margin: '0', whiteSpace: 'pre' })

export const pickerQuery = style({ color: 'text' })

export const marker = style({ color: 'accent' })

export const choice = style({
  backgroundColor: 'transparent',
  border: 'none',
  color: 'inherit !custom',
  cursor: 'pointer',
  display: 'grid',
  font: 'inherit !custom',
  padding: '0',
  textAlign: 'left',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
})

export const choiceLabel = style({
  selectors: {
    [`${choice}[aria-selected="true"] &`]: { color: 'accent', fontVariationSettings: '"wght" 700' },
  },
})

export const choiceDetail = style({
  color: 'middle',
  overflow: 'hidden',
  paddingLeft: 'cell',
  textOverflow: 'ellipsis',
})

export const typing = variants({
  base: {
    boxSizing: 'content-box',
    fontStyle: 'italic',
    height: vars.lineHeight.body,
    margin: '0',
    paddingBottom: 'sm',
    paddingInline: 'md',
  },
  variants: {
    visible: {
      false: {},
      true: {
        '::after': {
          animationDuration: '1.2s',
          animationIterationCount: 'infinite',
          animationName: ellipsis,
          animationTimingFunction: 'steps(4, end)',
          content: '"..."',
          display: 'inline-block',
          overflow: 'hidden',
          verticalAlign: 'bottom',
          width: '0',
        },
        '@media (prefers-reduced-motion: reduce)': {
          '::after': { animationName: 'none', width: 'auto !custom' },
        },
      },
    },
  },
  defaultVariants: { visible: false },
})

export const row = style({
  alignItems: 'center',
  borderTop: '1px solid',
  borderTopColor: 'rule',
  display: 'flex',
  gap: 'sm',
  paddingBlock: 'sm',
  paddingInline: 'md',
})

export const attach = style({
  alignSelf: 'flex-start',
  backgroundColor: 'transparent',
  border: 'none',
  color: 'accent',
  cursor: 'pointer',
  font: 'inherit !custom',
  padding: '0',
  ':focus-visible': { outline: '2px solid', outlineColor: 'text', outlineOffset: '2px' },
})

export const attachments = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'sm',
  paddingBlock: 'xs',
  paddingInline: 'md',
  selectors: { '[data-nc="turn"] > &': { paddingInline: '0' } },
})

export const attachment = style({
  alignItems: 'center',
  border: '1px solid',
  borderColor: 'rule',
  display: 'inline-flex',
  gap: 'xs',
  maxWidth: '100% !custom',
  minWidth: '0',
  paddingInline: 'xs',
})

export const attachmentThumb = style({
  display: 'inline-flex',
  height: '2rem !custom',
  maxWidth: '4rem !custom',
  objectFit: 'cover',
  overflow: 'hidden',
  selectors: {
    '& img': {
      border: 'none',
      height: '2rem !custom',
      margin: '0',
      maxWidth: '4rem !custom',
      objectFit: 'cover',
    },
  },
})

export const attachmentName = style({
  maxWidth: '16rem !custom',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

export const attachmentSize = style({ color: 'middle', whiteSpace: 'nowrap' })

export const attachmentRemove = style({
  backgroundColor: 'transparent',
  border: 'none',
  color: 'middle',
  cursor: 'pointer',
  font: 'inherit !custom',
  padding: '0',
  ':hover': { color: 'text' },
})

export const chevron = style({
  alignSelf: 'flex-start',
  color: 'accent',
  fontVariationSettings: '"wght" 700',
})

export const input = style({
  backgroundColor: 'transparent',
  border: 'none',
  color: 'text',
  flex: '1 !custom',
  font: 'inherit !custom',
  resize: 'none',
  ':focus-visible': { outline: 'none' },
  '::placeholder': { color: 'middle' },
})

export const send = style({
  alignSelf: 'flex-start',
  backgroundColor: 'transparent',
  border: 'none',
  color: 'text',
  cursor: 'pointer',
  font: 'inherit !custom',
  padding: '0',
  textDecoration: 'none',
  ':disabled': { cursor: 'default', opacity: 'faint' },
  ':focus-visible': { outline: '2px solid', outlineColor: 'text', outlineOffset: '2px' },
})

export const key = style({
  border: '1px solid',
  borderBottomWidth: '2px',
  borderColor: 'text',
  display: 'inline',
  lineHeight: '0.85rem !custom',
  paddingInline: 'calc(0.5ch - 1px) !custom',
  userSelect: 'none',
})

export const suggestions = style({
  borderTop: '1px solid',
  borderTopColor: 'rule',
  display: 'flex',
  gap: 'indent',
  overflow: 'hidden',
  paddingBlock: 'xs',
  paddingInline: 'md',
  whiteSpace: 'nowrap',
})

export const suggestion = variants({
  base: {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'text',
    cursor: 'pointer',
    flexShrink: 1,
    font: 'inherit !custom',
    minWidth: '0',
    overflow: 'hidden',
    padding: '0',
    textDecorationColor: 'accent',
    textDecorationLine: 'underline',
    textOverflow: 'ellipsis',
    textUnderlineOffset: '0.24ch !custom',
    ':disabled': { cursor: 'default', opacity: 'faint' },
    ':hover:not(:disabled)': {
      backgroundColor: 'accent',
      color: 'onAccent',
      textDecorationLine: 'none',
    },
  },
  variants: {
    quiet: { false: {}, true: { opacity: 'dim', ':disabled': { opacity: 'muted' } } },
  },
  defaultVariants: { quiet: false },
})

export const status = style({
  borderTop: '1px solid',
  borderTopColor: 'rule',
  columnGap: 'indent',
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  margin: '0',
  paddingBlock: 'xs',
  paddingInline: 'md',
  rowGap: 'xs',
  whiteSpace: 'nowrap',
})

export const statusText = style({
  flex: '1 !custom',
  minWidth: '0',
  opacity: 'dim',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
})

export const actions = style({
  columnGap: 'indent',
  display: 'flex',
  flexWrap: 'wrap',
  rowGap: 'xs',
})

export const hand = variants({
  base: {
    borderTop: '1px solid',
    borderTopColor: 'rule',
    display: 'flex',
    flexDirection: 'column',
    gap: 'xs',
    paddingBlock: 'sm',
    paddingInline: 'md',
  },
  variants: { attached: { false: {}, true: { borderTopColor: 'agent' } } },
  defaultVariants: { attached: false },
})

export const handTitle = style({
  color: 'accent',
  fontVariationSettings: '"wght" 700',
  margin: '0',
})

export const handText = style({
  margin: '0',
  opacity: 'dim',
  selectors: {
    '& code': { color: 'text', fontVariationSettings: '"wght" 500', overflowWrap: 'anywhere' },
  },
})

export const handCommand = style({
  border: '1px solid',
  borderColor: 'rule',
  margin: '0',
  overflowX: 'auto',
  paddingBlock: 'xs',
  paddingInline: 'sm',
  userSelect: 'all',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
})

export const handActions = style({
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'md',
  margin: '0',
})

export const handButton = style({
  background: 'none',
  border: '1px solid',
  borderColor: 'rule',
  color: 'accent',
  cursor: 'pointer',
  font: 'inherit !custom',
  paddingInline: 'sm',
})

export const handStatus = variants({
  base: { opacity: 'dim' },
  variants: { attached: { false: {}, true: { color: 'agent', opacity: '1 !custom' } } },
  defaultVariants: { attached: false },
})

export const plan = hand

export const planTitle = handTitle

export const planText = handText

export const planCode = handCommand

export const planActions = handActions

export const planButton = handButton

export const planStatus = handStatus

export const planInput = style({
  background: 'none',
  border: '1px solid',
  borderColor: 'rule',
  color: 'text',
  flex: '1 1 12ch',
  font: 'inherit !custom',
  minWidth: '0',
  paddingInline: 'sm',
})

export const expand = style({
  backgroundColor: 'transparent',
  border: 'none',
  color: 'middle',
  cursor: 'pointer',
  font: 'inherit !custom',
  padding: '0',
  textDecoration: 'none',
  ':hover': { color: 'text' },
  selectors: { '[data-xframe] &': { display: 'none' } },
})

export const site = style({
  color: 'text',
  display: 'none',
  textDecorationColor: 'accent',
  textUnderlineOffset: '0.24ch !custom',
  selectors: { '[data-xframe] &': { display: 'inline' } },
})

export const notice = style({
  borderTop: '1px solid',
  borderTopColor: 'rule',
  margin: '0',
  paddingBlock: 'sm',
  paddingInline: 'md',
})

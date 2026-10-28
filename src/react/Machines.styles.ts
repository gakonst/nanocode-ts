/**
 * Skin part styles of the machines components, keyed by part name.
 *
 * @module
 */
import { style, variants } from './Theme.ts'

export const spend = style({
  borderTop: '1px solid',
  borderTopColor: 'rule',
  display: 'flex',
  flexDirection: 'column',
  overflowX: 'auto',
  paddingBlock: 'xs',
  paddingInline: 'md',
  whiteSpace: 'pre',
  selectors: { '& p': { margin: '0' } },
})

export const spendTitle = style({ fontVariationSettings: '"wght" 700' })

export const spendAccent = style({ color: 'accent' })

export const spendDot = variants({
  base: { opacity: 'faint' },
  variants: { live: { false: {}, true: { color: 'accent', opacity: '1 !custom' } } },
  defaultVariants: { live: false },
})

export const spendEmpty = style({ fontStyle: 'italic', opacity: 'dim' })

export const spendSpark = style({ color: 'agent' })

export const spendCalls = style({ opacity: 'dim' })

export const prompt = style({
  borderTop: '1px solid',
  borderTopColor: 'rule',
  margin: '0',
  paddingBlock: 'sm',
  paddingInline: 'md',
  selectors: {
    '& b': { color: 'accent', fontVariationSettings: '"wght" 700', fontWeight: 'normal' },
  },
})

export const unlock = style({
  alignItems: 'center',
  borderTop: '1px solid',
  borderTopColor: 'rule',
  display: 'flex',
  gap: 'md',
  justifyContent: 'space-between',
  margin: '0',
  opacity: 'dim',
  paddingBlock: 'xs',
  paddingInline: 'md',
})

export const unlockButton = style({
  background: 'none',
  border: '1px solid',
  borderColor: 'rule',
  color: 'accent',
  cursor: 'pointer',
  font: 'inherit',
  paddingInline: 'sm',
})

export const walletCard = style({
  border: '1px solid',
  borderColor: 'accent',
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
  marginBlock: 'xs',
  padding: 'sm',
})

export const walletCardTitle = style({
  color: 'accent',
  fontVariationSettings: '"wght" 700',
  margin: '0',
})

export const walletCardText = style({ margin: '0' })

export const walletCardActions = style({ display: 'flex', gap: 'sm' })

export const walletCardButton = style({
  background: 'none',
  border: '1px solid',
  borderColor: 'accent',
  color: 'accent',
  cursor: 'pointer',
  font: 'inherit',
  paddingInline: 'sm',
})

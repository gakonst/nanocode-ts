/**
 * Styles of the site pages.
 *
 * @module
 */
import type { Vars } from 'zyzz'
import { flicker, style, variants } from './Theme.ts'

export const body = style({
  backgroundColor: 'bg',
  color: 'text',
  colorScheme: 'light dark',
  fontFamily: 'mono',
  fontFeatureSettings: '"ss01", "ss03", "ss04", "ss05"',
  fontSize: 'body',
  lineHeight: 'body',
  margin: '0',
  MozOsxFontSmoothing: 'grayscale',
  WebkitFontSmoothing: 'antialiased',
  selectors: {
    ':where(&) :where(*), :where(&) :where(*)::before, :where(&) :where(*)::after': {
      boxSizing: 'border-box',
      margin: '0',
      padding: '0',
    },
    ':where(&) ::selection': { backgroundColor: 'accent', color: 'onAccent' },
    ':where(&) :where(h1)': { fontSize: 'title', fontWeight: 'normal', lineHeight: 'title' },
    ':where(&) :where(h2), :where(&) :where(h3), :where(&) :where(h4)': {
      fontSize: 'inherit !custom',
      fontVariationSettings: '"wght" 700',
      fontWeight: 'normal',
      lineHeight: 'inherit !custom',
    },
    ':where(&) :where(a), :where(&) :where(a:visited)': { color: 'text' },
    ':where(&) :where(a), :where(&) :where(button)': {
      cursor: 'pointer',
      textDecorationColor: 'accent',
      textDecorationLine: 'underline',
      textDecorationSkipInk: 'none',
      textUnderlineOffset: '0.24ch !custom',
    },
    ':where(&) :where(button)': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'inherit !custom',
      font: 'inherit !custom',
      fontFeatureSettings: 'inherit !custom',
      textAlign: 'left',
    },
    ':where(&) :where(button:active)': { backgroundColor: 'accent', color: 'onAccent' },
    ':where(&) :where(:focus-visible)': {
      animationDuration: '50ms',
      animationIterationCount: 2,
      animationName: flicker,
      backgroundColor: 'accent',
      color: 'onAccent',
      outline: 'none',
      textDecorationLine: 'none',
    },
    ':where(&) :where(code), :where(&) :where(kbd), :where(&) :where(pre), :where(&) :where(samp)':
      { font: 'inherit !custom', fontFeatureSettings: 'inherit !custom' },
  },
  '@media (prefers-reduced-motion: reduce)': {
    selectors: { ':where(&) :where(:focus-visible)': { animationName: 'none' } },
  },
})

export const header = style({
  backgroundColor: 'bg',
  insetInline: '0',
  overflowX: 'auto',
  paddingBottom: 'sm',
  paddingInline: 'gutter',
  paddingTop: 'md',
  position: 'fixed',
  scrollbarWidth: 'none',
  top: '0',
  zIndex: 100,
  '@media (max-width: 1000px)': { paddingInline: 'indent' },
})

export const navigation = style({ display: 'flex', gap: 'gutter', width: 'max-content !custom' })

export const link = variants({
  base: {
    color: 'text',
    textDecorationLine: 'none',
    whiteSpace: 'nowrap',
    ':active': { backgroundColor: 'text', color: 'bg' },
    ':hover': { backgroundColor: 'accent', color: 'onAccent' },
  },
  variants: {
    current: {
      false: {},
      true: {
        ':not(:hover)': {
          backgroundColor: 'text',
          boxShadow:
            'inset 0 -2px 0 var(--z-nanocode-color-accent, light-dark(#ea4c0a, #ff5c1a)) !custom',
          color: 'bg',
        },
      },
    },
  },
  defaultVariants: { current: false },
})

export const menu = style({ position: 'relative' })

export const menuList = style({
  backgroundColor: 'bg',
  border: '1px solid',
  borderColor: 'rule',
  display: 'none',
  flexDirection: 'column',
  gap: 'xs',
  marginLeft: 'calc(-1ch - 1px) !custom',
  paddingBlock: 'sm',
  paddingInline: 'cell',
  position: 'fixed',
  selectors: {
    [`${menu}:hover > &`]: { display: 'flex' },
    [`${menu}:focus-within > &`]: { display: 'flex' },
  },
})

export const main = style({
  paddingBottom: '10rem !custom',
  paddingInline: 'gutter',
  paddingTop: 'nav',
  '@media (max-width: 1000px)': { paddingInline: 'indent' },
})

export const page = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 'lg',
  maxWidth: '94ch !custom',
  paddingTop: 'xl',
  selectors: { ':where(&) :where(a)': { color: 'text', textDecorationLine: 'underline' } },
})

export const dot = style({ color: 'accent' })

export const demos = style({
  alignItems: 'center',
  columnGap: 'cell',
  display: 'flex',
  flexWrap: 'wrap',
  rowGap: 'xs',
})

export const toggle = style({ border: '1px solid', borderColor: 'rule', display: 'inline-flex' })

export const demo = variants({
  base: {
    alignItems: 'center',
    color: 'text',
    display: 'flex',
    gap: 'cell',
    paddingBlock: 'xs',
    paddingInline: 'cell',
    textDecorationLine: 'none',
    ':active': { backgroundColor: 'text', color: 'bg' },
    ':hover': { backgroundColor: 'accent', color: 'onAccent' },
    selectors: { '& + &': { borderLeft: '1px solid', borderLeftColor: 'rule' } },
  },
  variants: {
    current: {
      false: {},
      true: {
        ':not(:hover)': {
          backgroundColor: 'text',
          boxShadow:
            'inset 0 -2px 0 var(--z-nanocode-color-accent, light-dark(#ea4c0a, #ff5c1a)) !custom',
          color: 'bg',
        },
      },
    },
  },
  defaultVariants: { current: false },
})

export const logo = style({
  fill: 'currentColor !custom',
  flexShrink: 0,
  height: 'icon',
  width: 'auto !custom',
})

export const lead = style({ maxWidth: 'prose' })

export const docs = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
  maxWidth: 'column',
  paddingTop: 'xl',
  selectors: {
    ':where(&) :where(h1)': { marginBottom: 'sm' },
    ':where(&) :where(h2)': { marginTop: 'lg' },
    ':where(&) :where(a)': { color: 'text', textDecorationLine: 'underline' },
    ':where(&) :where(code)': { fontVariationSettings: '"wght" 500' },
    ':where(&) :where(ul)': {
      display: 'flex',
      flexDirection: 'column',
      gap: 'sm',
      listStyle: 'none',
    },
    ':where(&) :where(ul > li)': { marginLeft: 'indent', position: 'relative' },
    ':where(&) :where(ul > li)::before': {
      content: '"• "',
      left: '-2ch !custom',
      position: 'absolute',
    },
    ':where(&) :where(strong)': { fontVariationSettings: '"wght" 700', fontWeight: 'normal' },
    ':where(&) :where(table)': { borderCollapse: 'collapse' },
    ':where(&) :where(th), :where(&) :where(td)': {
      border: '1px solid',
      borderColor: 'rule',
      paddingInline: 'cell',
      textAlign: 'left',
      verticalAlign: 'top',
    },
    ':where(&) :where(th)': { fontVariationSettings: '"wght" 700', fontWeight: 'normal' },
  },
})

export const block = style({
  backgroundColor: 'surface',
  border: '1px solid',
  borderColor: 'rule',
  selectors: {
    ':where(&) :where(pre code)': { display: 'block', fontVariationSettings: 'normal' },
  },
})

export const blockHeader = style({
  alignItems: 'start',
  display: 'flex',
  justifyContent: 'space-between',
})

export const blockLabel = style({
  backgroundColor: 'surface',
  color: 'text',
  paddingInline: 'cell',
})

export const diagram = style({
  overflowX: 'auto',
  paddingBlock: 'md',
  paddingInline: 'indent',
  selectors: { ':where(&) :where(pre)': { margin: '0', whiteSpace: 'pre' } },
})

export const cards = style({
  display: 'grid',
  gap: 'indent',
  gridTemplateColumns: 'repeat(auto-fill, minmax(30ch, 1fr)) !custom',
})

export const card = style({
  border: '1px solid',
  borderColor: 'rule',
  color: 'text',
  display: 'flex',
  flexDirection: 'column',
  paddingBlock: 'sm',
  paddingInline: 'cell',
  textDecorationLine: 'none',
  ':active': { backgroundColor: 'text', color: 'bg' },
  ':hover': { backgroundColor: 'accent', color: 'onAccent' },
})

export const cardTitle = style({ fontVariationSettings: '"wght" 700' })

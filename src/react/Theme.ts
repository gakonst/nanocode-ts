/**
 * Zyzz theme of the skins: the design tokens, the style helpers, and the keyframes.
 *
 * @module
 */
import { type Config, defineConfig, defineVars, Vars } from 'zyzz'
import { keyframes } from 'zyzz/web'

/** Design tokens of the skins. */
export const tokens = defineVars(
  {
    color: {
      accent: { dark: '#ff5c1a', light: '#ea4c0a' },
      agent: { dark: '#3fd7e8', light: '#0a7c8c' },
      bg: { dark: '#0c0c0d', light: '#f1efe8' },
      middle: { dark: '#8b8882', light: '#6f6c64' },
      onAccent: '#ffffff',
      rule: { dark: '#2b2a2e', light: '#cdc9bd' },
      surface: { dark: '#151517', light: '#e7e4db' },
      text: { dark: '#e8e6e1', light: '#141414' },
      transparent: 'transparent',
    },
    fontFamily: {
      mono: '"CommitMono", monospace',
    },
    fontSize: {
      body: '0.8125rem',
      title: '1.5rem',
    },
    lineHeight: {
      body: '1.0625rem',
      title: '2rem',
    },
    opacity: {
      dim: 0.7,
      faint: 0.5,
      muted: 0.35,
    },
    spacing: {
      '0': '0',
      '2xl': '4rem',
      card: '30ch',
      cell: '1ch',
      column: '78ch',
      gutter: '4ch',
      icon: '1em',
      indent: '2ch',
      lg: '2rem',
      md: '1rem',
      nav: '3.25rem',
      prose: '54ch',
      sidebar: '22ch',
      sm: '0.5rem',
      xl: '3rem',
      xs: '0.25rem',
    },
  },
  (vars) => ({
    color: {
      backdrop: Vars.compose('color', ['color-mix(in srgb, ', vars.color.bg, ' 85%, transparent)']),
      highlight: Vars.compose('color', [
        'color-mix(in srgb, ',
        vars.color.accent,
        ' 18%, transparent)',
      ]),
      wash: Vars.compose('color', ['color-mix(in srgb, ', vars.color.bg, ' 60%, transparent)']),
    },
  }),
  { id: 'nanocode' },
)

export const { style, variants, vars } = defineConfig({
  defaultVars: 'base',
  id: 'nanocode',
  vars: { base: tokens },
})

/** Keyframes of a flicker. */
export const flicker = keyframes({
  '0%, 49%': { opacity: 0 },
  '50%, 100%': { opacity: 1 },
})

/** Keyframes of a pulse. */
export const pulse = keyframes({
  '50%': { opacity: 0.6, transform: 'scale(0.7)' },
})

/** Keyframes of a spin. */
export const spin = keyframes({
  to: { transform: 'rotate(360deg)' },
})

/** Keyframes of an animated ellipsis. */
export const ellipsis = keyframes({
  from: { width: '0' },
  to: { width: '3ch' },
})

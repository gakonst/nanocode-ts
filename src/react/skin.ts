import type { Skin } from './index.tsx'
import * as machines from './machines.styles.ts'
import * as styles from './styles.ts'

export { styles }

export { ellipsis, flicker, style, tokens, variants, vars } from './theme.ts'

export const skin: Skin = {
  parts: { ...styles, ...machines } as unknown as NonNullable<Skin['parts']>,
}

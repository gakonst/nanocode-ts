import type { Skin } from './index.tsx'
import * as machines from './Machines.styles.ts'
import * as styles from './Skin.styles.ts'

export { styles }

export { ellipsis, flicker, style, tokens, variants, vars } from './Theme.ts'

export const skin: Skin = {
  parts: { ...styles, ...machines } as unknown as NonNullable<Skin['parts']>,
}

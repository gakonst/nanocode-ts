/**
 * Default skin: the part styles of the chat and machines components, and the style helpers of the theme.
 *
 * @module
 */
import type { Skin } from './index.tsx'
import * as machines from './Machines.styles.ts'
import * as styles from './Skin.styles.ts'

export { styles }

export { ellipsis, flicker, style, tokens, variants, vars } from './Theme.ts'

/** Default skin. */
export const skin: Skin = {
  parts: { ...styles, ...machines } as unknown as NonNullable<Skin['parts']>,
}

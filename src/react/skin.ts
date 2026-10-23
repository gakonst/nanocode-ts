import type { Skin } from "./index.tsx";
import * as styles from "./styles.ts";

export { styles };

export { ellipsis, flicker, style, tokens, variants, vars } from "./theme.ts";

export const skin: Skin = { parts: styles as unknown as NonNullable<Skin["parts"]> };

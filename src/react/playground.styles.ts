import { style, variants } from "./theme.ts";

const ROUND = "var(--nc-radius, 0) !custom";

export const playground = style({ display: "flex", flexDirection: "column", gap: "lg", minWidth: "0" });

export const controls = style({ display: "flex", flexDirection: "column", gap: "sm" });

export const bar = style({ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "sm" });

export const label = style({ color: "middle", minWidth: "10ch !custom" });

export const option = variants({
  base: {
    backgroundColor: "transparent",
    border: "1px solid",
    borderColor: "rule",
    color: "text",
    cursor: "pointer",
    font: "inherit !custom",
    paddingBlock: "xs",
    paddingInline: "cell",
    ":focus-visible": { outline: "1px solid", outlineColor: "text", outlineOffset: "1px" },
    ":hover": { borderColor: "accent" },
  },
  variants: { current: { false: {}, true: { backgroundColor: "accent", borderColor: "accent", color: "onAccent" } } },
  defaultVariants: { current: false },
});

export const description = style({ color: "middle", margin: "0" });

export const custom = style({ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "md" });

export const field = style({ alignItems: "center", color: "middle", display: "inline-flex", gap: "xs" });

export const swatch = style({ backgroundColor: "transparent", border: "1px solid", borderColor: "rule", cursor: "pointer", height: "1.5rem !custom", padding: "0", width: "2.5rem !custom" });

export const select = style({ backgroundColor: "surface", border: "1px solid", borderColor: "rule", color: "text", font: "inherit !custom", paddingBlock: "0.125rem !custom", paddingInline: "xs" });

export const stage = style({
  backgroundColor: "bg",
  border: "1px solid",
  borderColor: "rule",
  color: "text",
  display: "flex",
  flexDirection: "column",
  gap: "md",
  minWidth: "0",
  padding: "md",
});

export const pane = style({ display: "flex", flexDirection: "column", gap: "md", minWidth: "0" });

export const card = style({ backgroundColor: "surface", border: "1px solid", borderColor: "rule", borderRadius: ROUND, display: "flex", flexDirection: "column", gap: "sm", padding: "md" });

export const cardTitle = style({ fontVariationSettings: '"wght" 700', fontWeight: "600 !custom", margin: "0" });

export const cardText = style({ color: "middle", margin: "0", whiteSpace: "pre-wrap" });

export const actions = style({ display: "flex", flexWrap: "wrap", gap: "sm" });

export const action = variants({
  base: {
    alignItems: "center",
    backgroundColor: "accent",
    border: "1px solid",
    borderColor: "accent",
    borderRadius: ROUND,
    color: "onAccent",
    cursor: "pointer",
    display: "inline-flex",
    font: "inherit !custom",
    gap: "xs",
    paddingBlock: "xs",
    paddingInline: "md",
    textDecorationLine: "none",
    ":disabled": { cursor: "progress", opacity: "faint" },
    ":focus-visible": { outline: "2px solid", outlineColor: "text", outlineOffset: "2px" },
  },
  variants: { quiet: { false: {}, true: { backgroundColor: "transparent", borderColor: "rule", color: "text" } } },
  defaultVariants: { quiet: false },
});

export const result = style({ backgroundColor: "bg", border: "1px solid", borderColor: "rule", borderRadius: ROUND, display: "flex", flexDirection: "column", gap: "xs", minHeight: "4rem !custom", padding: "md" });

export const progress = style({ color: "middle", fontStyle: "italic", margin: "0" });

export const editor = style({
  backgroundColor: "bg",
  border: "1px solid",
  borderColor: "rule",
  borderRadius: ROUND,
  color: "text",
  font: "inherit !custom",
  minHeight: "8rem !custom",
  padding: "md",
  resize: "vertical",
  ":focus-visible": { borderColor: "accent", outline: "none" },
});

export const ghost = style({ color: "middle", fontStyle: "italic", margin: "0", whiteSpace: "pre-wrap" });

export const code = style({ display: "flex", flexDirection: "column", gap: "xs", minWidth: "0" });

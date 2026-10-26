import { flicker, style, variants } from "./theme.ts";

const SANS = 'ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, Arial, sans-serif !custom';
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace !custom';

export const chat = variants({
  base: {
    backgroundColor: "bg",
    border: "none",
    borderRadius: "1.75rem !custom",
    color: "text",
    display: "flex",
    flexDirection: "column",
    fontFamily: SANS,
    fontSize: "0.9375rem !custom",
    lineHeight: "1.5rem !custom",
    overflow: "hidden",
    selectors: { "[data-xframe] &": { borderRadius: "0 !custom", inset: "0 !custom", position: "fixed", zIndex: 200 } },
  },
  variants: {
    expanded: {
      false: {},
      true: { borderRadius: "0 !custom", bottom: "0", left: "0", position: "fixed", right: "0", top: "0", zIndex: 90 },
    },
  },
  defaultVariants: { expanded: false },
});

export const log = variants({
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "md",
    height: "26rem !custom",
    overflowY: "auto",
    paddingBlock: "lg",
    paddingInline: "lg",
    selectors: { "[data-xframe] &": { flex: "1 !custom", height: "auto !custom", minHeight: "0" } },
  },
  variants: {
    expanded: { false: {}, true: { flex: "1 !custom", height: "auto !custom", marginInline: "auto !custom", maxWidth: "48rem !custom", minHeight: "0", width: "100% !custom" } },
  },
  defaultVariants: { expanded: false },
});

export const turn = style({
  display: "flex",
  flexDirection: "column",
  gap: "sm",
  minWidth: "0",
  selectors: { '&:has(> [data-kind="user"])': { alignItems: "flex-end" } },
});

export const speaker = variants({
  base: { margin: "0", userSelect: "none" },
  variants: {
    who: {
      agent: { display: "none" },
      you: { display: "none" },
    },
  },
});

export const entry = variants({
  base: { margin: "0", minWidth: "0", overflowWrap: "break-word", whiteSpace: "pre-wrap" },
  variants: {
    kind: {
      assistant: {},
      cell: { whiteSpace: "normal" },
      error: { color: "accent" },
      reasoning: { color: "middle", fontSize: "0.875rem !custom", fontStyle: "italic" },
      tool: { color: "middle", fontSize: "0.875rem !custom" },
      user: { backgroundColor: "surface", borderRadius: "1.5rem !custom", maxWidth: "70% !custom", paddingBlock: "0.625rem !custom", paddingInline: "1.125rem !custom" },
    },
    live: {
      false: {},
      true: {
        "::after": {
          animationDuration: "1s",
          animationIterationCount: "infinite",
          animationName: flicker,
          animationTimingFunction: "steps(1, end)",
          color: "text",
          content: '" ●"',
        },
        "@media (prefers-reduced-motion: reduce)": { "::after": { animationName: "none" } },
      },
    },
  },
  defaultVariants: { live: false },
});

export const paragraph = style({
  margin: "0",
  selectors: {
    "& + &": { marginTop: "0.75rem !custom" },
    '[data-live="true"] > &:last-child, [data-live="true"] > [data-nc="markdown"] > &:last-child': { display: "inline" },
  },
});

export const heading = style({ fontSize: "1.0625rem !custom", fontWeight: "500 !custom", lineHeight: "inherit !custom", marginBlock: "0.75rem 0.25rem !custom" });

export const strong = style({ fontWeight: "600 !custom" });

export const link = style({ color: "accent", textDecorationLine: "none", ":hover": { textDecorationLine: "underline" } });

export const code = variants({
  base: { fontFamily: MONO, fontSize: "0.8125rem !custom", margin: "0", overflowWrap: "anywhere", paddingBlock: "sm", paddingInline: "md", whiteSpace: "pre-wrap" },
  variants: {
    framed: {
      false: {},
      true: { backgroundColor: "surface", borderRadius: "1rem !custom", color: "text", marginBlock: "sm" },
    },
  },
  defaultVariants: { framed: false },
});

export const inline = style({ backgroundColor: "surface", borderRadius: "0.375rem !custom", fontFamily: MONO, fontSize: "0.875em !custom", paddingInline: "0.3em !custom" });

export const tool = variants({
  base: { display: "flex", flexDirection: "column", minWidth: "0" },
  variants: {
    status: { cancelled: {}, completed: {}, failed: {}, running: {}, yielded: {} },
    open: { false: {}, true: {} },
    nested: {
      false: { backgroundColor: "surface", borderRadius: "1rem !custom", paddingBlock: "0.625rem !custom", paddingInline: "md" },
      true: {},
    },
  },
  defaultVariants: { nested: false, open: false },
});

export const header = style({
  alignItems: "center",
  backgroundColor: "transparent",
  border: "none",
  color: "inherit !custom",
  cursor: "pointer",
  display: "flex",
  font: "inherit !custom",
  gap: "0.5rem !custom",
  minWidth: "0",
  padding: "0",
  textAlign: "left",
  textDecorationLine: "none",
  whiteSpace: "nowrap",
  ":focus-visible": { outline: "2px solid", outlineColor: "accent", outlineOffset: "2px" },
});

export const icon = variants({
  base: { display: "inline-block", flexShrink: 0, textAlign: "center", width: "1.25rem !custom" },
  variants: {
    status: {
      cancelled: { color: "middle" },
      completed: { color: "agent" },
      failed: { color: "accent" },
      running: { color: "agent" },
      yielded: { color: "agent" },
    },
  },
});

export const name = style({ flexShrink: 0, fontWeight: "500 !custom" });

export const title = style({ color: "middle", flexShrink: 1, minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" });

export const meta = style({ color: "middle", flexShrink: 0, fontSize: "0.8125rem !custom", whiteSpace: "pre" });

export const body = variants({
  base: {
    backgroundColor: "bg",
    borderRadius: "0.75rem !custom",
    fontFamily: MONO,
    fontSize: "0.8125rem !custom",
    lineHeight: "1.25rem !custom",
    marginBlock: "0",
    marginTop: "sm",
    maxHeight: "20rem !custom",
    overflow: "auto",
    overflowWrap: "anywhere",
    paddingBlock: "sm",
    paddingInline: "0.75rem !custom",
    whiteSpace: "pre-wrap",
  },
  variants: {
    size: { full: { maxHeight: "none !custom" }, nested: { maxHeight: "10rem !custom" }, normal: {} },
    part: { error: { color: "accent" }, input: {}, output: { color: "middle" } },
  },
  defaultVariants: { size: "normal" },
});

export const children = style({ display: "flex", flexDirection: "column", gap: "xs", marginTop: "sm", paddingLeft: "0.75rem !custom" });

export const more = style({ alignSelf: "flex-start", backgroundColor: "transparent", border: "none", color: "accent", cursor: "pointer", font: "inherit !custom", fontSize: "0.8125rem !custom", marginTop: "xs", padding: "0", textDecorationLine: "none" });

export const typing = variants({
  base: { color: "middle", fontSize: "0.8125rem !custom", height: "1.25rem !custom", margin: "0", paddingInline: "lg" },
  variants: { visible: { false: { visibility: "hidden" }, true: {} } },
  defaultVariants: { visible: false },
});

export const row = style({
  alignItems: "center",
  backgroundColor: "surface",
  borderRadius: "1.75rem !custom",
  display: "flex",
  gap: "sm",
  marginBottom: "sm",
  marginInline: "md",
  paddingBlock: "0.375rem !custom",
  paddingLeft: "1.25rem !custom",
  paddingRight: "0.375rem !custom",
  selectors: { '[data-expanded="true"] > &': { marginInline: "auto !custom", maxWidth: "48rem !custom", width: "calc(100% - 2rem) !custom" } },
});

export const chevron = style({ display: "none" });

export const attach = style({ backgroundColor: "transparent", border: "none", color: "text", cursor: "pointer", font: "inherit !custom", fontSize: "1.375rem !custom", padding: "0", textDecorationLine: "none" });

export const input = style({
  backgroundColor: "transparent",
  border: "none",
  color: "text",
  flex: "1 !custom",
  font: "inherit !custom",
  paddingBlock: "0.375rem !custom",
  resize: "none",
  ":focus-visible": { outline: "none" },
  "::placeholder": { color: "middle" },
});

export const send = style({
  alignItems: "center",
  alignSelf: "flex-end",
  backgroundColor: "text",
  border: "none",
  borderRadius: "999px !custom",
  color: "bg",
  cursor: "pointer",
  display: "inline-flex",
  flexShrink: 0,
  height: "2.25rem !custom",
  justifyContent: "center",
  padding: "0",
  width: "2.25rem !custom",
  "::before": { content: '"↑"', fontSize: "1.125rem !custom", fontWeight: "600 !custom" },
  ":focus-visible": { outline: "2px solid", outlineColor: "text", outlineOffset: "2px" },
});

export const key = style({ display: "none" });

export const suggestions = style({ display: "flex", flexWrap: "wrap", gap: "sm", paddingBottom: "sm", paddingInline: "md" });

export const suggestion = variants({
  base: {
    backgroundColor: "transparent",
    border: "1px solid",
    borderColor: "rule",
    borderRadius: "999px !custom",
    color: "text",
    cursor: "pointer",
    font: "inherit !custom",
    fontSize: "0.875rem !custom",
    maxWidth: "100% !custom",
    overflow: "hidden",
    paddingBlock: "0.375rem !custom",
    paddingInline: "0.875rem !custom",
    textDecorationLine: "none",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    ":disabled": { cursor: "default", opacity: "faint" },
    ":hover:not(:disabled)": { backgroundColor: "surface" },
  },
  variants: {
    quiet: { false: {}, true: { border: "none", color: "middle", fontSize: "0.75rem !custom", padding: "0", ":hover:not(:disabled)": { backgroundColor: "transparent", color: "text" } } },
  },
  defaultVariants: { quiet: false },
});

export const status = style({ color: "middle", columnGap: "md", display: "flex", flexWrap: "wrap", fontSize: "0.75rem !custom", justifyContent: "space-between", margin: "0", paddingBottom: "sm", paddingInline: "lg", rowGap: "xs", whiteSpace: "nowrap" });

export const statusText = style({ flex: "1 !custom", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" });

export const actions = style({ columnGap: "md", display: "flex", flexWrap: "wrap", rowGap: "xs" });

export const expand = style({ backgroundColor: "transparent", border: "none", color: "middle", cursor: "pointer", font: "inherit !custom", padding: "0", textDecorationLine: "none", ":hover": { color: "text" }, selectors: { "[data-xframe] &": { display: "none" } } });

export const picker = style({ backgroundColor: "surface", borderRadius: "1rem !custom", display: "flex", flexDirection: "column", marginBottom: "sm", marginInline: "md", maxHeight: "16rem !custom", overflowY: "auto", paddingBlock: "sm", paddingInline: "md" });

export const attachment = style({ alignItems: "center", backgroundColor: "surface", borderRadius: "0.75rem !custom", display: "inline-flex", gap: "xs", maxWidth: "100% !custom", minWidth: "0", paddingBlock: "xs", paddingInline: "sm" });

export const quote = style({ borderLeft: "3px solid", borderLeftColor: "rule", color: "middle", marginBlock: "0", marginInline: "0", paddingLeft: "md" });

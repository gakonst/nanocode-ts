import type { CSSProperties } from "react";
import type { Skin } from "./index.tsx";
import * as chatgpt from "./chatgpt.styles.ts";
import * as claude from "./claude.styles.ts";
import * as gemini from "./gemini.styles.ts";
import * as machines from "./machines.styles.ts";
import * as styles from "./styles.ts";

export type Scheme = "dark" | "light" | "light dark";

export type Tokens = {
  accent?: string;
  agent?: string;
  bg?: string;
  font?: string;
  leading?: string;
  middle?: string;
  onAccent?: string;
  radius?: string;
  rule?: string;
  size?: string;
  surface?: string;
  text?: string;
};

export type Theme = {
  id: string;
  label: string;
  description: string;
  skin: Skin;
  tokens: Tokens;
  scheme?: Scheme;
  greeting?: string | ((hour: number) => string);
  recents?: string;
  placeholder?: string;
};

const VARIABLES: Record<keyof Tokens, string> = {
  accent: "--z-nanocode-color-accent",
  agent: "--z-nanocode-color-agent",
  bg: "--z-nanocode-color-bg",
  font: "--z-nanocode-fontFamily-mono",
  leading: "--z-nanocode-lineHeight-body",
  middle: "--z-nanocode-color-middle",
  onAccent: "--z-nanocode-color-onAccent",
  radius: "--nc-radius",
  rule: "--z-nanocode-color-rule",
  size: "--z-nanocode-fontSize-body",
  surface: "--z-nanocode-color-surface",
  text: "--z-nanocode-color-text",
};

export function tokens(values: Tokens, scheme?: Scheme): CSSProperties {
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) if (value !== undefined) style[VARIABLES[name as keyof Tokens]] = value;
  if (scheme) style.colorScheme = scheme;
  if (values.font) style.fontFamily = "var(--z-nanocode-fontFamily-mono)";
  return style as CSSProperties;
}

export function themeStyle(theme: Theme, scheme?: Scheme): CSSProperties {
  return tokens(theme.tokens, scheme ?? theme.scheme);
}

const base = { ...styles, ...machines } as unknown as NonNullable<Skin["parts"]>;

export const nanocodeTheme: Theme = {
  description: "The default skin: Commit Mono, hairline rules, terminal turns.",
  id: "nanocode",
  label: "nanocode",
  skin: { parts: base },
  tokens: {},
};

const ICONS: Skin["icons"] = { cancelled: "–", completed: "✓", failed: "!", running: ["◐", "◓", "◑", "◒"], yielded: "↻" };

export const chatgptTheme: Theme = {
  description: "The system sans, no agent label, gray bubbles for you and a black send button.",
  greeting: "What can I help with?",
  id: "chatgpt",
  label: "ChatGPT",
  placeholder: "Ask anything",
  scheme: "light dark",
  skin: { icons: ICONS, parts: { ...base, ...(chatgpt as unknown as NonNullable<Skin["parts"]>) } },
  tokens: {
    accent: "light-dark(#0d0d0d, #ececec)",
    agent: "light-dark(#0d0d0d, #ececec)",
    bg: "light-dark(#ffffff, #212121)",
    font: 'ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, Arial, sans-serif',
    leading: "1.75rem",
    middle: "light-dark(#5d5d5d, #afafaf)",
    onAccent: "light-dark(#ffffff, #0d0d0d)",
    radius: "1.5rem",
    rule: "light-dark(#e5e5e5, #3a3a3a)",
    size: "1rem",
    surface: "light-dark(#f4f4f4, #303030)",
    text: "light-dark(#0d0d0d, #ececec)",
  },
};

export const claudeTheme: Theme = {
  description: "Warm paper, a serif answer under a terracotta asterisk and a bordered composer.",
  greeting: hour => hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening",
  id: "claude",
  recents: "Recents",
  label: "Claude",
  placeholder: "How can I help you today?",
  scheme: "light dark",
  skin: { icons: ICONS, parts: { ...base, ...(claude as unknown as NonNullable<Skin["parts"]>) } },
  tokens: {
    accent: "light-dark(#c96442, #d97757)",
    agent: "light-dark(#c96442, #d97757)",
    bg: "light-dark(#faf9f5, #262624)",
    font: '"Styrene B", "Anthropic Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    leading: "1.5rem",
    middle: "light-dark(#73726c, #a6a39b)",
    onAccent: "#ffffff",
    radius: "0.75rem",
    rule: "light-dark(#e5e2d9, #3e3e38)",
    size: "0.9375rem",
    surface: "light-dark(#f0eee6, #30302e)",
    text: "light-dark(#141413, #faf9f5)",
  },
};

export const geminiTheme: Theme = {
  description: "Google Sans, a sparkle for the agent, bubbles for you and a pill composer.",
  greeting: "Hello, there",
  id: "gemini",
  recents: "Recent",
  label: "Gemini",
  placeholder: "Ask Gemini",
  scheme: "light dark",
  skin: { icons: ICONS, parts: { ...base, ...(gemini as unknown as NonNullable<Skin["parts"]>) } },
  tokens: {
    accent: "light-dark(#0b57d0, #a8c7fa)",
    agent: "light-dark(#1a73e8, #8ab4f8)",
    bg: "light-dark(#ffffff, #131314)",
    font: '"Google Sans Text", "Google Sans", Roboto, "Helvetica Neue", Arial, sans-serif',
    leading: "1.5rem",
    middle: "light-dark(#444746, #c4c7c5)",
    onAccent: "light-dark(#ffffff, #062e6f)",
    radius: "1.5rem",
    rule: "light-dark(#dde3ea, #444746)",
    size: "0.9375rem",
    surface: "light-dark(#f0f4f9, #1e1f20)",
    text: "light-dark(#1f1f1f, #e3e3e3)",
  },
};

export const paperTheme: Theme = {
  description: "Only tokens changed: the default skin in ink on paper with a serif face.",
  id: "paper",
  label: "Paper",
  scheme: "light",
  skin: { parts: base },
  tokens: {
    accent: "#b4232c",
    agent: "#1d4ed8",
    bg: "#fbf8f1",
    font: '"Iowan Old Style", "Source Serif 4", Georgia, serif',
    leading: "1.375rem",
    middle: "#6b6459",
    radius: "0.25rem",
    rule: "#ddd5c4",
    size: "0.9375rem",
    surface: "#f4efe3",
    text: "#1c1917",
  },
};

export const phosphorTheme: Theme = {
  description: "Only tokens changed: a green phosphor terminal.",
  id: "phosphor",
  label: "Phosphor",
  scheme: "dark",
  skin: { parts: base },
  tokens: {
    accent: "#39ff88",
    agent: "#7dd3fc",
    bg: "#020a04",
    middle: "#3f8f5c",
    onAccent: "#020a04",
    rule: "#0f3d1f",
    surface: "#04140a",
    text: "#b6ffcf",
  },
};

export const headlessTheme: Theme = {
  description: "No skin at all: the same components render plain, unstyled HTML for you to style.",
  id: "headless",
  label: "Headless",
  skin: {},
  tokens: {},
};

export const themes: readonly Theme[] = [nanocodeTheme, chatgptTheme, claudeTheme, geminiTheme, paperTheme, phosphorTheme, headlessTheme];

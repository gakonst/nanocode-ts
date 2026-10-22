import { codeToTokens, isSupportedLanguage, type Theme } from "@pierre/highlights";
import type { Token } from "./ui.ts";

type Palette = { comment: string; constant: string; fg: string; function: string; keyword: string; name: string; string: string; type: "dark" | "light"; types: string; inserted: string; deleted: string };

function theme(palette: Palette): Theme {
  return {
    appearance: palette.type,
    name: palette.name,
    style: {
      "editor.background": "transparent",
      "editor.foreground": palette.fg,
      syntax: {
        comment: { color: palette.comment, font_style: "italic" },
        constant: palette.constant,
        constructor: palette.types,
        function: palette.function,
        keyword: palette.keyword,
        number: palette.constant,
        property: palette.types,
        string: palette.string,
        type: palette.types,
        "diff.plus": palette.inserted,
        "diff.minus": palette.deleted,
      },
    },
  } as Theme;
}

export const themes = {
  dark: theme({ comment: "#6c6a66", constant: "#ffcf8a", deleted: "#ff6a6a", fg: "#e8e6e1", function: "#3fd7e8", inserted: "#7fd88f", keyword: "#ff6a2b", name: "nanocode-dark", string: "#9ad8d2", type: "dark", types: "#ffb27a" }),
  light: theme({ comment: "#8a8578", constant: "#a15c00", deleted: "#b42318", fg: "#141414", function: "#0a7c8c", inserted: "#1f7a35", keyword: "#d9480f", name: "nanocode-light", string: "#23676f", type: "light", types: "#9a3d00" }),
};

const ALIASES: Record<string, string> = { js: "javascript", ts: "typescript", sh: "bash", shell: "bash", zsh: "bash", console: "bash" };

export function highlight(code: string, language: string): Token[][] {
  const wanted = ALIASES[language] ?? language;
  const lang = isSupportedLanguage(wanted) ? wanted : isSupportedLanguage(language) ? language : "text";
  return codeToTokens(code, { defaultColor: "light-dark()", lang, themes }).tokens.map(line => line.map(token => {
    const color = token.htmlStyle?.color ?? token.color;
    const italic = token.htmlStyle?.["font-style"] === "italic" || Boolean(token.fontStyle && token.fontStyle & 1);
    return { content: token.content, ...(color ? { color } : {}), ...(italic ? { italic } : {}) };
  }));
}

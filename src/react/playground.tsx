"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Config } from "../client.ts";
import { Chat, Markdown, NanocodeProvider, type Highlighter, useAnswer, useConfig, useSend } from "./index.tsx";
import * as styles from "./playground.styles.ts";
import { Block } from "./site.tsx";
import { nanocodeTheme, type Scheme, type Theme, themes as defaults, themeStyle, type Tokens, tokens } from "./themes.ts";

export { styles };

export type FormFactor = "button" | "chat" | "rewrite";

export type PlaygroundProps = {
  configs: Record<FormFactor, Config>;
  highlight?: () => Promise<Highlighter>;
  themes?: readonly Theme[];
  suggestions?: readonly string[];
  status?: ReactNode;
};

const FORMS: readonly { id: FormFactor; label: string; detail: string }[] = [
  { detail: "The standard chat: transcript, tool cells, composer.", id: "chat", label: "Chat" },
  { detail: "A button in your product that runs an agent job and shows its answer.", id: "button", label: "AI button" },
  { detail: "Agent as a function: rewrite a field in place.", id: "rewrite", label: "Inline rewrite" },
];

const SCHEMES: readonly { id: Scheme | "theme"; label: string }[] = [
  { id: "theme", label: "theme" },
  { id: "light", label: "light" },
  { id: "dark", label: "dark" },
];

const FONTS: Record<string, string> = {
  mono: '"CommitMono", ui-monospace, monospace',
  sans: 'Inter, "Helvetica Neue", Arial, sans-serif',
  serif: '"Iowan Old Style", Georgia, serif',
};

const NOTES = "nanocode-ts 0.2 ships the Rust SDK as one WebAssembly module. Durable sessions run in a Cloudflare Durable Object or a Vercel workflow, Code Mode cells run in QuickJS inside the module, and the React components are headless: a skin maps each part to class names, and a theme is a handful of CSS variables.";

const JOBS: readonly { label: string; prompt: string }[] = [
  { label: "Summarize", prompt: "Summarize these release notes in two short bullet points. Answer directly, without tools." },
  { label: "Tweet it", prompt: "Write one tweet (under 240 characters) announcing these release notes. Answer directly, without tools." },
  { label: "Quiz me", prompt: "Write three quiz questions with one-line answers about these release notes. Answer directly, without tools." },
];

const TONES: readonly string[] = ["Shorter", "Friendlier", "More formal", "Fix grammar"];

const DRAFT = "hey team, so the deploy kinda broke yesterday bc the migration ran twice, its fixed now but we should prob add a lock so it dont happen again";

const CUSTOM: Tokens = { accent: "#7c3aed", bg: "#0b0b12", font: FONTS.sans, radius: "12px", surface: "#15151f", text: "#ececf4" };

export function Playground(props: PlaygroundProps) {
  const themes = props.themes ?? defaults;
  const [chosen, setChosen] = useState<string>(themes.find(theme => theme.id === "gemini")?.id ?? themes[0]?.id ?? "nanocode");
  const [form, setForm] = useState<FormFactor>("chat");
  const [scheme, setScheme] = useState<Scheme | "theme">("theme");
  const [custom, setCustom] = useState<Tokens>(CUSTOM);
  const [font, setFont] = useState("sans");

  const theme = useMemo<Theme>(() => {
    if (chosen !== "custom") return themes.find(item => item.id === chosen) ?? nanocodeTheme;
    return { ...nanocodeTheme, description: "Your tokens on the default skin. Pick colors, a face and a radius.", id: "custom", label: "Custom", scheme: "dark", tokens: { ...custom, font: FONTS[font] ?? FONTS.sans! } };
  }, [chosen, custom, font, themes]);

  const style = themeStyle(theme, scheme === "theme" ? undefined : scheme);
  const set = (key: keyof Tokens) => (value: string) => setCustom(current => ({ ...current, [key]: value }));

  return (
    <div {...styles.playground()}>
      <div {...styles.controls()}>
        <div {...styles.bar()} role="radiogroup" aria-label="Theme">
          <span {...styles.label()}>theme</span>
          {[...themes, { id: "custom", label: "Custom" }].map(item => (
            <button aria-checked={item.id === chosen} key={item.id} onClick={() => setChosen(item.id)} role="radio" type="button" {...styles.option({ current: item.id === chosen })}>{item.label}</button>
          ))}
        </div>
        <div {...styles.bar()} role="radiogroup" aria-label="Form factor">
          <span {...styles.label()}>form factor</span>
          {FORMS.map(item => (
            <button aria-checked={item.id === form} key={item.id} onClick={() => setForm(item.id)} role="radio" title={item.detail} type="button" {...styles.option({ current: item.id === form })}>{item.label}</button>
          ))}
        </div>
        <div {...styles.bar()} role="radiogroup" aria-label="Color scheme">
          <span {...styles.label()}>scheme</span>
          {SCHEMES.map(item => (
            <button aria-checked={item.id === scheme} key={item.id} onClick={() => setScheme(item.id)} role="radio" type="button" {...styles.option({ current: item.id === scheme })}>{item.label}</button>
          ))}
        </div>
        {chosen === "custom" && (
          <div {...styles.custom()}>
            <span {...styles.label()}>tokens</span>
            {(["accent", "bg", "surface", "text"] as const).map(key => (
              <label key={key} {...styles.field()}>{key}<input aria-label={key} onChange={event => set(key)(event.target.value)} type="color" value={custom[key] ?? "#000000"} {...styles.swatch()} /></label>
            ))}
            <label {...styles.field()}>font
              <select onChange={event => setFont(event.target.value)} value={font} {...styles.select()}>
                {Object.keys(FONTS).map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label {...styles.field()}>radius<input max={28} min={0} onChange={event => set("radius")(event.target.value + "px")} type="range" value={parseInt(custom.radius ?? "0")} /></label>
          </div>
        )}
        <p {...styles.description()}>{theme.label}: {theme.description} {FORMS.find(item => item.id === form)?.detail}</p>
      </div>

      <div data-theme={theme.id} style={style} {...styles.stage()}>
        {form === "chat" && (
          <NanocodeProvider config={props.configs.chat} skin={theme.skin} {...(props.highlight ? { highlight: props.highlight } : {})}>
            <Chat expandable={false} label={theme.label + " chat"} placeholder={theme.id === "gemini" ? "Ask Gemini-style nanocode" : "Ask the agent"} status={props.status} suggestions={props.suggestions ?? ["What can you do?", "Plot y = sin(x) and show me", "Fetch the top Hacker News story"]} />
          </NanocodeProvider>
        )}
        {form === "button" && (
          <NanocodeProvider config={props.configs.button} skin={theme.skin}>
            <Job />
          </NanocodeProvider>
        )}
        {form === "rewrite" && (
          <NanocodeProvider config={props.configs.rewrite} skin={theme.skin}>
            <Rewrite />
          </NanocodeProvider>
        )}
      </div>

      <div {...styles.code()}>
        <Block code={snippet(theme, form)} label={form === "chat" ? "Chat.tsx" : form === "button" ? "SummarizeButton.tsx" : "Rewrite.tsx"} language="tsx" />
      </div>
    </div>
  );
}

function Job() {
  const config = useConfig();
  const { send, isPending } = useSend();
  const answer = useAnswer();
  const [ran, setRan] = useState<string>();

  return (
    <div {...styles.pane()}>
      <div {...styles.card()}>
        <p {...styles.cardTitle()}>Release notes · v0.2</p>
        <p {...styles.cardText()}>{NOTES}</p>
        <div {...styles.actions()}>
          {JOBS.map(job => (
            <button disabled={isPending} key={job.label} onClick={() => { setRan(job.label); config.clear(); void send(job.prompt + "\n\n" + NOTES); }} type="button" {...styles.action({ quiet: ran !== undefined && ran !== job.label })}>✦ {job.label}</button>
          ))}
        </div>
      </div>
      {ran && (
        <div {...styles.result()} aria-live="polite">
          {answer.text ? <Markdown live={answer.live} text={answer.text} /> : <p {...styles.progress()}>{progress(answer.activity.phase, answer.activity.tool)}</p>}
          {answer.text && answer.busy && <p {...styles.progress()}>{progress(answer.activity.phase, answer.activity.tool)}</p>}
          {answer.error && <p {...styles.progress()}>{answer.error.message}</p>}
        </div>
      )}
    </div>
  );
}

function Rewrite() {
  const config = useConfig();
  const { send, isPending } = useSend();
  const answer = useAnswer();
  const [text, setText] = useState(DRAFT);
  const [previous, setPrevious] = useState<string>();
  const waiting = useRef(false);

  useEffect(() => {
    if (!waiting.current || answer.busy || !answer.text) return;
    waiting.current = false;
    setText(answer.text.trim());
  }, [answer.busy, answer.text]);

  const rewrite = (tone: string) => {
    waiting.current = true;
    setPrevious(text);
    config.clear();
    void send("Rewrite the text below: " + tone.toLowerCase() + ". Reply with only the rewritten text, no quotes, no preamble, no tools.\n\n" + text);
  };

  return (
    <div {...styles.pane()}>
      <textarea aria-label="Message" onChange={event => setText(event.target.value)} readOnly={isPending} value={text} {...styles.editor()} />
      {isPending && <p {...styles.ghost()}>{answer.text || progress(answer.activity.phase, answer.activity.tool)}</p>}
      <div {...styles.actions()}>
        {TONES.map(tone => <button disabled={isPending || !text.trim()} key={tone} onClick={() => rewrite(tone)} type="button" {...styles.action({ quiet: true })}>✦ {tone}</button>)}
        {previous !== undefined && !isPending && <button onClick={() => { setText(previous); setPrevious(undefined); }} type="button" {...styles.action({ quiet: true })}>↶ Undo</button>}
      </div>
    </div>
  );
}

function progress(phase: string, tool: string | undefined): string {
  if (phase === "thinking") return "Thinking…";
  if (phase === "running") return tool === "code" ? "Running code…" : "Running " + (tool ?? "a tool") + "…";
  if (phase === "writing") return "Writing…";
  return "Working…";
}

function literal(values: Tokens): string {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  return "{\n" + entries.map(([key, value]) => "  " + key + ": " + JSON.stringify(value) + ",").join("\n") + "\n}";
}

function snippet(theme: Theme, form: FormFactor): string {
  const known = defaults.some(item => item.id === theme.id);
  const name = theme.id + "Theme";
  const imports = known
    ? "import { " + name + ", themeStyle } from \"nanocode-ts/react/themes\";"
    : "import { nanocodeTheme, tokens } from \"nanocode-ts/react/themes\";";
  const style = known ? "themeStyle(" + name + ")" : "tokens(" + literal(theme.tokens).replace(/\n/g, "\n    ") + ")";
  const skin = known ? name + ".skin" : "nanocodeTheme.skin";

  if (form === "chat") return [
    "import { Chat, NanocodeProvider } from \"nanocode-ts/react\";",
    imports,
    "",
    "export function App() {",
    "  return (",
    "    <div style={" + style + "}>",
    "      <NanocodeProvider config={config} skin={" + skin + "}>",
    "        <Chat />",
    "      </NanocodeProvider>",
    "    </div>",
    "  );",
    "}",
  ].join("\n");

  if (form === "button") return [
    "import { Markdown, NanocodeProvider, useAnswer, useSend } from \"nanocode-ts/react\";",
    imports,
    "",
    "function SummarizeButton(props: { text: string }) {",
    "  const { send, isPending } = useSend();",
    "  const answer = useAnswer();",
    "  return (",
    "    <>",
    "      <button disabled={isPending} onClick={() => send(\"Summarize:\\n\\n\" + props.text)}>✦ Summarize</button>",
    "      {answer.text && <Markdown live={answer.live} text={answer.text} />}",
    "    </>",
    "  );",
    "}",
    "",
    "<div style={" + style + "}>",
    "  <NanocodeProvider config={createConfig({ transport })} skin={" + skin + "}>",
    "    <SummarizeButton text={notes} />",
    "  </NanocodeProvider>",
    "</div>",
  ].join("\n");

  return [
    "import { useAnswer, useSend } from \"nanocode-ts/react\";",
    "",
    "function Rewrite() {",
    "  const { send, isPending } = useSend();",
    "  const answer = useAnswer();",
    "  const [text, setText] = useState(draft);",
    "  useEffect(() => { if (!answer.busy && answer.text) setText(answer.text); }, [answer.busy]);",
    "  return (",
    "    <>",
    "      <textarea value={text} onChange={event => setText(event.target.value)} />",
    "      <button disabled={isPending} onClick={() => send(\"Rewrite, friendlier. Reply with only the text:\\n\\n\" + text)}>",
    "        ✦ Friendlier",
    "      </button>",
    "    </>",
    "  );",
    "}",
  ].join("\n");
}

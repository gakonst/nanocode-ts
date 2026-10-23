"use client";

import { createContext, Fragment, type KeyboardEvent, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Activity, activity, type ChatState, type Config, type Conversation, duration, type Entry, type EntryKind, type PickerItem, type ToolCell as Cell, type Turn, turns } from "../client.ts";

export type Token = { content: string; color?: string; italic?: boolean };

export type Highlighter = (code: string, language: string) => Token[][];

export type Command = { label: string; detail?: string };

export type Suggestion = string | { label: string; onClick(): void; disabled?: boolean };

export type Picker = {
  title?: string;
  items(query: string): PickerItem[];
  filter?: boolean;
  hint?: string;
  onChoose(item: PickerItem): void;
};

export type Part = "actions" | "body" | "cell" | "chat" | "chevron" | "children" | "choice" | "choiceDetail" | "choiceLabel" | "code" | "em" | "entry" | "expand" | "header" | "heading" | "icon" | "image" | "inline" | "input" | "item" | "key" | "link" | "list" | "log" | "marker" | "meta" | "more" | "name" | "paragraph" | "picker" | "pickerHeader" | "pickerMuted" | "pickerQuery" | "pickerTitle" | "quote" | "row" | "rule" | "section" | "send" | "site" | "speaker" | "status" | "statusText" | "strike" | "strong" | "suggestion" | "suggestions" | "table" | "title" | "tool" | "turn" | "typing" | "account" | "accountActions" | "accountAvatar" | "accountLogin" | "accountWho" | "meter" | "meterBolt" | "meterDot" | "meterEmpty" | "meterHead" | "meterName" | "meterRow" | "meterRows" | "meterSpark" | "prompt" | "signIn" | "signInButton" | "spend" | "spendAccent" | "spendCalls" | "spendDot" | "spendEmpty" | "spendSpark" | "spendTitle" | "unlock" | "unlockButton" | "walletCard" | "walletCardActions" | "walletCardButton" | "walletCardText" | "walletCardTitle";

export type PartState = Record<string, string | number | boolean | undefined>;

export type PartProps = { className?: string; style?: Record<string, string | number | undefined> } & Record<string, unknown>;

export type Skin = {
  parts?: Partial<Record<Part, (state: PartState) => PartProps>>;
  icons?: Partial<Record<Cell["status"], string | readonly string[]>>;
};

const EMPTY_SKIN: Skin = {};

const SkinContext = createContext<Skin>(EMPTY_SKIN);

export function useSkin(): Skin {
  return useContext(SkinContext);
}

export function usePart(): (name: Part, state?: PartState) => PartProps {
  const skin = useSkin();
  return useCallback((name: Part, state: PartState = {}) => {
    const attributes: PartProps = { "data-nc": name };
    for (const [key, value] of Object.entries(state)) if (value !== undefined) attributes["data-" + key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase())] = String(value);
    const skinned = skin.parts?.[name]?.(state);
    return skinned ? { ...attributes, ...skinned } : attributes;
  }, [skin]);
}

const ConfigContext = createContext<Config | undefined>(undefined);

const ExpandedContext = createContext<{ open: ReadonlySet<string>; toggle(id: string, open?: boolean): void }>({ open: new Set(), toggle: () => {} });

export function useExpanded(): { open: ReadonlySet<string>; toggle(id: string, open?: boolean): void } {
  return useContext(ExpandedContext);
}

const HighlightContext = createContext<Highlighter | undefined>(undefined);

export function NanocodeProvider(props: { config: Config; highlight?: () => Promise<Highlighter>; skin?: Skin; children: ReactNode }) {
  const [highlighter, setHighlighter] = useState<Highlighter>();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((id: string, value?: boolean) => setOpen(current => {
    const next = new Set(current);
    if (value ?? !next.has(id)) next.add(id);
    else next.delete(id);
    return next;
  }), []);
  const expanded = useMemo(() => ({ open, toggle }), [open, toggle]);
  const { highlight } = props;
  useEffect(() => {
    if (!highlight) return;
    let active = true;
    highlight().then(loaded => { if (active) setHighlighter(() => loaded); }, () => {});
    return () => { active = false; };
  }, [highlight]);
  return (
    <ConfigContext.Provider value={props.config}>
      <SkinContext.Provider value={props.skin ?? EMPTY_SKIN}>
        <ExpandedContext.Provider value={expanded}>
          <HighlightContext.Provider value={highlighter}>{props.children}</HighlightContext.Provider>
        </ExpandedContext.Provider>
      </SkinContext.Provider>
    </ConfigContext.Provider>
  );
}

export function useConfig(): Config {
  const config = useContext(ConfigContext);
  if (!config) throw new Error("useConfig must be used within NanocodeProvider");
  return config;
}

function useChatState<T>(select: (state: ChatState) => T): T {
  const config = useConfig();
  return useSyncExternalStore(config.subscribe, () => select(config.getState()), () => select(config.getState()));
}

export function useTranscript(): { entries: readonly Entry[]; live: readonly Entry[] } {
  const entries = useChatState(state => state.entries);
  const live = useChatState(state => state.live);
  return useMemo(() => ({ entries, live }), [entries, live]);
}

export function useSend(): { send(prompt: string): Promise<void>; cancel(): Promise<void>; canCancel: boolean; isPending: boolean; isIdle: boolean; error: Error | undefined } {
  const config = useConfig();
  const status = useChatState(state => state.status);
  const error = useChatState(state => state.error);
  return { send: config.send, cancel: config.cancel, canCancel: status === "pending" && config.cancellable, isPending: status === "pending", isIdle: status === "idle", error };
}

export function useTurns(): Turn[] {
  const { entries, live } = useTranscript();
  const pending = useChatState(state => state.status === "pending");
  return useMemo(() => turns(entries, live, pending), [entries, live, pending]);
}

export function useActivity(): Activity {
  const live = useChatState(state => state.live);
  const pending = useChatState(state => state.status === "pending");
  return useMemo(() => activity(live, pending), [live, pending]);
}

export function useConversations(): { conversations: readonly Conversation[]; current: string | undefined; enabled: boolean; canCreate: boolean; canSelect: boolean; select(id: string): void; create(): string | undefined; remove(id: string): void } {
  const config = useConfig();
  const conversations = useChatState(state => state.conversations);
  const current = useChatState(state => state.conversation);
  const pending = useChatState(state => state.status === "pending");
  const empty = useChatState(state => state.entries.length === 0);
  const enabled = current !== undefined;
  return { conversations, current, enabled, canCreate: enabled && !empty && (!pending || config.detachable), canSelect: enabled && (!pending || config.detachable), select: config.select, create: config.create, remove: config.remove };
}

export function useNote(): (kind: EntryKind, text: string) => void {
  return useConfig().note;
}

let fallback: Promise<Highlighter> | undefined;

export function useHighlighter(): Highlighter | undefined {
  const provided = useContext(HighlightContext);
  const [loaded, setLoaded] = useState<Highlighter>();
  useEffect(() => {
    if (provided) return;
    let active = true;
    fallback ??= import("../highlight.ts").then(module => module.highlight);
    fallback.then(highlighter => { if (active) setLoaded(() => highlighter); }, () => {});
    return () => { active = false; };
  }, [provided]);
  return provided ?? loaded;
}

export function fences(text: string): ({ kind: "text"; text: string } | { kind: "code"; text: string; language: string })[] {
  const parts: ReturnType<typeof fences> = [];
  const openings = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
  let offset = 0;
  for (const opening of text.matchAll(openings)) {
    if (opening.index < offset) continue;
    const marker = opening[1];
    const start = opening.index + opening[0].length;
    const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`, "gm");
    closing.lastIndex = start;
    const end = closing.exec(text);
    if (opening.index > offset) parts.push({ kind: "text", text: text.slice(offset, opening.index) });
    parts.push({ kind: "code", language: opening[2].trim().split(/\s/)[0] || "text", text: text.slice(start, end?.index ?? text.length) });
    offset = end ? end.index + end[0].length : text.length;
  }
  if (offset < text.length) parts.push({ kind: "text", text: text.slice(offset) });
  return parts;
}

function Tokens(props: { code: string; language: string }) {
  const highlighter = useHighlighter();
  const tokens = useMemo(() => {
    if (!highlighter || !props.language || props.language === "text") return undefined;
    try {
      return highlighter(props.code, props.language);
    } catch {
      return undefined;
    }
  }, [highlighter, props.code, props.language]);
  return <code>{tokens ? tokens.map((line, row) => <span key={row}>{row > 0 && "\n"}{line.map((token, column) => <span key={column} style={{ color: token.color, fontStyle: token.italic ? "italic" : undefined }}>{token.content}</span>)}</span>) : props.code}</code>;
}

export function Code(props: { code: string; language: string; framed?: boolean }) {
  const part = usePart();
  return <pre data-language={props.language} {...part("code", { framed: props.framed ?? false })}><Tokens code={props.code} language={props.language} /></pre>;
}

type PartOf = (name: Part, state?: PartState) => PartProps;

const INLINE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`\n]+)`|\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__|~~(?=\S)(.+?)~~|(?<![*\w])\*(?![\s*])([^*\n]+?)\*(?![*\w])|(?<![_\w])_(?![\s_])([^_\n]+?)_(?![_\w])/g;

function inline(text: string, part: PartOf, key = ""): ReactNode[] {
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > offset) nodes.push(text.slice(offset, match.index));
    const id = key + match.index;
    const strong = match[6] ?? match[7];
    const em = match[9] ?? match[10];
    if (match[2] !== undefined) nodes.push(<img alt={match[1] ?? ""} key={id} loading="lazy" src={match[2]} {...part("image")} />);
    else if (match[4] !== undefined) nodes.push(<a href={match[4]} key={id} rel="noreferrer" target="_blank" {...part("link")}>{inline(match[3] ?? "", part, id + ".")}</a>);
    else if (match[5] !== undefined) nodes.push(<code key={id} {...part("inline")}>{match[5]}</code>);
    else if (strong !== undefined) nodes.push(<strong key={id} {...part("strong")}>{inline(strong, part, id + ".")}</strong>);
    else if (match[8] !== undefined) nodes.push(<del key={id} {...part("strike")}>{inline(match[8], part, id + ".")}</del>);
    else nodes.push(<em key={id} {...part("em")}>{inline(em ?? "", part, id + ".")}</em>);
    offset = match.index + match[0].length;
  }
  if (offset < text.length) nodes.push(text.slice(offset));
  return nodes;
}

const LIST = /^( *)([-*+]|\d{1,9}[.)])(?: +|$)/;

const RULE = /^ {0,3}([-*_])( *\1){2,} *$/;

const HEADING = /^ {0,3}(#{1,6})(?: +(.*?))?(?: +#+)? *$/;

const ROW = /^ *\|.*\| *$/;

const DIVIDER = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;

const QUOTE = /^ {0,3}>/;

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
}

function starts(line: string): boolean {
  return HEADING.test(line) || RULE.test(line) || LIST.test(line) || QUOTE.test(line) || ROW.test(line) || /^ {0,3}(```|~~~)/.test(line);
}

type Render = { part: PartOf; code: MarkdownProps["code"] };

function render(text: string, context: Render, key: string, tight = false): ReactNode[] {
  return fences(text).flatMap((piece, index) => piece.kind === "code"
    ? [<Fragment key={key + index}>{context.code?.(piece.language, piece.text) ?? <Code code={piece.text.replace(/\n$/, "")} framed language={piece.language} />}</Fragment>]
    : blocks(piece.text, context, key + index + ":", tight));
}

function blocks(text: string, context: Render, key: string, tight: boolean): ReactNode[] {
  const { part } = context;
  const nodes: ReactNode[] = [];
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const id = key + nodes.length;
    const heading = HEADING.exec(line);
    const list = LIST.exec(line);
    if (!line.trim()) index++;
    else if (heading) {
      index++;
      if (!heading[2]) continue;
      const level = heading[1].length;
      const Tag = ("h" + level) as "h1";
      nodes.push(<Tag key={id} {...part("heading", { level })}>{inline(heading[2], part)}</Tag>);
    } else if (RULE.test(line)) {
      index++;
      nodes.push(<hr key={id} {...part("rule")} />);
    } else if (ROW.test(line) && (DIVIDER.test(lines[index + 1] ?? "") || (index + 1 >= lines.length - 1 && /^ *\|[ :|-]*$/.test(lines[index + 1] ?? "|")))) {
      const head = cells(line);
      const align = cells(lines[index + 1] ?? "").map(cell => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : undefined);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && ROW.test(lines[index])) rows.push(cells(lines[index++]));
      nodes.push(
        <table key={id} {...part("table")}>
          <thead><tr>{head.map((cell, column) => <th key={column} {...part("cell", { align: align[column], header: true })}>{inline(cell, part)}</th>)}</tr></thead>
          {rows.length > 0 && <tbody>{rows.map((row, number) => <tr key={number}>{head.map((_, column) => <td key={column} {...part("cell", { align: align[column], header: false })}>{inline(row[column] ?? "", part)}</td>)}</tr>)}</tbody>}
        </table>,
      );
    } else if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) quoted.push(lines[index++].replace(/^ {0,3}> ?/, ""));
      nodes.push(<blockquote key={id} {...part("quote")}>{render(quoted.join("\n"), context, id + ":")}</blockquote>);
    } else if (list) {
      const indent = list[1].length;
      const ordered = /\d/.test(list[2]);
      const items: { lines: string[]; width: number }[] = [];
      let loose = false;
      while (index < lines.length) {
        const current = lines[index];
        const marker = LIST.exec(current);
        const leading = current.length - current.trimStart().length;
        if (marker && marker[1].length <= indent + 1 && /\d/.test(marker[2]) === ordered) {
          items.push({ lines: [current.slice(marker[0].length)], width: marker[0].length });
          index++;
        } else if (marker && marker[1].length <= indent + 1) break;
        else if (!current.trim()) {
          let next = index + 1;
          while (next < lines.length && !lines[next].trim()) next++;
          const following = lines[next];
          const nested = following !== undefined && following.length - following.trimStart().length > indent;
          const after = following === undefined ? null : LIST.exec(following);
          const sibling = after !== null && after[1].length <= indent + 1 && /\d/.test(after[2]) === ordered;
          if (!nested && !sibling) break;
          loose = true;
          items[items.length - 1].lines.push("");
          index++;
        } else if (leading > indent) {
          const item = items[items.length - 1];
          item.lines.push(current.slice(Math.min(leading, item.width)));
          index++;
        } else if (!starts(current)) {
          items[items.length - 1].lines.push(current.trim());
          index++;
        } else break;
      }
      const List = ordered ? "ol" : "ul";
      const first = ordered ? Number.parseInt(list[2], 10) : 1;
      nodes.push(
        <List key={id} start={ordered && first !== 1 ? first : undefined} {...part("list", { ordered })}>
          {items.map((item, number) => <li key={number} {...part("item")}>{render(item.lines.join("\n").replace(/\n+$/, ""), context, id + "." + number + ":", !loose)}</li>)}
        </List>,
      );
    } else {
      const paragraph: string[] = [line];
      index++;
      while (index < lines.length && lines[index].trim() && !starts(lines[index])) paragraph.push(lines[index++]);
      const content = inline(paragraph.join("\n"), part, id + ".");
      nodes.push(tight ? <Fragment key={id}>{content}</Fragment> : <p key={id} {...part("paragraph")}>{content}</p>);
    }
  }
  return nodes;
}

export type MarkdownProps = { text: string; code?(language: string, code: string): ReactNode };

export function Markdown(props: MarkdownProps) {
  const part = usePart();
  return <>{render(props.text, { part, code: props.code }, "")}</>;
}

export function Reply(props: MarkdownProps) {
  return <Markdown {...props} />;
}

const SPINNER = ["◐", "◓", "◑", "◒"];

const ICONS: Record<Cell["status"], string> = { running: SPINNER[0], completed: "✓", failed: "✗", cancelled: "⊘", yielded: "↻" };

const INPUT_LINES = 12;

const OUTPUT_LINES = 10;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function Section(props: { text: string; language: string; part: "error" | "input" | "output"; size: "full" | "nested" | "normal"; limit: number; tail: boolean; onMore(): void }) {
  const part = usePart();
  const lines = props.text.split("\n");
  const body = (text: string) => <pre data-language={props.language} {...part("body", { part: props.part, size: props.size })}><Tokens code={text} language={props.language} /></pre>;
  if (lines.length <= props.limit) return body(props.text);
  const shown = props.tail ? lines.slice(-props.limit) : lines.slice(0, props.limit);
  const more = <button onClick={props.onMore} type="button" {...part("more")}>{props.tail ? `… ${lines.length - props.limit} earlier lines` : `… ${lines.length - props.limit} more lines`}</button>;
  return (
    <div {...part("section")}>
      {props.tail && more}
      {body(shown.join("\n"))}
      {!props.tail && more}
    </div>
  );
}

export function ToolCell(props: { cell: Cell; live?: boolean; nested?: boolean; collapsed?: boolean }) {
  const part = usePart();
  const { cell, live = false, nested = false, collapsed = false } = props;
  const expanded = useContext(ExpandedContext);
  const open = expanded.open.has(cell.call_id);
  const running = cell.status === "running";
  const now = useNow(running && live);
  const unsuccessful = cell.status === "failed" || (cell.exit_code !== undefined && cell.exit_code !== 0);
  const input = cell.input.replace(/\s+$/, "");
  const output = cell.output.replace(/\s+$/, "");
  const icons = useSkin().icons;
  const glyph = icons?.[cell.status] ?? (running ? SPINNER : ICONS[cell.status]);
  const icon = typeof glyph === "string" ? glyph : glyph[Math.floor(now / 120) % glyph.length];
  const shown = open || !collapsed;
  return (
    <div data-call={cell.call_id} {...part("tool", { collapsed, nested, open, status: cell.status })}>
      <button aria-expanded={open} onClick={() => expanded.toggle(cell.call_id)} type="button" {...part("header")}>
        <span aria-label={cell.status} {...part("icon", { status: cell.status })}>{icon}</span>
        <span {...part("name")}>{cell.name}</span>
        {cell.title && <span {...part("title")}>{cell.title}</span>}
        <span {...part("meta")}>
          {running ? ` · ${duration(now - cell.started_at)}` : cell.duration_ms !== undefined ? ` · ${duration(cell.duration_ms)}` : ""}
          {cell.status === "cancelled" || cell.status === "failed" ? ` · ${cell.status}` : ""}
          {cell.details.map(detail => ` · ${detail}`).join("")}
        </span>
      </button>
      {shown && input && (!nested || open || cell.body === "diff") && <Section language={cell.body === "diff" ? "diff" : cell.language} limit={open ? Infinity : INPUT_LINES} onMore={() => expanded.toggle(cell.call_id, true)} part="input" size={open ? "full" : nested ? "nested" : "normal"} tail={live && running} text={input} />}
      {shown && cell.children.length > 0 && <div {...part("children")}>{cell.children.map(child => <ToolCell cell={child} collapsed={collapsed} key={child.call_id} live={live} nested />)}</div>}
      {shown && output && (!nested || open || unsuccessful) && <Section language={cell.output_language} limit={open ? Infinity : OUTPUT_LINES} onMore={() => expanded.toggle(cell.call_id, true)} part={unsuccessful ? "error" : "output"} size={open ? "full" : nested ? "nested" : "normal"} tail={live && running} text={output} />}
    </div>
  );
}

export function EntryView(props: { entry: Entry; previous?: Entry; live?: boolean }) {
  const part = usePart();
  const { entry, previous, live = false } = props;
  const label = entry.kind === "user" ? "you" : !previous || previous.kind === "user" ? "agent" : undefined;
  return (
    <div {...part("turn")}>
      {label && <p {...part("speaker", { steer: entry.steer, who: label })}><span aria-hidden="true">●</span> {label}</p>}
      {entry.kind === "tool" && entry.tool ? <div {...part("entry", { kind: "cell" })}><ToolCell cell={entry.tool} live={live} /></div>
        : entry.kind === "assistant" ? <div {...part("entry", { kind: "assistant", live })}><Markdown text={entry.text} /></div>
        : <p {...part("entry", { kind: entry.kind, live })}>{entry.kind === "reasoning" ? entry.text.replace(/\*\*(.+?)\*\*/g, "$1") : entry.text}</p>}
    </div>
  );
}

export type ChatProps = {
  onSubmit?(text: string): void;
  onInput?(text: string): void;
  commands?: readonly Command[];
  picker?: Picker | null;
  onPickerClose?(): void;
  suggestions?: readonly Suggestion[];
  status?: ReactNode;
  actions?: ReactNode;
  extras?: ReactNode;
  after?(entry: Entry, index: number): ReactNode;
  link?: { href: string; label: string };
  placeholder?: string;
  steering?: string;
  activity?: { who: string; text: string };
  empty?: string;
  label?: string;
  expandable?: boolean;
  defaultPrompt?: string;
};

const TYPING_DELAY_MS = 500;

export function Chat(props: ChatProps) {
  const part = usePart();
  const { entries, live } = useTranscript();
  const { send, isPending: busy } = useSend();
  const doing = useActivity();
  const threads = useConversations();
  const [own, setOwn] = useState<Picker | null>(null);
  const picker = props.picker ?? own;
  const [prompt, setPrompt] = useState(props.defaultPrompt ?? "");
  const [highlight, setHighlight] = useState(0);
  const [typing, setTyping] = useState(false);
  const [recalled, setRecalled] = useState(-1);
  const [full, setFull] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!busy) return setTyping(false);
    const timer = setTimeout(() => setTyping(true), TYPING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  useLayoutEffect(() => {
    if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [entries, live, full]);

  useEffect(() => {
    if (!full) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setFull(false);
    };
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    addEventListener("keydown", escape);
    input.current?.focus();
    return () => {
      document.documentElement.style.overflow = overflow;
      removeEventListener("keydown", escape);
    };
  }, [full]);

  useEffect(() => {
    if (props.defaultPrompt !== undefined) setPrompt(props.defaultPrompt);
  }, [props.defaultPrompt]);

  useEffect(() => {
    if (!picker) return;
    setPrompt("");
    const choices = picker ? picker.items("").filter(item => item.kind === "choice") : [];
    setHighlight(Math.max(0, choices.findIndex(item => item.current)));
    if (picker) input.current?.focus();
  }, [picker]);

  const history = useMemo(() => entries.filter(entry => entry.kind === "user").map(entry => entry.text), [entries]);
  const query = !picker && /^\/\S*$/.test(prompt) ? prompt : undefined;
  const items: PickerItem[] = picker ? picker.items(picker.filter ? prompt : "") : query === undefined ? [] : (props.commands ?? []).filter(command => command.label.startsWith(query)).map(command => ({ kind: "choice", ...command }));
  const choices = items.filter(item => item.kind === "choice");
  const highlighted = Math.min(highlight, Math.max(0, choices.length - 1));
  const width = Math.max(0, ...choices.map(item => item.label.length));

  const submit = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setPrompt("");
    setRecalled(-1);
    stick.current = true;
    if (props.onSubmit) props.onSubmit(text);
    else void send(text);
  };

  const choose = (item: PickerItem) => {
    if (!picker) return submit(item.label);
    setPrompt("");
    if (picker === own) setOwn(null);
    picker.onChoose(item);
  };

  const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (picker || choices.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight(Math.min(Math.max(0, highlighted + (event.key === "ArrowDown" ? 1 : -1)), Math.max(0, choices.length - 1)));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPrompt("");
        if (own) setOwn(null);
        else props.onPickerClose?.();
        return;
      }
      if (event.key === "Tab" && !picker && choices[highlighted]) {
        event.preventDefault();
        setPrompt(choices[highlighted].label);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (choices[highlighted]) choose(choices[highlighted]);
        return;
      }
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && history.length && (recalled >= 0 || !prompt) && !prompt.includes("\n")) {
      event.preventDefault();
      const next = event.key === "ArrowUp" ? (recalled < 0 ? history.length - 1 : Math.max(0, recalled - 1)) : recalled < 0 ? -1 : recalled + 1;
      const index = next >= history.length ? -1 : next;
      setRecalled(index);
      setPrompt(index < 0 ? "" : history[index]);
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit(prompt);
  };

  const showTyping = busy && (typing || live.length > 0);
  const phrase = doing.phase === "thinking" ? "is thinking" : doing.phase === "running" ? doing.tool === "code" ? "is running code" : `is running ${doing.tool}` : "is typing";
  const placeholder = picker?.filter ? "type to filter" : busy ? props.steering ?? "Steer the running turn" : props.placeholder ?? "Ask the agent, or type / for commands";
  let position = -1;

  const openHistory = () => setOwn({
    title: "Conversations",
    filter: true,
    hint: "type to filter · enter open · esc cancel",
    items: query => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const listed = threads.conversations
        .map((item): PickerItem => ({ kind: "choice", label: item.title || "New conversation", detail: ago(item.updated), current: item.id === threads.current, value: item.id }))
        .filter(item => words.every(word => item.label.toLowerCase().includes(word)));
      return [{ kind: "choice", label: "+ New conversation", detail: "start fresh", value: "" }, ...listed];
    },
    onChoose: item => {
      if (item.value) threads.select(item.value);
      else threads.create();
    },
  });

  return (
    <section
        aria-label={props.label ?? "Agent"}
        onClick={event => {
          const target = event.target as HTMLElement;
          if (target.closest("a, button, input, textarea, select") || getSelection()?.toString()) return;
          input.current?.focus();
        }}
        {...part("chat", { expanded: full })}
      >
        <div aria-live="polite" onScroll={() => { const node = log.current!; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }} ref={log} {...part("log", { expanded: full })}>
          {entries.length === 0 && live.length === 0 && props.empty && <p {...part("entry", { kind: "tool" })}>{props.empty}</p>}
          {entries.map((entry, index) => <Fragment key={index}><EntryView entry={entry} previous={entries[index - 1]} />{props.after?.(entry, index)}</Fragment>)}
          {live.map((entry, index) => <EntryView entry={entry} key={`live-${entry.tool?.call_id ?? index}`} live previous={index ? live[index - 1] : entries[entries.length - 1]} />)}
        </div>

        <p aria-live="polite" {...part("typing", { visible: showTyping || Boolean(props.activity) })}>
          {showTyping ? <><span {...part("speaker", { who: "agent" })}>agent</span> {phrase}</> : props.activity ? <><span {...part("speaker", { who: "agent" })}>{props.activity.who}</span> {props.activity.text}</> : null}
        </p>

        {props.extras}

        {(picker || items.length > 0) && (
          <div aria-label={picker?.title ?? "Commands"} role="listbox" {...part("picker")}>
            {picker?.title && <p {...part("pickerTitle")}>{picker.title}</p>}
            {picker?.filter && <p {...part("pickerMuted")}>filter: <span {...part("pickerQuery")}>{prompt}</span><span {...part("marker")}>▏</span></p>}
            {picker?.filter && choices.length === 0 && <p {...part("pickerMuted")}>  no matches</p>}
            {items.map(item => {
              if (item.kind === "header") return <p key={`header-${item.label}`} {...part("pickerHeader")}>{item.label}</p>;
              const index = ++position;
              return (
                <button aria-selected={index === highlighted} key={item.value ?? item.label} onClick={() => choose(item)} onMouseMove={() => setHighlight(index)} role="option" style={{ gridTemplateColumns: `2ch ${width}ch 2ch auto` }} type="button" {...part("choice")}>
                  <span {...part("marker")}>{index === highlighted ? "›" : ""}</span>
                  <span {...part("choiceLabel")}>{item.label}</span>
                  <span {...part("marker")}>{item.current ? "✓" : ""}</span>
                  <span {...part("choiceDetail")}>{item.detail}</span>
                </button>
              );
            })}
            {picker && <p {...part("pickerMuted")}>{picker.hint ?? (picker.filter ? "type to filter · enter select · esc cancel" : "enter select · esc cancel")}</p>}
          </div>
        )}

        <div {...part("row")}>
          <span aria-hidden="true" {...part("chevron")}>❯</span>
          <textarea
            aria-label="Prompt"
            onChange={event => {
              setPrompt(event.target.value);
              setHighlight(0);
              setRecalled(-1);
              if (!picker) props.onInput?.(event.target.value);
            }}
            onKeyDown={key}
            placeholder={placeholder}
            ref={input}
            rows={Math.min(8, Math.max(1, prompt.split("\n").length))}
            value={prompt}
            {...part("input")}
          />
          <button onClick={() => submit(prompt)} type="button" {...part("send")}><kbd {...part("key")}>ENTER</kbd></button>
        </div>

        {(props.suggestions?.length ?? 0) > 0 && (
          <div {...part("suggestions")}>
            {props.suggestions!.map(item => typeof item === "string"
              ? <button key={item} onClick={() => submit(item)} type="button" {...part("suggestion")}>{item}</button>
              : <button disabled={item.disabled} key={item.label} onClick={item.onClick} type="button" {...part("suggestion")}>{item.label}</button>)}
          </div>
        )}

        <p {...part("status")}>
          <span {...part("statusText")}>{props.status}</span>
          {(props.actions || threads.enabled) && (
            <span {...part("actions")}>
              {threads.enabled && <button disabled={!threads.canSelect} onClick={openHistory} title="Conversations" type="button" {...part("suggestion", { quiet: true })}>history ({threads.conversations.length})</button>}
              {props.actions}
            </span>
          )}
          {props.link && <a href={props.link.href} rel="noreferrer" target="_blank" {...part("site")}>{props.link.label}</a>}
          {props.expandable !== false && (
            <button aria-label={full ? "Collapse chat" : "Expand chat"} aria-pressed={full} onClick={() => setFull(value => !value)} title={full ? "Collapse (Esc)" : "Expand"} type="button" {...part("expand")}>
              {full ? "↙ collapse" : "↗ expand"}
            </button>
          )}
        </p>
    </section>
  );
}

function ago(time: number): string {
  const seconds = Math.max(0, (Date.now() - time) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(time).toLocaleDateString();
}

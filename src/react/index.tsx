import { createContext, type KeyboardEvent, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type ChatState, type Config, duration, type Entry, type EntryKind, type PickerItem, type ToolCell as Cell } from "../client.ts";

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

const ConfigContext = createContext<Config | undefined>(undefined);

const HighlightContext = createContext<Highlighter | undefined>(undefined);

export function NanocodeProvider(props: { config: Config; highlight?: () => Promise<Highlighter>; children: ReactNode }) {
  const [highlighter, setHighlighter] = useState<Highlighter>();
  const { highlight } = props;
  useEffect(() => {
    if (!highlight) return;
    let active = true;
    highlight().then(loaded => { if (active) setHighlighter(() => loaded); }, () => {});
    return () => { active = false; };
  }, [highlight]);
  return (
    <ConfigContext.Provider value={props.config}>
      <HighlightContext.Provider value={highlighter}>{props.children}</HighlightContext.Provider>
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

export function useSend(): { send(prompt: string): Promise<void>; isPending: boolean; isIdle: boolean; error: Error | undefined } {
  const config = useConfig();
  const status = useChatState(state => state.status);
  const error = useChatState(state => state.error);
  return { send: config.send, isPending: status === "pending", isIdle: status === "idle", error };
}

export function useNote(): (kind: EntryKind, text: string) => void {
  return useConfig().note;
}

export function useHighlighter(): Highlighter | undefined {
  return useContext(HighlightContext);
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

export function Code(props: { code: string; language: string; className?: string }) {
  const highlighter = useHighlighter();
  const tokens = useMemo(() => {
    if (!highlighter || !props.language || props.language === "text") return undefined;
    try {
      return highlighter(props.code, props.language);
    } catch {
      return undefined;
    }
  }, [highlighter, props.code, props.language]);
  return (
    <pre className={props.className ?? "code"} data-language={props.language}>
      <code>{tokens ? tokens.map((line, row) => <span key={row}>{row > 0 && "\n"}{line.map((token, column) => <span key={column} style={{ color: token.color, fontStyle: token.italic ? "italic" : undefined }}>{token.content}</span>)}</span>) : props.code}</code>
    </pre>
  );
}

const INLINE = /!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > offset) nodes.push(text.slice(offset, match.index));
    const key = match.index;
    if (match[2]) nodes.push(<img alt={match[1] ?? ""} className="image" key={key} loading="lazy" src={match[2]} />);
    else if (match[4]) nodes.push(<a href={match[4]} key={key} rel="noreferrer" target="_blank">{match[3]}</a>);
    else if (match[5]) nodes.push(<strong key={key}>{match[5]}</strong>);
    else nodes.push(<code className="inline" key={key}>{match[6]}</code>);
    offset = match.index + match[0].length;
  }
  if (offset < text.length) nodes.push(text.slice(offset));
  return nodes;
}

export function Reply(props: { text: string }) {
  return <>{fences(props.text).map((part, index) => part.kind === "code" ? <Code code={part.text.replace(/\n$/, "")} key={index} language={part.language} /> : <span key={index}>{inline(part.text)}</span>)}</>;
}

const SPINNER = ["◐", "◓", "◑", "◒"];

const ICONS: Record<Cell["status"], string> = { running: SPINNER[0], completed: "✓", failed: "✗", cancelled: "⊘", yielded: "↻" };

const INPUT_LINES = 12;

const OUTPUT_LINES = 10;

const ExpandedContext = createContext<{ open: ReadonlySet<string>; toggle(id: string, open?: boolean): void }>({ open: new Set(), toggle: () => {} });

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function Section(props: { text: string; language: string; className: string; limit: number; tail: boolean; onMore(): void }) {
  const lines = props.text.split("\n");
  if (lines.length <= props.limit) return <Code className={props.className} code={props.text} language={props.language} />;
  const shown = props.tail ? lines.slice(-props.limit) : lines.slice(0, props.limit);
  const more = <button className="tool-more" onClick={props.onMore} type="button">{props.tail ? `… ${lines.length - props.limit} earlier lines` : `… ${lines.length - props.limit} more lines`}</button>;
  return (
    <div className="tool-section">
      {props.tail && more}
      <Code className={props.className} code={shown.join("\n")} language={props.language} />
      {!props.tail && more}
    </div>
  );
}

export function ToolCell(props: { cell: Cell; live?: boolean; nested?: boolean }) {
  const { cell, live = false, nested = false } = props;
  const expanded = useContext(ExpandedContext);
  const open = expanded.open.has(cell.call_id);
  const running = cell.status === "running";
  const now = useNow(running && live);
  const unsuccessful = cell.status === "failed" || (cell.exit_code !== undefined && cell.exit_code !== 0);
  const input = cell.input.replace(/\s+$/, "");
  const output = cell.output.replace(/\s+$/, "");
  const icon = running ? SPINNER[Math.floor(now / 120) % SPINNER.length] : ICONS[cell.status];
  return (
    <div className={`tool tool-${cell.status}${nested ? " tool-nested" : ""}${open ? " tool-open" : ""}`} data-call={cell.call_id}>
      <button aria-expanded={open} className="tool-header" onClick={() => expanded.toggle(cell.call_id)} type="button">
        <span aria-label={cell.status} className="tool-icon">{icon}</span>
        <span className="tool-name">{cell.name}</span>
        {cell.title && <span className="tool-title">{cell.title}</span>}
        <span className="tool-meta">
          {running ? ` · ${duration(now - cell.started_at)}` : cell.duration_ms !== undefined ? ` · ${duration(cell.duration_ms)}` : ""}
          {cell.status === "cancelled" || cell.status === "failed" ? ` · ${cell.status}` : ""}
          {cell.details.map(detail => ` · ${detail}`).join("")}
        </span>
      </button>
      {input && (!nested || open || cell.body === "diff") && <Section className="tool-input" language={cell.body === "diff" ? "diff" : cell.language} limit={open ? Infinity : INPUT_LINES} onMore={() => expanded.toggle(cell.call_id, true)} tail={live && running} text={input} />}
      {cell.children.length > 0 && <div className="tool-children">{cell.children.map(child => <ToolCell cell={child} key={child.call_id} live={live} nested />)}</div>}
      {output && (!nested || open || unsuccessful) && <Section className={`tool-output${unsuccessful ? " tool-error" : ""}`} language={cell.output_language} limit={open ? Infinity : OUTPUT_LINES} onMore={() => expanded.toggle(cell.call_id, true)} tail={live && running} text={output} />}
    </div>
  );
}

export function EntryView(props: { entry: Entry; previous?: Entry; live?: boolean }) {
  const { entry, previous, live = false } = props;
  const label = entry.kind === "user" ? "you" : !previous || previous.kind === "user" ? "agent" : undefined;
  const className = `entry entry-${entry.kind}${live && entry.kind !== "tool" ? " entry-live" : ""}`;
  return (
    <div className="turn">
      {label && <p className={`speaker speaker-${label}`}><span aria-hidden="true">●</span> {label}</p>}
      {entry.kind === "tool" && entry.tool ? <div className="entry entry-cell"><ToolCell cell={entry.tool} live={live} /></div>
        : entry.kind === "assistant" ? <div className={className}><Reply text={entry.text} /></div>
        : <p className={className}>{entry.kind === "reasoning" ? entry.text.replace(/\*\*(.+?)\*\*/g, "$1") : entry.text}</p>}
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
  link?: { href: string; label: string };
  placeholder?: string;
  steering?: string;
  activity?: { who: string; text: string };
  empty?: string;
  label?: string;
};

const TYPING_DELAY_MS = 500;

export function Chat(props: ChatProps) {
  const { entries, live } = useTranscript();
  const { send, isPending: busy } = useSend();
  const picker = props.picker ?? null;
  const [prompt, setPrompt] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [typing, setTyping] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [recalled, setRecalled] = useState(-1);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const toggle = useCallback((id: string, value?: boolean) => setOpen(current => {
    const next = new Set(current);
    if (value ?? !next.has(id)) next.add(id);
    else next.delete(id);
    return next;
  }), []);
  const expanded = useMemo(() => ({ open, toggle }), [open, toggle]);

  useEffect(() => {
    if (!busy) return setTyping(false);
    const timer = setTimeout(() => setTyping(true), TYPING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  useLayoutEffect(() => {
    if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [entries, live]);

  useEffect(() => {
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
        props.onPickerClose?.();
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

  const last = live[live.length - 1];
  const showTyping = busy && (typing || live.length > 0);
  const doing = last?.kind === "reasoning" ? "is thinking" : last?.tool?.status === "running" ? last.tool.name === "code" ? "is running code" : `is running ${last.tool.name}` : "is typing";
  const placeholder = picker?.filter ? "type to filter" : busy ? props.steering ?? "Steer the running turn" : props.placeholder ?? "Ask the agent, or type / for commands";
  let position = -1;

  return (
    <ExpandedContext.Provider value={expanded}>
      <section
        aria-label={props.label ?? "Agent"}
        className="chat"
        onClick={event => {
          const target = event.target as HTMLElement;
          if (target.closest("a, button, input, textarea, select") || getSelection()?.toString()) return;
          input.current?.focus();
        }}
      >
        <div aria-live="polite" className="log" onScroll={() => { const node = log.current!; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }} ref={log}>
          {entries.length === 0 && live.length === 0 && props.empty && <p className="entry entry-tool">{props.empty}</p>}
          {entries.map((entry, index) => <EntryView entry={entry} key={index} previous={entries[index - 1]} />)}
          {live.map((entry, index) => <EntryView entry={entry} key={`live-${entry.tool?.call_id ?? index}`} live previous={index ? live[index - 1] : entries[entries.length - 1]} />)}
        </div>

        <p aria-live="polite" className={showTyping || props.activity ? "typing typing-visible" : "typing"}>
          {showTyping ? <><span className="speaker speaker-agent">agent</span> {doing}</> : props.activity ? <><span className="speaker speaker-agent">{props.activity.who}</span> {props.activity.text}</> : null}
        </p>

        {props.extras}

        {(picker || items.length > 0) && (
          <div aria-label={picker?.title ?? "Commands"} className="picker" role="listbox">
            {picker?.title && <p className="picker-title">{picker.title}</p>}
            {picker?.filter && <p className="picker-muted">filter: <span className="picker-query">{prompt}</span><span className="picker-caret">▏</span></p>}
            {picker?.filter && choices.length === 0 && <p className="picker-muted">  no matches</p>}
            {items.map(item => {
              if (item.kind === "header") return <p className="picker-header" key={`header-${item.label}`}>{item.label}</p>;
              const index = ++position;
              return (
                <button aria-selected={index === highlighted} className="picker-choice" key={item.label} onClick={() => choose(item)} onMouseMove={() => setHighlight(index)} role="option" style={{ gridTemplateColumns: `2ch ${width}ch 2ch auto` }} type="button">
                  <span className="picker-marker">{index === highlighted ? "›" : ""}</span>
                  <span className="picker-label">{item.label}</span>
                  <span className="picker-marker">{item.current ? "✓" : ""}</span>
                  <span className="picker-detail">{item.detail}</span>
                </button>
              );
            })}
            {picker && <p className="picker-muted">{picker.hint ?? (picker.filter ? "type to filter · enter select · esc cancel" : "enter select · esc cancel")}</p>}
          </div>
        )}

        <div className="row">
          <span aria-hidden="true" className="chevron">❯</span>
          <textarea
            aria-label="Prompt"
            className="input"
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
          />
          <button className="send" onClick={() => submit(prompt)} type="button"><kbd className="key">ENTER</kbd></button>
        </div>

        {(props.suggestions?.length ?? 0) > 0 && (
          <div className="suggestions">
            {props.suggestions!.map(item => typeof item === "string"
              ? <button className="suggestion" disabled={busy} key={item} onClick={() => submit(item)} type="button">{item}</button>
              : <button className="suggestion" disabled={item.disabled} key={item.label} onClick={item.onClick} type="button">{item.label}</button>)}
          </div>
        )}

        <p className="status">
          <span className="status-text">{props.status}</span>
          {props.actions && <span className="status-actions">{props.actions}</span>}
          {props.link && <a className="site" href={props.link.href} rel="noreferrer" target="_blank">{props.link.label}</a>}
        </p>
      </section>
    </ExpandedContext.Provider>
  );
}

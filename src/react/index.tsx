"use client";

import { type ChangeEvent, type ClipboardEvent, createContext, type DragEvent, Fragment, type KeyboardEvent, lazy, type ReactNode, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Activity, activity, type Attachment, bytes, type ChatState, type Config, type Conversation, duration, type Entry, type EntryKind, type PickerItem, type ToolCell as Cell, type TransportFiles, type Turn, turns, workspaceFile } from "../client.ts";

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

export type Part = "attach" | "attachment" | "attachmentName" | "attachmentRemove" | "attachmentSize" | "attachmentThumb" | "attachments" | "actions" | "body" | "cell" | "chat" | "chevron" | "children" | "choice" | "choiceDetail" | "choiceLabel" | "code" | "em" | "entry" | "expand" | "figure" | "header" | "heading" | "icon" | "image" | "images" | "inline" | "input" | "item" | "key" | "link" | "list" | "log" | "markdown" | "marker" | "meta" | "more" | "name" | "paragraph" | "picker" | "pickerHeader" | "pickerMuted" | "pickerQuery" | "pickerTitle" | "quote" | "row" | "rule" | "section" | "send" | "site" | "speaker" | "status" | "statusText" | "strike" | "strong" | "suggestion" | "suggestions" | "table" | "title" | "tool" | "turn" | "typing" | "account" | "accountActions" | "accountAvatar" | "accountLogin" | "accountWho" | "meter" | "meterBolt" | "meterDot" | "meterEmpty" | "meterHead" | "meterName" | "meterRow" | "meterRows" | "meterSpark" | "prompt" | "signIn" | "signInButton" | "spend" | "spendAccent" | "spendCalls" | "spendDot" | "spendEmpty" | "spendSpark" | "spendTitle" | "unlock" | "unlockButton" | "walletCard" | "walletCardActions" | "walletCardButton" | "walletCardText" | "walletCardTitle";

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

const LinkContext = createContext<((href: string) => string | undefined) | undefined>(undefined);

export function useLinks() {
  return useContext(LinkContext);
}

const HighlightContext = createContext<{ highlighter?: Highlighter; request?(): void }>({});

export function NanocodeProvider(props: { config: Config; highlight?: () => Promise<Highlighter>; skin?: Skin; links?(href: string): string | undefined; children: ReactNode }) {
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
  const [wanted, setWanted] = useState(false);
  const request = useCallback(() => setWanted(true), []);
  const highlighting = useMemo(() => ({ ...(highlighter ? { highlighter } : {}), ...(highlight ? { request } : {}) }), [highlighter, highlight, request]);
  useEffect(() => {
    if (!highlight || !wanted) return;
    let active = true;
    highlight().then(loaded => { if (active) setHighlighter(() => loaded); }, () => {});
    return () => { active = false; };
  }, [highlight, wanted]);
  useEffect(() => {
    const start = () => void preloadMarkdown().catch(() => {});
    if (typeof requestIdleCallback !== "function") {
      const timer = setTimeout(start, 200);
      return () => clearTimeout(timer);
    }
    const id = requestIdleCallback(start, { timeout: 1500 });
    return () => cancelIdleCallback(id);
  }, []);
  return (
    <ConfigContext.Provider value={props.config}>
      <SkinContext.Provider value={props.skin ?? EMPTY_SKIN}>
        <ExpandedContext.Provider value={expanded}>
          <HighlightContext.Provider value={highlighting}>
            <LinkContext.Provider value={props.links}>{props.children}</LinkContext.Provider>
          </HighlightContext.Provider>
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
  return useSyncExternalStore(config.subscribe, () => select(config.getState()), () => select(config.getServerState()));
}

export function useTranscript(): { entries: readonly Entry[]; live: readonly Entry[] } {
  const entries = useChatState(state => state.entries);
  const live = useChatState(state => state.live);
  return useMemo(() => ({ entries, live }), [entries, live]);
}

export function useSend(): { send(prompt: string, attachments?: readonly Attachment[]): Promise<void>; cancel(): Promise<void>; canCancel: boolean; isPending: boolean; isIdle: boolean; error: Error | undefined } {
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

export function useAnswer(): { text: string; prompt: string | undefined; live: boolean; busy: boolean; activity: Activity; error: Error | undefined } {
  const all = useTurns();
  const doing = useActivity();
  const error = useChatState(state => state.error);
  const last = all[all.length - 1];
  const text = useMemo(() => (last?.blocks ?? []).filter(block => block.kind === "assistant").map(block => block.text).join("\n\n"), [last]);
  return { activity: doing, busy: doing.busy, error, live: last?.live ?? false, prompt: last?.prompt?.text, text };
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

export function useHighlighter(wanted = true): Highlighter | undefined {
  const { highlighter: provided, request } = useContext(HighlightContext);
  const [loaded, setLoaded] = useState<Highlighter>();
  useEffect(() => {
    if (provided || !wanted) return;
    if (request) return request();
    let active = true;
    fallback ??= import("../highlight.ts").then(module => module.highlight);
    fallback.then(highlighter => { if (active) setLoaded(() => highlighter); }, () => {});
    return () => { active = false; };
  }, [provided, request, wanted]);
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
  const highlighter = useHighlighter(!!props.language && props.language !== "text");
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

export function Code(props: { code: string; language: string; framed?: boolean; incomplete?: boolean }) {
  const part = usePart();
  return <pre data-language={props.language} {...part("code", { framed: props.framed ?? false, incomplete: props.incomplete })}><Tokens code={props.code} language={props.language} /></pre>;
}

const IMAGE = /^(https?:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,])/i;

export function imageSource(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  const value = src.trim();
  return IMAGE.test(value) || workspaceFile(value) ? value : undefined;
}

const FILE_TTL_MS = 15_000;

const fileCache = new WeakMap<TransportFiles, Map<string, { at: number; url: Promise<{ url: string; type: string }> }>>();

export function useWorkspaceFile(path: string | undefined): { url?: string; type?: string; failed: boolean } {
  const files = useContext(ConfigContext)?.files;
  const [state, setState] = useState<{ key?: string; url?: string; type?: string; failed: boolean }>({ failed: false });
  const key = files && path ? (files.scope?.() ?? "") + "\0" + path : undefined;
  useEffect(() => {
    if (!files || !path || !key) return;
    let cache = fileCache.get(files);
    if (!cache) fileCache.set(files, cache = new Map());
    let entry = cache.get(key);
    if (!entry || Date.now() - entry.at > FILE_TTL_MS) {
      const url = files.read(path).then(blob => ({ url: URL.createObjectURL(blob), type: blob.type }));
      entry = { at: Date.now(), url };
      cache.set(key, entry);
      url.catch(() => { if (cache!.get(key)?.url === url) cache!.delete(key); });
    }
    let active = true;
    entry.url.then(found => { if (active) setState({ key, url: found.url, type: found.type, failed: false }); }, () => { if (active) setState({ key, failed: true }); });
    return () => { active = false; };
  }, [files, path, key]);
  if (!files || !path) return { failed: true };
  return state.key === key ? { ...(state.url ? { url: state.url } : {}), ...(state.type ? { type: state.type } : {}), failed: state.failed } : { failed: false };
}

function WorkspaceImage(props: { path: string; alt?: string; title?: string }) {
  const part = usePart();
  const skin = useSkin();
  const file = useWorkspaceFile(props.path);
  const [broken, setBroken] = useState(false);
  const failed = file.failed || broken;
  const own = part("image", { failed, loading: !file.url && !failed, source: "workspace" });
  const style = skin.parts?.image ? own.style : { height: "auto", maxWidth: "100%", ...own.style };
  const label = props.alt || props.path;
  if (!file.url || failed) return <span title={props.path} {...part("image", { failed, loading: !failed, source: "workspace" })}>{label}</span>;
  const raster = /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(file.type ?? "");
  return (
    <a href={raster ? file.url : undefined} rel="noreferrer" target="_blank" title={props.title ?? props.alt ?? props.path} {...part("figure", { failed })}>
      <img {...own} alt={props.alt ?? ""} decoding="async" onError={() => setBroken(true)} src={file.url} style={style} />
    </a>
  );
}

function openData(src: string) {
  const comma = src.indexOf(",");
  const head = src.slice(5, comma);
  const body = src.slice(comma + 1);
  const type = head.split(";")[0] || "image/png";
  const bytes = head.endsWith(";base64") ? Uint8Array.from(atob(body), char => char.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const opened = open(url, "_blank");
  if (opened) opened.opener = null;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function Image(props: { src: string; alt?: string; title?: string }) {
  const part = usePart();
  const skin = useSkin();
  const [failed, setFailed] = useState(false);
  const src = imageSource(props.src);
  const path = workspaceFile(src);
  if (path) return <WorkspaceImage alt={props.alt} path={path} {...(props.title ? { title: props.title } : {})} />;
  if (!src) return props.alt ? <span {...part("image", { failed: true })}>{props.alt}</span> : null;
  const data = src.startsWith("data:");
  const own = part("image", { failed, source: data ? "data" : "url" });
  const style = skin.parts?.image ? own.style : { height: "auto", maxWidth: "100%", ...own.style };
  return (
    <a
      href={src}
      onClick={event => {
        if (!data || event.button !== 0) return;
        event.preventDefault();
        try { openData(src); } catch {}
      }}
      rel="noreferrer"
      target="_blank"
      title={props.title ?? props.alt}
      {...part("figure", { failed })}
    >
      {failed ? props.alt || src : <img {...own} alt={props.alt ?? ""} decoding="async" loading="lazy" onError={() => setFailed(true)} src={src} style={style} />}
    </a>
  );
}

export type MarkdownProps = { text: string; live?: boolean; code?(language: string, code: string): ReactNode };

const Streamed = lazy(() => import("./markdown.tsx"));

export function preloadMarkdown(): Promise<unknown> {
  return import("./markdown.tsx");
}

export function Markdown(props: MarkdownProps) {
  const part = usePart();
  const fallback = <div {...part("markdown", { live: props.live })}><p {...part("paragraph")}>{props.text}</p></div>;
  return <Suspense fallback={fallback}><Streamed {...props} /></Suspense>;
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
  const images = cell.images ?? [];
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
      {shown && images.length > 0 && <div {...part("images", { nested })}>{images.map((src, index) => <Image alt={`${cell.name} image ${index + 1}`} key={index} src={src} />)}</div>}
    </div>
  );
}

export type PendingAttachment = { id: string; name: string; size: number; type: string; preview?: string; status: "uploading" | "ready" | "failed"; error?: string; attachment?: Attachment };

export type Attachments = {
  enabled: boolean;
  items: readonly PendingAttachment[];
  ready: Attachment[];
  uploading: boolean;
  dragging: boolean;
  add(files: Iterable<File> | ArrayLike<File>): void;
  remove(id: string): void;
  clear(): void;
  open(): void;
  input: { ref: { current: HTMLInputElement | null }; type: "file"; multiple: true; hidden: true; tabIndex: -1; onChange(event: ChangeEvent<HTMLInputElement>): void };
  onPaste(event: ClipboardEvent): void;
  drop: { onDragOver(event: DragEvent): void; onDragLeave(event: DragEvent): void; onDrop(event: DragEvent): void };
};

export const MAX_ATTACHMENTS = 8;

function pastedName(file: File): string {
  if (file.name && file.name !== "image.png" && file.name !== "image.jpeg") return file.name;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `pasted-${stamp}.${(file.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`;
}

export function useAttachments(options: { max?: number } = {}): Attachments {
  const config = useConfig();
  const files = config.files;
  const max = Math.min(options.max ?? files?.maxFiles ?? MAX_ATTACHMENTS, MAX_ATTACHMENTS);
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const count = useRef(0);
  count.current = items.length;
  const update = (id: string, next: Partial<PendingAttachment>) => setItems(current => current.map(item => item.id === id ? { ...item, ...next } : item));

  const add = useCallback((list: Iterable<File> | ArrayLike<File>) => {
    if (!files) return;
    for (const file of Array.from(list)) {
      const id = Math.random().toString(36).slice(2);
      const name = pastedName(file);
      const base: PendingAttachment = { id, name, size: file.size, type: file.type, status: "uploading", ...(file.type.startsWith("image/") && file.type !== "image/svg+xml" ? { preview: URL.createObjectURL(file) } : {}) };
      if (count.current >= max) {
        setItems(current => [...current, { ...base, status: "failed", error: `at most ${max} attachments per message` }]);
        continue;
      }
      if (files.maxBytes !== undefined && file.size > files.maxBytes) {
        setItems(current => [...current, { ...base, status: "failed", error: `larger than ${bytes(files.maxBytes!)}` }]);
        continue;
      }
      count.current++;
      setItems(current => [...current, base]);
      files.upload(file, name).then(
        attachment => update(id, { status: "ready", attachment, name: attachment.name, type: attachment.type }),
        (error: unknown) => update(id, { status: "failed", error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }, [files, max]);

  const remove = useCallback((id: string) => setItems(current => {
    const found = current.find(item => item.id === id);
    if (found?.preview) URL.revokeObjectURL(found.preview);
    return current.filter(item => item.id !== id);
  }), []);

  const clear = useCallback(() => setItems([]), []);

  const ready = useMemo(() => items.flatMap(item => item.status === "ready" && item.attachment ? [item.attachment] : []), [items]);

  return {
    enabled: Boolean(files),
    items,
    ready,
    uploading: items.some(item => item.status === "uploading"),
    dragging,
    add,
    remove,
    clear,
    open: () => input.current?.click(),
    input: {
      ref: input,
      type: "file",
      multiple: true,
      hidden: true,
      tabIndex: -1,
      onChange: event => {
        if (event.target.files) add(event.target.files);
        event.target.value = "";
      },
    },
    onPaste: event => {
      const pasted = Array.from(event.clipboardData?.files ?? []);
      if (!files || !pasted.length) return;
      event.preventDefault();
      add(pasted);
    },
    drop: {
      onDragOver: event => {
        if (!files || !Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      },
      onDragLeave: () => setDragging(false),
      onDrop: event => {
        setDragging(false);
        if (!files || !event.dataTransfer?.files.length) return;
        event.preventDefault();
        add(event.dataTransfer.files);
      },
    },
  };
}

export function AttachmentList(props: { items: readonly (PendingAttachment | Attachment)[]; onRemove?(id: string): void }) {
  const part = usePart();
  if (!props.items.length) return null;
  return (
    <div {...part("attachments", { editable: Boolean(props.onRemove) })}>
      {props.items.map((item, index) => {
        const pending = "status" in item ? item : undefined;
        const path = pending ? pending.attachment?.path : (item as Attachment).path;
        const image = item.type.startsWith("image/");
        const status = pending?.status ?? "ready";
        return (
          <span key={pending?.id ?? path ?? index} title={pending?.error ?? path ?? item.name} {...part("attachment", { image, status })}>
            {image && (pending?.preview ? <img alt="" src={pending.preview} {...part("attachmentThumb")} /> : path ? <span {...part("attachmentThumb")}><Image alt={item.name} src={path} /></span> : null)}
            <span {...part("attachmentName")}>{item.name}</span>
            <span {...part("attachmentSize")}>{pending?.error ?? (status === "uploading" ? "uploading" : bytes(item.size))}</span>
            {props.onRemove && pending && <button aria-label={`Remove ${item.name}`} onClick={() => props.onRemove!(pending.id)} type="button" {...part("attachmentRemove")}>×</button>}
          </span>
        );
      })}
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
        : entry.kind === "assistant" ? <div {...part("entry", { kind: "assistant", live })}><Markdown live={live} text={entry.text} /></div>
        : <p {...part("entry", { kind: entry.kind, live })}>{entry.kind === "reasoning" ? entry.text.replace(/\*\*(.+?)\*\*/g, "$1") : entry.text}</p>}
      {entry.attachments?.length ? <AttachmentList items={entry.attachments} /> : null}
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
  const { cancel, canCancel, send, isPending: busy } = useSend();
  const attachments = useAttachments();
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
    const attached = attachments.ready;
    if (!text && !attached.length) return;
    if (attachments.uploading) return;
    setPrompt("");
    setRecalled(-1);
    stick.current = true;
    if (props.onSubmit && !attached.length) props.onSubmit(text);
    else void send(text, attached);
    attachments.clear();
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
        {...attachments.drop}
        {...part("chat", { dragging: attachments.dragging, expanded: full })}
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

        <AttachmentList items={attachments.items} onRemove={attachments.remove} />

        <div {...part("row")}>
          <span aria-hidden="true" {...part("chevron")}>❯</span>
          {attachments.enabled && <>
            <input {...attachments.input} />
            <button aria-label="Attach files" onClick={attachments.open} title="Attach files (or paste, or drop)" type="button" {...part("attach")}>+</button>
          </>}
          <textarea
            aria-label="Prompt"
            onChange={event => {
              setPrompt(event.target.value);
              setHighlight(0);
              setRecalled(-1);
              if (!picker) props.onInput?.(event.target.value);
            }}
            onKeyDown={key}
            onPaste={attachments.onPaste}
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
          {(props.actions || threads.enabled || canCancel) && (
            <span {...part("actions")}>
              {canCancel && <button aria-label="Stop the running turn" onClick={() => void cancel()} type="button" {...part("suggestion", { quiet: true })}>stop</button>}
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

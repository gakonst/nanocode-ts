import { duration, type Entry, type EntryKind, type LiveEvent, type PickerItem, type ToolCell, Transcript } from "./client.ts";

export type Token = { content: string; color?: string; italic?: boolean };

export type Highlighter = (code: string, language: string) => Token[][];

export type Command = { label: string; detail?: string };

export type Suggestion = string | { label: string; run(): void; enabled?(): boolean };

export type Picker = {
  title?: string;
  items(query: string): PickerItem[];
  filter?: boolean;
  hint?: string;
  choose(item: PickerItem): void;
};

export type ChatOptions = {
  submit(text: string): void;
  input?(text: string): void;
  commands?: readonly Command[];
  entries?: readonly Entry[];
  save?(entries: readonly Entry[]): void;
  apply?(event: LiveEvent): void;
  highlight?: () => Promise<Highlighter>;
  reply?(text: string, live: boolean): Node;
  revealMs?: number;
  empty?: string;
  placeholder?: string;
  steering?: string;
  suggestions?: readonly Suggestion[];
  status?: string;
  link?: { href: string; label: string };
  label?: string;
  keep?: number;
};

const SPINNER = ["◐", "◓", "◑", "◒"];

const ICONS: Record<ToolCell["status"], string> = { running: SPINNER[0], completed: "✓", failed: "✗", cancelled: "⊘", yielded: "↻" };

const INPUT_LINES = 12;

const OUTPUT_LINES = 10;

const TYPING_DELAY_MS = 500;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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

const INLINE = /!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

export class Renderer {
  private highlighter: Highlighter | undefined;
  private loading: Promise<void> | undefined;
  private readonly load: (() => Promise<Highlighter>) | undefined;
  private readonly cache = new Map<string, Token[][]>();
  private readonly pending = new Set<HTMLElement>();
  readonly expanded = new Set<string>();

  constructor(load?: () => Promise<Highlighter>) {
    this.load = load;
  }

  code(source: string, language: string, className = "code"): HTMLPreElement {
    const pre = element("pre", className);
    const code = element("code", undefined, source);
    pre.dataset.language = language;
    pre.append(code);
    if (language && language !== "text") this.paint(code, source, language);
    return pre;
  }

  private paint(code: HTMLElement, source: string, language: string): void {
    if (!this.highlighter) {
      if (!this.load) return;
      code.dataset.source = source;
      code.dataset.language = language;
      this.pending.add(code);
      this.loading ??= this.load().then(highlighter => {
        this.highlighter = highlighter;
        for (const node of this.pending) if (node.isConnected) this.paint(node, node.dataset.source ?? "", node.dataset.language ?? "text");
        this.pending.clear();
      }, () => this.pending.clear());
      return;
    }
    const key = `${language}\0${source}`;
    let tokens = this.cache.get(key);
    if (!tokens) {
      try {
        tokens = this.highlighter(source, language);
      } catch {
        return;
      }
    }
    this.cache.delete(key);
    this.cache.set(key, tokens);
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    code.replaceChildren(...tokens.flatMap((line, row) => {
      const nodes: Node[] = row ? [document.createTextNode("\n")] : [];
      for (const token of line) {
        const span = element("span", undefined, token.content);
        if (token.color) span.style.color = token.color;
        if (token.italic) span.style.fontStyle = "italic";
        nodes.push(span);
      }
      return nodes;
    }));
  }

  reply(text: string): HTMLElement {
    const container = element("div");
    for (const part of fences(text)) {
      if (part.kind === "code") {
        container.append(this.code(part.text.replace(/\n$/, ""), part.language));
        continue;
      }
      let offset = 0;
      for (const match of part.text.matchAll(INLINE)) {
        if (match.index > offset) container.append(part.text.slice(offset, match.index));
        if (match[2]) {
          const image = element("img", "image");
          image.alt = match[1] ?? "";
          image.loading = "lazy";
          image.src = match[2];
          container.append(image);
        } else if (match[4]) {
          const link = element("a", undefined, match[3]);
          link.href = match[4];
          link.rel = "noreferrer";
          link.target = "_blank";
          container.append(link);
        } else if (match[5]) container.append(element("strong", undefined, match[5]));
        else container.append(element("code", "inline", match[6]));
        offset = match.index + match[0].length;
      }
      if (offset < part.text.length) container.append(part.text.slice(offset));
    }
    return container;
  }

  tool(cell: ToolCell, live: boolean, nested = false, onToggle?: () => void): HTMLElement {
    const open = this.expanded.has(cell.call_id);
    const root = element("div", `tool tool-${cell.status}${nested ? " tool-nested" : ""}${open ? " tool-open" : ""}`);
    root.dataset.call = cell.call_id;
    const header = element("button", "tool-header");
    header.type = "button";
    header.setAttribute("aria-expanded", String(open));
    const icon = element("span", "tool-icon", ICONS[cell.status]);
    icon.setAttribute("aria-label", cell.status);
    header.append(icon, " ", element("span", "tool-name", cell.name));
    if (cell.title) header.append(" ", element("span", "tool-title", cell.title));
    const meta = element("span", "tool-meta");
    if (cell.status === "running") {
      const clock = element("span", "tool-clock");
      clock.dataset.started = String(cell.started_at);
      clock.textContent = ` · ${duration(Date.now() - cell.started_at)}`;
      meta.append(clock);
    } else if (cell.duration_ms !== undefined) meta.append(` · ${duration(cell.duration_ms)}`);
    if (cell.status === "cancelled" || cell.status === "failed") meta.append(` · ${cell.status}`);
    for (const detail of cell.details) meta.append(` · ${detail}`);
    header.append(meta);
    header.addEventListener("click", () => {
      if (this.expanded.has(cell.call_id)) this.expanded.delete(cell.call_id);
      else this.expanded.add(cell.call_id);
      onToggle?.();
    });
    root.append(header);
    const unsuccessful = cell.status === "failed" || (cell.exit_code !== undefined && cell.exit_code !== 0);
    if (cell.input.trim() && (!nested || open || cell.body === "diff")) root.append(this.section(cell.input.replace(/\s+$/, ""), cell.body === "diff" ? "diff" : cell.language, "tool-input", open ? Infinity : INPUT_LINES, live && cell.status === "running", cell.call_id, onToggle));
    if (cell.children.length) {
      const children = element("div", "tool-children");
      for (const child of cell.children) children.append(this.tool(child, live, true, onToggle));
      root.append(children);
    }
    const output = cell.output.replace(/\s+$/, "");
    if (output && (!nested || open || unsuccessful)) root.append(this.section(output, cell.output_language, `tool-output${unsuccessful ? " tool-error" : ""}`, open ? Infinity : OUTPUT_LINES, live && cell.status === "running", cell.call_id, onToggle));
    return root;
  }

  private section(text: string, language: string, className: string, limit: number, tail: boolean, id: string, onToggle?: () => void): HTMLElement {
    const lines = text.split("\n");
    if (lines.length <= limit) return this.code(text, language, className);
    const shown = tail ? lines.slice(-limit) : lines.slice(0, limit);
    const wrapper = element("div", "tool-section");
    const more = element("button", "tool-more", tail ? `… ${lines.length - limit} earlier lines` : `… ${lines.length - limit} more lines`);
    more.type = "button";
    more.addEventListener("click", () => {
      this.expanded.add(id);
      onToggle?.();
    });
    const code = this.code(shown.join("\n"), language, className);
    if (tail) wrapper.append(more, code);
    else wrapper.append(code, more);
    return wrapper;
  }
}

export class Chat {
  readonly element: HTMLElement;
  readonly extras: HTMLElement;
  readonly actions: HTMLElement;
  readonly renderer: Renderer;
  private readonly options: ChatOptions;
  private readonly transcript: Transcript;
  private readonly log: HTMLElement;
  private readonly finished: HTMLElement;
  private readonly current: HTMLElement;
  private readonly typing: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly send: HTMLButtonElement;
  private readonly suggestionBar: HTMLElement;
  private readonly statusText: HTMLElement;
  private list: Entry[];
  private live: Entry[] = [];
  private working = false;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private picker: Picker | null = null;
  private highlight = 0;
  private choices: PickerItem[] = [];
  private offered: readonly Suggestion[];
  private history: string[] = [];
  private recalled = -1;

  constructor(root: HTMLElement, options: ChatOptions) {
    this.options = options;
    this.renderer = new Renderer(options.highlight);
    this.list = [...(options.entries ?? [])];
    this.offered = options.suggestions ?? [];
    this.history = this.list.filter(entry => entry.kind === "user").map(entry => entry.text);
    this.element = element("section", "chat");
    this.element.setAttribute("aria-label", options.label ?? "Agent");
    this.log = element("div", "log");
    this.log.setAttribute("aria-live", "polite");
    this.finished = element("div", "log-entries");
    this.current = element("div", "log-live");
    this.log.append(this.finished, this.current);
    this.typing = element("p", "typing");
    this.typing.setAttribute("aria-live", "polite");
    this.extras = element("div", "chat-extras");
    this.menu = element("div", "picker");
    this.menu.setAttribute("role", "listbox");
    this.menu.hidden = true;
    const row = element("div", "row");
    const chevron = element("span", "chevron", "❯");
    chevron.setAttribute("aria-hidden", "true");
    this.input = element("textarea", "input");
    this.input.rows = 1;
    this.input.setAttribute("aria-label", "Prompt");
    this.send = element("button", "send");
    this.send.type = "button";
    this.send.append(element("kbd", "key", "ENTER"));
    row.append(chevron, this.input, this.send);
    this.suggestionBar = element("div", "suggestions");
    const status = element("p", "status");
    this.statusText = element("span", "status-text", options.status ?? "");
    this.actions = element("span", "status-actions");
    status.append(this.statusText, this.actions);
    if (options.link) {
      const link = element("a", "site", options.link.label);
      link.href = options.link.href;
      link.rel = "noreferrer";
      link.target = "_blank";
      status.append(link);
    }
    this.element.append(this.log, this.typing, this.extras, this.menu, row, this.suggestionBar, status);
    this.transcript = new Transcript({
      add: entry => this.add(entry),
      apply: event => options.apply?.(event),
      live: entries => {
        this.live = entries;
        this.renderLive();
      },
      reducedMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      revealMs: options.revealMs,
    });
    this.element.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      if (target.closest("a, button, input, textarea, select") || getSelection()?.toString()) return;
      this.input.focus();
    });
    this.input.addEventListener("input", () => {
      this.highlight = 0;
      this.recalled = -1;
      this.fit();
      this.renderMenu();
      if (!this.picker) options.input?.(this.input.value);
    });
    this.input.addEventListener("keydown", event => this.key(event));
    this.send.addEventListener("click", () => this.submit(this.input.value));
    this.renderAll();
    this.renderSuggestions();
    this.renderTyping();
    this.renderMenu();
    root.append(this.element);
  }

  get entries(): readonly Entry[] {
    return this.list;
  }

  get busy(): boolean {
    return this.working;
  }

  set busy(value: boolean) {
    if (this.working === value) return;
    this.working = value;
    clearTimeout(this.typingTimer);
    this.typingTimer = value ? setTimeout(() => {
      this.typingTimer = undefined;
      this.renderTyping();
    }, TYPING_DELAY_MS) : undefined;
    this.renderTyping();
    this.renderSuggestions();
    this.renderMenu();
  }

  set status(text: string) {
    this.statusText.textContent = text;
  }

  set suggestions(items: readonly Suggestion[]) {
    this.offered = items;
    this.renderSuggestions();
  }

  get prompt(): string {
    return this.input.value;
  }

  set prompt(text: string) {
    this.input.value = text;
    this.fit();
    this.renderMenu();
  }

  push(event: LiveEvent): void {
    this.transcript.push(event);
  }

  run(callback: () => void): void {
    this.transcript.run(callback);
  }

  note(kind: EntryKind, text: string): void {
    this.transcript.run(() => this.add({ kind, text }));
  }

  pick(picker: Picker | null): void {
    this.picker = picker;
    this.input.value = "";
    this.fit();
    const choices = picker ? picker.items("").filter(item => item.kind === "choice") : [];
    this.highlight = Math.max(0, choices.findIndex(item => item.current));
    this.renderMenu();
    this.input.focus();
  }

  clear(): void {
    this.transcript.reset();
    this.list = [];
    this.renderer.expanded.clear();
    this.options.save?.(this.list);
    this.renderAll();
  }

  refresh(): void {
    this.renderSuggestions();
    this.renderMenu();
  }

  focus(): void {
    this.input.focus();
  }

  dispose(): void {
    this.transcript.reset();
    clearTimeout(this.typingTimer);
    clearInterval(this.ticker);
    this.element.remove();
  }

  private submit(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    this.input.value = "";
    this.fit();
    this.history.push(text);
    this.recalled = -1;
    this.renderMenu();
    this.options.submit(text);
  }

  private add(entry: Entry): void {
    this.list.push(entry);
    const keep = this.options.keep ?? 500;
    const dropped = this.list.length > keep;
    if (dropped) this.list = this.list.slice(-keep);
    this.options.save?.(this.list);
    const stick = this.near();
    if (dropped || this.finished.querySelector(".log-empty")) this.renderAll();
    else this.finished.append(this.turn(entry, this.list[this.list.length - 2], false));
    this.renderLive(stick);
  }

  private near(): boolean {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 48;
  }

  private stick(stick: boolean): void {
    if (stick) this.log.scrollTop = this.log.scrollHeight;
  }

  private renderAll(): void {
    const stick = this.near();
    this.finished.replaceChildren(...(this.list.length || this.live.length ? this.list.map((entry, index) => this.turn(entry, this.list[index - 1], false)) : this.options.empty ? [element("p", "entry entry-tool log-empty", this.options.empty)] : []));
    this.renderLive(stick);
  }

  private renderLive(stick = this.near()): void {
    if (this.live.length && this.finished.querySelector(".log-empty")) this.finished.replaceChildren();
    this.current.replaceChildren(...this.live.map((entry, index) => this.turn(entry, index ? this.live[index - 1] : this.list[this.list.length - 1], true)));
    this.renderTyping();
    const running = this.live.some(entry => entry.tool?.status === "running");
    if (running && this.ticker === undefined) this.ticker = setInterval(() => this.tick(), 100);
    else if (!running && this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    this.stick(stick);
  }

  private tick(): void {
    const frame = SPINNER[Math.floor(performance.now() / 120) % SPINNER.length];
    for (const icon of this.current.querySelectorAll<HTMLElement>(".tool-running > .tool-header > .tool-icon")) icon.textContent = frame;
    for (const clock of this.current.querySelectorAll<HTMLElement>(".tool-clock")) clock.textContent = ` · ${duration(Date.now() - Number(clock.dataset.started))}`;
  }

  private turn(entry: Entry, previous: Entry | undefined, live: boolean): HTMLElement {
    const turn = element("div", "turn");
    const label = entry.kind === "user" ? "you" : !previous || previous.kind === "user" ? "agent" : undefined;
    if (label) {
      const speaker = element("p", `speaker speaker-${label}`);
      const dot = element("span", undefined, "●");
      dot.setAttribute("aria-hidden", "true");
      speaker.append(dot, ` ${label}`);
      turn.append(speaker);
    }
    let body: HTMLElement;
    if (entry.kind === "tool" && entry.tool) body = this.renderer.tool(entry.tool, live, false, () => this.rerender(entry.tool!.call_id));
    else if (entry.kind === "assistant") {
      const custom = this.options.reply?.(entry.text, live);
      body = custom instanceof HTMLElement ? custom : this.renderer.reply(entry.text);
      if (custom && !(custom instanceof HTMLElement)) body.replaceChildren(custom);
    } else body = element("p", undefined, entry.kind === "reasoning" ? entry.text.replace(/\*\*(.+?)\*\*/g, "$1") : entry.text);
    body.classList.add("entry", `entry-${entry.kind}`);
    if (live && entry.kind !== "tool") body.classList.add("entry-live");
    turn.append(body);
    return turn;
  }

  private rerender(id: string): void {
    const index = this.list.findIndex(entry => entry.tool?.call_id === id);
    if (index < 0) return this.renderLive(false);
    const node = this.finished.children[index];
    node?.replaceWith(this.turn(this.list[index], this.list[index - 1], false));
  }

  private renderTyping(): void {
    const visible = this.working && (this.typingTimer === undefined || this.live.length > 0);
    this.typing.className = visible ? "typing typing-visible" : "typing";
    if (!visible) return this.typing.replaceChildren();
    const last = this.live[this.live.length - 1];
    const doing = last?.kind === "reasoning" ? "is thinking" : last?.tool?.status === "running" ? last.tool.name === "code" ? "is running code" : `is running ${last.tool.name}` : "is typing";
    this.typing.replaceChildren(element("span", "speaker speaker-agent", "agent"), ` ${doing}`);
  }

  private renderSuggestions(): void {
    this.suggestionBar.hidden = this.offered.length === 0;
    this.suggestionBar.replaceChildren(...this.offered.map(item => {
      const button = element("button", "suggestion", typeof item === "string" ? item : item.label);
      button.type = "button";
      button.disabled = typeof item === "string" ? this.working : item.enabled ? !item.enabled() : false;
      button.addEventListener("click", () => typeof item === "string" ? this.submit(item) : item.run());
      return button;
    }));
  }

  private items(): PickerItem[] {
    if (this.picker) return this.picker.items(this.picker.filter ? this.input.value : "");
    const query = this.input.value;
    if (!/^\/\S*$/.test(query)) return [];
    return (this.options.commands ?? []).filter(command => command.label.startsWith(query)).map(command => ({ kind: "choice", ...command }));
  }

  private renderMenu(): void {
    const picker = this.picker;
    const items = this.items();
    this.choices = items.filter(item => item.kind === "choice");
    this.highlight = Math.min(this.highlight, Math.max(0, this.choices.length - 1));
    this.input.placeholder = picker?.filter ? "type to filter" : this.working ? this.options.steering ?? "Steer the running turn" : this.options.placeholder ?? "Ask the agent, or type / for commands";
    const open = picker !== null || items.length > 0;
    this.menu.hidden = !open;
    if (!open) return this.menu.replaceChildren();
    this.menu.setAttribute("aria-label", picker?.title ?? "Commands");
    const width = Math.max(0, ...this.choices.map(item => item.label.length));
    const children: HTMLElement[] = [];
    if (picker?.title) children.push(element("p", "picker-title", picker.title));
    if (picker?.filter) {
      const filter = element("p", "picker-muted", "filter: ");
      filter.append(element("span", "picker-query", this.input.value), element("span", "picker-caret", "▏"));
      children.push(filter);
      if (!this.choices.length) children.push(element("p", "picker-muted", "  no matches"));
    }
    let position = -1;
    for (const item of items) {
      if (item.kind === "header") {
        children.push(element("p", "picker-header", item.label));
        continue;
      }
      const index = ++position;
      const button = element("button", "picker-choice");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === this.highlight));
      button.style.gridTemplateColumns = `2ch ${width}ch 2ch auto`;
      button.append(element("span", "picker-marker", index === this.highlight ? "›" : ""), element("span", "picker-label", item.label), element("span", "picker-marker", item.current ? "✓" : ""), element("span", "picker-detail", item.detail ?? ""));
      button.addEventListener("click", () => this.choose(item));
      button.addEventListener("mousemove", () => {
        if (this.highlight === index) return;
        this.highlight = index;
        this.renderMenu();
      });
      children.push(button);
    }
    if (picker) children.push(element("p", "picker-muted", picker.hint ?? (picker.filter ? "type to filter · enter select · esc cancel" : "enter select · esc cancel")));
    this.menu.replaceChildren(...children);
    this.menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  private choose(item: PickerItem): void {
    const picker = this.picker;
    if (picker) {
      this.picker = null;
      this.input.value = "";
      this.fit();
      this.renderMenu();
      picker.choose(item);
      return;
    }
    this.submit(item.label);
  }

  private key(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const open = this.picker !== null || this.choices.length > 0;
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.highlight = Math.min(Math.max(0, this.highlight + (event.key === "ArrowDown" ? 1 : -1)), Math.max(0, this.choices.length - 1));
        return this.renderMenu();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.picker = null;
        this.input.value = "";
        this.fit();
        return this.renderMenu();
      }
      if (event.key === "Tab" && !this.picker && this.choices[this.highlight]) {
        event.preventDefault();
        this.prompt = this.choices[this.highlight].label;
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const choice = this.choices[this.highlight];
        if (choice) this.choose(choice);
        return;
      }
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && this.history.length && (this.recalled >= 0 || !this.input.value) && !this.input.value.includes("\n")) {
      event.preventDefault();
      const next = event.key === "ArrowUp" ? (this.recalled < 0 ? this.history.length - 1 : Math.max(0, this.recalled - 1)) : this.recalled < 0 ? -1 : this.recalled + 1;
      this.recalled = next >= this.history.length ? -1 : next;
      this.input.value = this.recalled < 0 ? "" : this.history[this.recalled];
      this.fit();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    this.submit(this.input.value);
  }

  private fit(): void {
    this.input.rows = Math.min(8, Math.max(1, this.input.value.split("\n").length));
  }
}

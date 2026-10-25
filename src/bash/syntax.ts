import { byte } from "./fs.ts";

export type Part =
  | { type: "text"; value: string; quoted: boolean }
  | { type: "param"; name: string; index?: Word; op: string; arg?: Word; arg2?: Word; quoted: boolean; indirect?: boolean }
  | { type: "command"; body: Script; quoted: boolean }
  | { type: "arith"; expr: Word; quoted: boolean }
  | { type: "tilde"; user: string }
  | { type: "process"; body: Script; output: boolean };

export type Word = Part[];

export type Redirect = { fd: number | null; op: string; target: Word; body?: Word; name?: string };

export type Assign = { name: string; index?: Word; value?: Word; items?: Word[]; keys?: (Word | undefined)[]; append: boolean };

export type TestToken = { op: string } | { word: Word };

export type Command =
  | { type: "simple"; assigns: Assign[]; words: (Word | Assign)[]; redirects: Redirect[]; line?: number }
  | { type: "if"; clauses: { cond: Script; body: Script }[]; otherwise?: Script; redirects: Redirect[] }
  | { type: "for"; name: string; items?: Word[]; body: Script; redirects: Redirect[]; select?: boolean }
  | { type: "cfor"; init: Word; cond: Word; step: Word; body: Script; redirects: Redirect[] }
  | { type: "while"; until: boolean; cond: Script; body: Script; redirects: Redirect[] }
  | { type: "case"; word: Word; items: { patterns: Word[]; body: Script; next: string }[]; redirects: Redirect[] }
  | { type: "group"; body: Script; subshell: boolean; redirects: Redirect[] }
  | { type: "function"; name: string; body: Command; redirects: Redirect[] }
  | { type: "arith"; expr: Word; redirects: Redirect[] }
  | { type: "test"; tokens: TestToken[]; redirects: Redirect[] }
  | { type: "coproc"; name: string; body: Command; redirects: Redirect[] };

export type Pipeline = { negate: boolean; timed?: boolean; commands: Command[] };

export type AndOr = { first: Pipeline; rest: { op: "&&" | "||"; pipeline: Pipeline }[]; background?: boolean; source?: string };

export type Script = AndOr[];

export class SyntaxError extends Error {}

export type Edit = { start: number; end: number; body?: Script; value?: string };

export type Source = { text: string; start: number; edits: Edit[] };

export type Heredoc = { delimiter: string; quoted: boolean; strip: boolean; body: string };

export const sources = new WeakMap<Word, Source>();

export const texts = new WeakMap<object, string | string[]>();

export const heredocs = new WeakMap<Redirect, Heredoc>();

export const forced = new WeakSet<Redirect>();

export const newlines = new WeakSet<AndOr>();

const META = " \t\n;&|()<>";
const RESERVED_STOP = new Set(["then", "elif", "else", "fi", "do", "done", "esac", "}"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPECIAL = "@*#?$!-0";

type Pending = { redirect: Redirect; delimiter: string; strip: boolean; expand: boolean };

export function parse(source: string): Script {
  const parser = new Parser(source);
  const script = parser.list(new Set());
  parser.blanks();
  if (!parser.done()) throw new SyntaxError("syntax error near unexpected token `" + parser.peekToken() + "'");
  return script;
}

export function parseText(source: string): Word {
  return new Parser(source).text();
}

class Parser {
  src: string;
  pos = 0;
  pending: Pending[] = [];
  edits: Edit[] = [];
  #linePos = 0;
  #line = 1;

  constructor(src: string) {
    this.src = src;
  }

  line(): number {
    if (this.pos < this.#linePos) {
      this.#linePos = 0;
      this.#line = 1;
    }
    for (let i = this.#linePos; i < this.pos; i++) if (this.src[i] === "\n") this.#line++;
    this.#linePos = this.pos;
    return this.#line;
  }

  done() {
    return this.pos >= this.src.length;
  }

  peekToken() {
    const rest = this.src.slice(this.pos);
    return rest.match(/^(;;|&&|\|\||[;&|()<>\n]|[^\s;&|()<>]+)/)?.[0].replace("\n", "newline") ?? "EOF";
  }

  fail(): never {
    throw new SyntaxError(this.done() ? "syntax error: unexpected end of file" : "syntax error near unexpected token `" + this.peekToken() + "'");
  }

  blanks() {
    for (;;) {
      const c = this.src[this.pos];
      if (c === " " || c === "\t" || c === "\r") this.pos++;
      else if (c === "\\" && this.src[this.pos + 1] === "\n") this.pos += 2;
      else if (c === "#") {
        while (!this.done() && this.src[this.pos] !== "\n") this.pos++;
      } else break;
    }
  }

  newline() {
    this.pos++;
    for (const heredoc of this.pending.splice(0)) this.heredoc(heredoc);
  }

  separators() {
    for (;;) {
      this.blanks();
      if (this.src[this.pos] === "\n") this.newline();
      else break;
    }
  }

  heredoc(pending: Pending) {
    const lines: string[] = [];
    for (;;) {
      if (this.done()) break;
      let end = this.src.indexOf("\n", this.pos);
      if (end < 0) end = this.src.length;
      let line = this.src.slice(this.pos, end);
      this.pos = Math.min(end + 1, this.src.length);
      if (pending.strip) line = line.replace(/^\t+/, "");
      if (line === pending.delimiter) break;
      lines.push(line + "\n");
    }
    const body = lines.join("");
    heredocs.set(pending.redirect, { body, delimiter: pending.delimiter, quoted: !pending.expand, strip: pending.strip });
    pending.redirect.body = pending.expand ? new Parser(body).text() : [{ type: "text", value: body, quoted: true }];
  }

  starts(text: string) {
    return this.src.startsWith(text, this.pos);
  }

  reserved(): string | undefined {
    const match = this.src.slice(this.pos).match(/^(\[\[|\]\]|[{}!]|[a-z]+)(?=[\s;&|()<>]|$)/);
    return match?.[1];
  }

  eat(word: string) {
    this.separators();
    if (this.reserved() !== word) this.fail();
    this.pos += word.length;
  }

  list(stop: Set<string>): Script {
    const script: Script = [];
    for (;;) {
      this.separators();
      if (this.done() || this.starts(")") || this.starts(";;") || this.starts(";&")) break;
      const word = this.reserved();
      if (word && (stop.has(word) || RESERVED_STOP.has(word))) break;
      const start = this.pos;
      const item = this.andOr();
      script.push(item);
      this.blanks();
      if (this.starts(";;") || this.starts(";&")) break;
      const c = this.src[this.pos];
      if (c === "&" && !this.starts("&&")) {
        item.background = true;
        item.source = this.src.slice(start, this.pos).trim();
      }
      if (c === ";" || (c === "&" && !this.starts("&&"))) this.pos++;
      else if (c === "\n") {
        newlines.add(item);
        this.newline();
      } else break;
    }
    return script;
  }

  andOr(): AndOr {
    const first = this.pipeline();
    const rest: AndOr["rest"] = [];
    for (;;) {
      this.blanks();
      const op = this.starts("&&") ? "&&" : this.starts("||") ? "||" : undefined;
      if (!op) break;
      this.pos += 2;
      this.separators();
      rest.push({ op, pipeline: this.pipeline() });
    }
    return { first, rest };
  }

  pipeline(): Pipeline {
    this.blanks();
    let negate = false;
    let timed = false;
    for (;;) {
      if (this.reserved() === "!") {
        this.pos++;
        negate = !negate;
      } else if (this.reserved() === "time" && /^time(?:\s+-p)?[ \t]+[^\s;&|)#]/.test(this.src.slice(this.pos))) {
        this.pos += 4;
        this.blanks();
        if (/^-p(?=\s)/.test(this.src.slice(this.pos))) this.pos += 2;
        timed = true;
      } else break;
      this.blanks();
    }
    const commands = [this.command()];
    for (;;) {
      this.blanks();
      if (!this.starts("|") || this.starts("||")) break;
      this.pos++;
      if (this.starts("&")) {
        this.pos++;
        commands[commands.length - 1].redirects.push({ fd: 2, op: ">&", target: [{ type: "text", value: "1", quoted: false }] });
      }
      this.separators();
      commands.push(this.command());
    }
    return timed ? { negate, timed, commands } : { negate, commands };
  }

  command(): Command {
    this.blanks();
    const word = this.reserved();
    let command: Command;
    if (word === "if") command = this.ifCommand();
    else if (word === "for") command = this.forCommand();
    else if (word === "coproc") {
      this.pos += 6;
      this.blanks();
      const named = this.src.slice(this.pos).match(/^([A-Za-z_][A-Za-z0-9_]*)[ \t]+(?=[{(])/);
      if (named) this.pos += named[0].length;
      return { type: "coproc", name: named?.[1] ?? "COPROC", body: this.command(), redirects: [] };
    } else if (word === "select") {
      this.pos += 3;
      command = { ...(this.forCommand() as Command & { type: "for" }), select: true };
    }
    else if (word === "while" || word === "until") command = this.whileCommand(word);
    else if (word === "case") command = this.caseCommand();
    else if (word === "{") {
      this.pos++;
      const body = this.list(new Set());
      this.eat("}");
      command = { type: "group", body, subshell: false, redirects: [] };
    } else if (this.starts("((")) {
      this.pos += 2;
      const text = this.until("))");
      command = { type: "arith", expr: new Parser(text).text(), redirects: [] };
      texts.set(command, text);
    } else if (this.starts("(")) {
      this.pos++;
      const body = this.list(new Set());
      this.separators();
      if (!this.starts(")")) this.fail();
      this.pos++;
      command = { type: "group", body, subshell: true, redirects: [] };
    } else if (word === "[[") command = this.testCommand();
    else if (word === "function") {
      this.pos += 8;
      this.blanks();
      const name = this.src.slice(this.pos).match(/^[^\s;&|()<>]+/)?.[0];
      if (!name) this.fail();
      this.pos += name.length;
      this.blanks();
      if (this.starts("()")) this.pos += 2;
      this.separators();
      return { type: "function", name, body: this.command(), redirects: [] };
    } else {
      const fn = this.src.slice(this.pos).match(/^([A-Za-z_][\w.:-]*)[ \t]*\([ \t]*\)/);
      if (fn) {
        this.pos += fn[0].length;
        this.separators();
        return { type: "function", name: fn[1], body: this.command(), redirects: [] };
      }
      return this.simple();
    }
    for (;;) {
      this.blanks();
      if (!this.redirect(command.redirects)) break;
    }
    return command;
  }

  until(end: string): string {
    let depth = 0;
    const start = this.pos;
    while (!this.done()) {
      if (depth === 0 && this.starts(end)) {
        const text = this.src.slice(start, this.pos);
        this.pos += end.length;
        return text;
      }
      const c = this.src[this.pos];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      this.pos++;
    }
    this.fail();
  }

  ifCommand(): Command {
    this.pos += 2;
    const clauses: { cond: Script; body: Script }[] = [];
    let otherwise: Script | undefined;
    for (;;) {
      const cond = this.list(new Set());
      this.eat("then");
      const body = this.list(new Set());
      clauses.push({ cond, body });
      this.separators();
      const next = this.reserved();
      if (next === "elif") {
        this.pos += 4;
        continue;
      }
      if (next === "else") {
        this.pos += 4;
        otherwise = this.list(new Set());
      }
      this.eat("fi");
      return { type: "if", clauses, otherwise, redirects: [] };
    }
  }

  doBody(): Script {
    this.separators();
    if (this.starts(";")) this.pos++;
    this.eat("do");
    const body = this.list(new Set());
    this.eat("done");
    return body;
  }

  forCommand(): Command {
    this.pos += 3;
    this.blanks();
    if (this.starts("((")) {
      this.pos += 2;
      const parts = splitTop(this.until("))"));
      if (parts.length !== 3) this.fail();
      const [init, cond, step] = parts.map(part => new Parser(part).text());
      this.blanks();
      if (this.starts(";")) this.pos++;
      const command: Command = { type: "cfor", init, cond, step, body: this.doBody(), redirects: [] };
      texts.set(command, parts);
      return command;
    }
    const name = this.src.slice(this.pos).match(NAME)?.[0];
    if (!name) this.fail();
    this.pos += name.length;
    this.separators();
    let items: Word[] | undefined;
    if (this.reserved() === "in") {
      this.pos += 2;
      items = [];
      for (;;) {
        this.blanks();
        const c = this.src[this.pos];
        if (this.done() || c === ";" || c === "\n") break;
        items.push(this.word());
      }
    }
    return { type: "for", name, items, body: this.doBody(), redirects: [] };
  }

  whileCommand(word: string): Command {
    this.pos += word.length;
    const cond = this.list(new Set(["do"]));
    return { type: "while", until: word === "until", cond, body: this.doBody(), redirects: [] };
  }

  caseCommand(): Command {
    this.pos += 4;
    this.blanks();
    const word = this.word();
    this.eat("in");
    const items: { patterns: Word[]; body: Script; next: string }[] = [];
    for (;;) {
      this.separators();
      if (this.reserved() === "esac") {
        this.pos += 4;
        break;
      }
      if (this.starts("(")) this.pos++;
      const patterns: Word[] = [];
      for (;;) {
        this.blanks();
        patterns.push(this.word());
        this.blanks();
        if (this.starts("|")) {
          this.pos++;
          continue;
        }
        if (!this.starts(")")) this.fail();
        this.pos++;
        break;
      }
      const body = this.list(new Set(["esac"]));
      this.separators();
      let next = "break";
      if (this.starts(";;&")) {
        this.pos += 3;
        next = "test";
      } else if (this.starts(";;")) this.pos += 2;
      else if (this.starts(";&")) {
        this.pos += 2;
        next = "fall";
      }
      items.push({ patterns, body, next });
    }
    return { type: "case", word, items, redirects: [] };
  }

  testCommand(): Command {
    this.pos += 2;
    const tokens: TestToken[] = [];
    for (;;) {
      this.blanks();
      if (this.done()) this.fail();
      if (this.starts("\n")) {
        this.newline();
        continue;
      }
      if (this.reserved() === "]]") {
        this.pos += 2;
        break;
      }
      const op = ["&&", "||", "(", ")", "<", ">"].find(op => this.starts(op));
      if (op) {
        this.pos += op.length;
        tokens.push({ op });
        continue;
      }
      const last = tokens[tokens.length - 1];
      const regex = last !== undefined && "word" in last && last.word.length === 1 && last.word[0].type === "text" && !last.word[0].quoted && last.word[0].value === "=~";
      tokens.push({ word: this.word(regex) });
    }
    return { type: "test", tokens, redirects: [] };
  }

  simple(): Command {
    const command: Command & { type: "simple" } = { type: "simple", assigns: [], words: [], redirects: [], line: this.line() };
    for (;;) {
      this.blanks();
      if (this.done()) break;
      const c = this.src[this.pos];
      if ((c === "<" || c === ">") && this.src[this.pos + 1] === "(") {
        command.words.push(this.word());
        continue;
      }
      if (this.redirect(command.redirects)) continue;
      if (c === "\n" || c === ";" || c === "|" || c === "&" || c === ")" || c === "(") break;
      const declaring = command.words.length > 0 && isDeclaration(command.words[0]);
      if (!command.words.length || declaring) {
        const assign = this.src.slice(this.pos).match(/^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/);
        if (assign) {
          this.pos += assign[0].length;
          const entry: Assign = { name: assign[1], append: assign[3] === "+" };
          if (assign[2]) {
            entry.index = new Parser(assign[2].slice(1, -1)).text();
            texts.set(entry, assign[2]);
          }
          if (this.starts("(")) {
            this.pos++;
            entry.items = [];
            for (;;) {
              this.separators();
              if (this.starts(")")) {
                this.pos++;
                break;
              }
              if (this.done()) this.fail();
              const key = this.src.slice(this.pos, this.pos + 4096).match(/^\[([^\]\n]*)\]=/);
              if (key) {
                entry.keys ??= [];
                const keyWord = new Parser(key[1]).text();
                sources.set(keyWord, { edits: [], start: 0, text: key[1] });
                entry.keys[entry.items.length] = keyWord;
                this.pos += key[0].length;
                if (this.done() || " \t\n)".includes(this.src[this.pos])) {
                  entry.items.push([{ type: "text", value: "", quoted: true }]);
                  continue;
                }
              }
              entry.items.push(this.word());
            }
          } else entry.value = this.word();
          if (declaring) command.words.push(entry);
          else command.assigns.push(entry);
          continue;
        }
      }
      command.words.push(this.word());
    }
    if (!command.words.length && !command.assigns.length && !command.redirects.length) this.fail();
    return command;
  }

  redirect(redirects: Redirect[]): boolean {
    const match = this.src.slice(this.pos).match(/^(\d*|\{[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?\})(<<<|<<-|<<|<>|<&|>>|>&|>\||&>>|&>|<|>)/);
    if (!match) return false;
    if (match[2].startsWith("&") && match[1]) return false;
    this.pos += match[0].length;
    this.blanks();
    const named = match[1].startsWith("{") ? match[1].slice(1, -1) : undefined;
    const redirect: Redirect = { fd: match[1] && !named ? Number(match[1]) : null, op: match[2] === ">|" ? ">" : match[2], target: [], ...(named !== undefined ? { name: named } : {}) };
    if (match[2] === ">|") forced.add(redirect);
    if (match[2] === "<<" || match[2] === "<<-") {
      const raw = this.src.slice(this.pos).match(/^[^\s;&|()<>]+/)?.[0];
      if (!raw) this.fail();
      this.pos += raw.length;
      const expand = !/['"\\]/.test(raw);
      this.pending.push({ redirect, delimiter: raw.replace(/['"\\]/g, ""), strip: match[2] === "<<-", expand });
    } else {
      const process = this.starts("<(") || this.starts(">(");
      if (!process && (this.done() || META.includes(this.src[this.pos]))) this.fail();
      redirect.target = this.word();
    }
    redirects.push(redirect);
    return true;
  }

  word(regex = false): Word {
    const start = this.pos;
    const outer = this.edits;
    this.edits = [];
    const parts = this.wordParts(regex);
    sources.set(parts, { edits: this.edits, start, text: this.src.slice(start, this.pos) });
    this.edits = outer;
    return parts;
  }

  wordParts(regex: boolean): Word {
    const meta = regex ? " \t\n" : META;
    const parts: Part[] = [];
    if ((this.src[this.pos] === "<" || this.src[this.pos] === ">") && this.src[this.pos + 1] === "(") {
      const output = this.src[this.pos] === ">";
      this.pos += 2;
      const outer = this.pending;
      this.pending = [];
      const body = this.list(new Set());
      this.separators();
      this.pending = outer;
      if (!this.starts(")")) this.fail();
      this.pos++;
      parts.push({ type: "process", body, output });
    }
    if (this.src[this.pos] === "~") {
      const user = this.src.slice(this.pos + 1).match(/^[A-Za-z0-9_-]*(?=[\/\s;&|()<>]|$)/);
      if (user) {
        parts.push({ type: "tilde", user: user[0] });
        this.pos += 1 + user[0].length;
      }
    }
    while (!this.done()) {
      const c = this.src[this.pos];
      if (meta.includes(c)) break;
      if (c === "\\") {
        if (this.src[this.pos + 1] === "\n") this.pos += 2;
        else {
          push(parts, this.src[this.pos + 1] ?? "\\", true);
          this.pos += 2;
        }
      } else if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end < 0) throw new SyntaxError("unexpected EOF while looking for matching `''");
        push(parts, this.src.slice(this.pos + 1, end), true);
        this.pos = end + 1;
      } else if (c === '"') {
        this.pos++;
        push(parts, "", true);
        this.double(parts, '"');
        if (this.src[this.pos] !== '"') throw new SyntaxError("unexpected EOF while looking for matching `\"'");
        this.pos++;
      } else if (c === "$" && this.src[this.pos + 1] === "'") {
        const start = this.pos;
        this.pos += 2;
        let value = "";
        while (!this.done() && this.src[this.pos] !== "'") {
          if (this.src[this.pos] === "\\") {
            const [text, length] = ansiEscape(this.src, this.pos + 1);
            value += text;
            this.pos += 1 + length;
          } else value += this.src[this.pos++];
        }
        if (this.done()) this.fail();
        this.pos++;
        this.edits.push({ end: this.pos, start, value });
        push(parts, value, true);
      } else if (c === "$" || c === "`") parts.push(this.dollar(false));
      else {
        push(parts, c, false);
        this.pos++;
      }
    }
    return parts;
  }

  double(parts: Part[], end: string | undefined) {
    while (!this.done() && this.src[this.pos] !== end) {
      const c = this.src[this.pos];
      if (c === "\\") {
        const next = this.src[this.pos + 1];
        if (next === "\n") this.pos += 2;
        else if (next !== undefined && ("$`\\" + (end ?? "")).includes(next)) {
          push(parts, next, true);
          this.pos += 2;
        } else {
          push(parts, "\\", true);
          this.pos++;
        }
      } else if (c === "$" || c === "`") parts.push(this.dollar(true));
      else {
        push(parts, c, true);
        this.pos++;
      }
    }
  }

  text(): Word {
    const parts: Part[] = [];
    this.double(parts, undefined);
    return parts;
  }

  dollar(quoted: boolean): Part {
    if (this.src[this.pos] === "`") {
      this.pos++;
      let inner = "";
      while (!this.done() && this.src[this.pos] !== "`") {
        if (this.src[this.pos] === "\\" && "$`\\".includes(this.src[this.pos + 1])) {
          inner += this.src[this.pos + 1];
          this.pos += 2;
        } else inner += this.src[this.pos++];
      }
      if (this.done()) this.fail();
      this.pos++;
      return { type: "command", body: parse(inner), quoted };
    }
    this.pos++;
    if (this.starts("((")) {
      const save = this.pos;
      this.pos += 2;
      try {
        return { type: "arith", expr: new Parser(this.until("))")).text(), quoted };
      } catch {
        this.pos = save;
      }
    }
    if (this.starts("(")) {
      const start = this.pos - 1;
      this.pos++;
      const outer = this.pending;
      this.pending = [];
      const body = this.list(new Set());
      this.separators();
      this.pending = outer;
      if (!this.starts(")")) this.fail();
      this.pos++;
      this.edits.push({ body, end: this.pos, start });
      return { type: "command", body, quoted };
    }
    if (this.starts("{")) {
      const start = this.pos++;
      try {
        return this.braced(quoted);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const end = this.closing(start);
        if (end < 0) throw error;
        this.pos = end + 1;
        return { type: "param", name: this.src.slice(start - 1, end + 1), op: "bad", quoted };
      }
    }
    if (this.starts("[")) {
      this.pos++;
      return { type: "arith", expr: new Parser(this.until("]")).text(), quoted };
    }
    const name = this.src.slice(this.pos).match(NAME)?.[0];
    if (name) {
      this.pos += name.length;
      return { type: "param", name, op: "", quoted };
    }
    const c = this.src[this.pos];
    if (c !== undefined && (/\d/.test(c) || SPECIAL.includes(c))) {
      this.pos++;
      return { type: "param", name: c, op: "", quoted };
    }
    return { type: "text", value: "$", quoted };
  }

  braced(quoted: boolean): Part {
    let op = "";
    if (this.starts("#") && !this.starts("#}")) {
      op = "length";
      this.pos++;
    } else if (this.starts("!") && !this.starts("!}")) {
      op = "indirect";
      this.pos++;
    }
    const name = this.src.slice(this.pos).match(/^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/)?.[0];
    if (!name) this.fail();
    this.pos += name.length;
    const part: Part & { type: "param" } = { type: "param", name, op, quoted };
    if (this.starts("[")) {
      this.pos++;
      part.index = new Parser(this.until("]")).text();
    }
    if (this.starts("}")) {
      this.pos++;
      return part;
    }
    if (op === "indirect" && (this.starts("*}") || this.starts("@}"))) {
      this.pos += 2;
      part.op = "names";
      return part;
    }
    if (op === "length") this.fail();
    if (op === "indirect") {
      part.indirect = true;
      part.op = "";
    }
    if (this.starts("@") && /^@[QEPAaULuK]}/.test(this.src.slice(this.pos, this.pos + 3))) {
      part.op = "@" + this.src[this.pos + 1];
      this.pos += 3;
      return part;
    }
    const operator = ["//", "/#", "/%", "/", ":-", ":=", ":+", ":?", "-", "=", "+", "?", "##", "#", "%%", "%", "^^", "^", ",,", ","].find(op => this.starts(op));
    if (operator) {
      this.pos += operator.length;
      part.op = operator;
      if (operator.startsWith("/")) {
        part.arg = this.argument("/}");
        if (this.starts("/")) {
          this.pos++;
          part.arg2 = this.argument("}");
        }
      } else part.arg = this.argument("}");
    } else if (this.starts(":")) {
      this.pos++;
      part.op = ":";
      part.arg = this.argument(":}");
      if (this.starts(":")) {
        this.pos++;
        part.arg2 = this.argument("}");
      }
    } else this.fail();
    if (!this.starts("}")) this.fail();
    this.pos++;
    return part;
  }

  closing(start: number): number {
    let depth = 0;
    for (let i = start; i < this.src.length; i++) {
      const c = this.src[i];
      if (c === "\\") i++;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i;
      else if (c === "\n") return -1;
    }
    return -1;
  }

  argument(stops: string): Word {
    const parts: Part[] = [];
    while (!this.done() && !stops.includes(this.src[this.pos])) {
      const c = this.src[this.pos];
      if (c === "\\") {
        push(parts, this.src[this.pos + 1] ?? "\\", true);
        this.pos += 2;
      } else if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end < 0) this.fail();
        push(parts, this.src.slice(this.pos + 1, end), true);
        this.pos = end + 1;
      } else if (c === '"') {
        this.pos++;
        this.double(parts, '"');
        this.pos++;
      } else if (c === "$" && this.src[this.pos + 1] === "'") {
        this.pos += 2;
        let value = "";
        while (!this.done() && this.src[this.pos] !== "'") {
          if (this.src[this.pos] === "\\") {
            const [text, length] = ansiEscape(this.src, this.pos + 1);
            value += text;
            this.pos += 1 + length;
          } else value += this.src[this.pos++];
        }
        this.pos++;
        push(parts, value, true);
      } else if (c === "$" || c === "`") parts.push(this.dollar(true));
      else {
        push(parts, c, false);
        this.pos++;
      }
    }
    return parts;
  }
}

export const DECLARATIONS = new Set(["local", "declare", "typeset", "export", "readonly"]);

function isDeclaration(word: Word | Assign): boolean {
  return Array.isArray(word) && word.length === 1 && word[0].type === "text" && !word[0].quoted && DECLARATIONS.has(word[0].value);
}

function push(parts: Part[], value: string, quoted: boolean) {
  const last = parts[parts.length - 1];
  if (last?.type === "text" && last.quoted === quoted) last.value += value;
  else parts.push({ type: "text", value, quoted });
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === ";" && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

export function ansiEscape(src: string, pos: number): [string, number] {
  const c = src[pos];
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?", "0": "\0" };
  if (c === "x") {
    const hex = src.slice(pos + 1).match(/^[0-9a-fA-F]{1,2}/)?.[0];
    if (hex) return [byte(parseInt(hex, 16)), 1 + hex.length];
  }
  if (c === "u" || c === "U") {
    const hex = src.slice(pos + 1).match(c === "u" ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/)?.[0];
    if (hex) return [String.fromCodePoint(parseInt(hex, 16)), 1 + hex.length];
  }
  if (c !== undefined && /[0-7]/.test(c)) {
    const oct = src.slice(pos).match(/^[0-7]{1,3}/)![0];
    return [byte(parseInt(oct, 8)), oct.length];
  }
  if (c !== undefined && c in simple) return [simple[c], 1];
  return ["\\" + (c ?? ""), c === undefined ? 0 : 1];
}

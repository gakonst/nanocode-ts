import { CommandError, type CommandContext, type CommandHandler } from "../shell.ts";
import { FsError, decode, encode } from "../fs.ts";
import { format, formatNumber, posixRegExp, type FormatValue } from "../text.ts";
import { strftime } from "./text.ts";

type Token = { type: string; value: string; line: number };

const KEYWORDS = new Set(["BEGIN", "END", "function", "func", "if", "else", "while", "for", "do", "break", "continue", "next", "nextfile", "exit", "return", "delete", "in", "getline", "print", "printf"]);
const BUILTINS = new Set(["length", "substr", "index", "split", "sub", "gsub", "match", "sprintf", "sin", "cos", "atan2", "exp", "log", "sqrt", "int", "rand", "srand", "tolower", "toupper", "system", "close", "fflush", "gensub", "systime", "strftime", "and", "or", "xor", "lshift", "rshift", "compl", "asort", "asorti"]);
const PUNCT = ["**=", "+=", "-=", "*=", "/=", "%=", "^=", "==", "<=", ">=", "!=", "++", "--", "&&", "||", ">>", "!~", "**", "{", "}", "(", ")", "[", "]", ";", ",", "+", "-", "*", "/", "%", "^", "!", ">", "<", "|", "?", ":", "~", "$", "="];

class AwkError extends Error {}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const operand = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return false;
    return ["number", "string", "regex", "name", "builtin"].includes(last.type) || [")", "]", "$", "++", "--"].includes(last.value) && last.type === "punct";
  };
  while (i < source.length) {
    const c = source[i];
    if (c === "\\" && source[i + 1] === "\n") {
      i += 2;
      line++;
      continue;
    }
    if (c === "\\" && source[i + 1] === "\r" && source[i + 2] === "\n") {
      i += 3;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      tokens.push({ type: "newline", value: "\n", line: line++ });
      i++;
      continue;
    }
    if (c === '"') {
      let value = "";
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < source.length) {
          const n = source[++i];
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "/": "/", a: "\x07", b: "\b", f: "\f", v: "\v" };
          if (n in map) value += map[n];
          else if (/[0-7]/.test(n)) {
            const oct = source.slice(i).match(/^[0-7]{1,3}/)![0];
            value += String.fromCharCode(parseInt(oct, 8));
            i += oct.length - 1;
          } else if (n === "\n") line++;
          else value += "\\" + n;
          i++;
          continue;
        }
        value += source[i++];
      }
      if (i >= source.length) throw new AwkError("unterminated string");
      i++;
      tokens.push({ type: "string", value, line });
      continue;
    }
    if (c === "/" && !operand()) {
      let value = "";
      i++;
      let bracket = false;
      while (i < source.length && (source[i] !== "/" || bracket)) {
        if (source[i] === "\n") throw new AwkError("unterminated regexp");
        if (source[i] === "\\" && i + 1 < source.length) {
          value += source[i + 1] === "/" ? "/" : source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (source[i] === "[") bracket = true;
        else if (source[i] === "]" && bracket && !/\[\^?$/.test(value)) bracket = false;
        value += source[i++];
      }
      i++;
      tokens.push({ type: "regex", value, line });
      continue;
    }
    const number = source.slice(i).match(/^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/);
    if (number) {
      tokens.push({ type: "number", value: number[0], line });
      i += number[0].length;
      continue;
    }
    const name = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (name) {
      const word = name[0];
      i += word.length;
      if (KEYWORDS.has(word)) tokens.push({ type: word === "func" ? "function" : word, value: word, line });
      else if (BUILTINS.has(word)) tokens.push({ type: "builtin", value: word, line });
      else if (source[i] === "(") tokens.push({ type: "funcname", value: word, line });
      else tokens.push({ type: "name", value: word, line });
      continue;
    }
    const punct = PUNCT.find(p => source.startsWith(p, i));
    if (!punct) throw new AwkError("syntax error at source line " + line + ": unexpected character '" + c + "'");
    tokens.push({ type: "punct", value: punct === "**=" ? "^=" : punct === "**" ? "^" : punct, line });
    i += punct.length;
  }
  tokens.push({ type: "eof", value: "", line });
  return tokens;
}

type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "re"; v: RegExp }
  | { k: "var"; name: string }
  | { k: "field"; index: Expr }
  | { k: "index"; name: string; subs: Expr[] }
  | { k: "assign"; op: string; target: Expr; value: Expr }
  | { k: "cond"; test: Expr; yes: Expr; no: Expr }
  | { k: "bin"; op: string; left: Expr; right: Expr }
  | { k: "and" | "or"; left: Expr; right: Expr }
  | { k: "not" | "neg" | "plus"; e: Expr }
  | { k: "match"; negate: boolean; left: Expr; right: Expr }
  | { k: "in"; subs: Expr[]; name: string }
  | { k: "incr"; prefix: boolean; op: string; target: Expr }
  | { k: "call"; name: string; args: Expr[] }
  | { k: "builtin"; name: string; args: Expr[] }
  | { k: "group"; list: Expr[] }
  | { k: "getline"; target?: Expr; file?: Expr; command?: Expr }
  | { k: "concat"; left: Expr; right: Expr };

type Stmt =
  | { k: "expr"; e: Expr }
  | { k: "print" | "printf"; args: Expr[]; redirect?: { op: string; target: Expr } }
  | { k: "if"; test: Expr; yes: Stmt; no?: Stmt }
  | { k: "while"; test: Expr; body: Stmt }
  | { k: "do"; test: Expr; body: Stmt }
  | { k: "for"; init?: Stmt; test?: Expr; step?: Stmt; body: Stmt }
  | { k: "forin"; name: string; array: string; body: Stmt }
  | { k: "block"; body: Stmt[] }
  | { k: "next" | "nextfile" | "break" | "continue" }
  | { k: "exit" | "return"; e?: Expr }
  | { k: "delete"; name: string; subs?: Expr[] };

type Rule = { pattern?: Expr; end?: Expr; action?: Stmt[]; active: boolean };

type Program = { begin: Stmt[][]; end: Stmt[][]; rules: Rule[]; functions: Map<string, { params: string[]; body: Stmt[] }> };

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  is(value: string, type = "punct"): boolean {
    const token = this.peek();
    return token.type === type && token.value === value;
  }

  take(value: string, type = "punct"): Token {
    if (!this.is(value, type)) this.fail();
    return this.tokens[this.pos++];
  }

  fail(): never {
    const token = this.peek();
    throw new AwkError("syntax error at source line " + token.line + " near '" + (token.type === "eof" ? "end of program" : token.value.replace("\n", "newline")) + "'");
  }

  newlines() {
    while (this.peek().type === "newline") this.pos++;
  }

  terminators() {
    while (this.peek().type === "newline" || this.is(";")) this.pos++;
  }

  program(): Program {
    const program: Program = { begin: [], end: [], rules: [], functions: new Map() };
    this.terminators();
    while (this.peek().type !== "eof") {
      const token = this.peek();
      if (token.type === "BEGIN") {
        this.pos++;
        this.newlines();
        program.begin.push(this.block());
      } else if (token.type === "END") {
        this.pos++;
        this.newlines();
        program.end.push(this.block());
      } else if (token.type === "function") {
        this.pos++;
        const name = this.peek();
        if (name.type !== "funcname" && name.type !== "name") this.fail();
        this.pos++;
        this.take("(");
        const params: string[] = [];
        while (!this.is(")")) {
          const param = this.peek();
          if (param.type !== "name") this.fail();
          params.push(param.value);
          this.pos++;
          if (this.is(",")) {
            this.pos++;
            this.newlines();
          }
        }
        this.take(")");
        this.newlines();
        program.functions.set(name.value, { params, body: this.block() });
      } else {
        const rule: Rule = { active: false };
        if (!this.is("{")) {
          rule.pattern = this.expr();
          if (this.is(",")) {
            this.pos++;
            this.newlines();
            rule.end = this.expr();
          }
        }
        if (this.is("{")) rule.action = this.block();
        program.rules.push(rule);
      }
      this.terminators();
    }
    return program;
  }

  block(): Stmt[] {
    this.take("{");
    const body: Stmt[] = [];
    this.terminators();
    while (!this.is("}")) {
      if (this.peek().type === "eof") this.fail();
      body.push(this.statement());
      this.terminators();
    }
    this.take("}");
    return body;
  }

  end() {
    if (this.is(";") || this.peek().type === "newline") {
      this.pos++;
      return;
    }
    if (this.is("}") || this.peek().type === "eof") return;
    this.fail();
  }

  body(): Stmt {
    this.newlines();
    if (this.is(";")) {
      this.pos++;
      return { k: "block", body: [] };
    }
    return this.statement();
  }

  statement(): Stmt {
    const token = this.peek();
    if (this.is("{")) return { k: "block", body: this.block() };
    switch (token.type) {
      case "if": {
        this.pos++;
        this.take("(");
        const test = this.expr();
        this.take(")");
        const yes = this.body();
        const save = this.pos;
        this.terminators();
        if (this.peek().type === "else") {
          this.pos++;
          return { k: "if", test, yes, no: this.body() };
        }
        this.pos = save;
        return { k: "if", test, yes };
      }
      case "while": {
        this.pos++;
        this.take("(");
        const test = this.expr();
        this.take(")");
        if (this.is(";")) {
          this.pos++;
          return { k: "while", test, body: { k: "block", body: [] } };
        }
        return { k: "while", test, body: this.body() };
      }
      case "do": {
        this.pos++;
        const body = this.body();
        this.terminators();
        this.take("while", "while");
        this.take("(");
        const test = this.expr();
        this.take(")");
        this.end();
        return { k: "do", test, body };
      }
      case "for": {
        this.pos++;
        this.take("(");
        if (this.peek().type === "name" && this.peek(1).type === "in" && this.peek(2).type === "name" && this.peek(3).value === ")") {
          const name = this.peek().value;
          const array = this.peek(2).value;
          this.pos += 4;
          return { k: "forin", name, array, body: this.body() };
        }
        const init = this.is(";") ? undefined : this.simple();
        this.take(";");
        this.newlines();
        const test = this.is(";") ? undefined : this.expr();
        this.take(";");
        this.newlines();
        const step = this.is(")") ? undefined : this.simple();
        this.take(")");
        return { k: "for", init, test, step, body: this.body() };
      }
      case "next":
      case "nextfile":
      case "break":
      case "continue":
        this.pos++;
        this.end();
        return { k: token.type };
      case "exit":
      case "return": {
        this.pos++;
        const e = this.is(";") || this.is("}") || this.peek().type === "newline" || this.peek().type === "eof" ? undefined : this.expr();
        this.end();
        return { k: token.type, e };
      }
      case "delete": {
        this.pos++;
        const name = this.peek();
        if (name.type !== "name") this.fail();
        this.pos++;
        let subs: Expr[] | undefined;
        if (this.is("[")) {
          this.pos++;
          subs = this.list("]");
          this.take("]");
        }
        this.end();
        return { k: "delete", name: name.value, subs };
      }
    }
    const statement = this.simple();
    this.end();
    return statement;
  }

  simple(): Stmt {
    const token = this.peek();
    if (token.type === "print" || token.type === "printf") {
      this.pos++;
      let args: Expr[] = [];
      if (this.is("(")) {
        const save = this.pos;
        this.pos++;
        const list = this.list(")");
        if (this.is(")")) {
          this.pos++;
          const next = this.peek();
          if (next.type === "newline" || next.type === "eof" || (next.type === "punct" && [";", "}", ">", ">>", "|"].includes(next.value))) args = list;
          else this.pos = save;
        } else this.pos = save;
        if (this.pos === save) args = this.list("", true);
      } else if (!(this.is(";") || this.is("}") || this.is(">") || this.is(">>") || this.is("|") || this.peek().type === "newline" || this.peek().type === "eof")) args = this.list("", true);
      let redirect: { op: string; target: Expr } | undefined;
      if (this.is(">") || this.is(">>") || this.is("|")) {
        const op = this.tokens[this.pos++].value;
        redirect = { op, target: this.concat(true) };
      }
      return { k: token.type, args, redirect };
    }
    return { k: "expr", e: this.expr() };
  }

  list(close: string, noGt = false): Expr[] {
    const list: Expr[] = [];
    this.newlines();
    if (close && this.is(close)) return list;
    for (;;) {
      list.push(this.expr(noGt));
      if (!this.is(",")) break;
      this.pos++;
      this.newlines();
    }
    this.newlines();
    return list;
  }

  expr(noGt = false): Expr {
    return this.ternary(noGt);
  }

  ternary(noGt: boolean): Expr {
    const left = this.or(noGt);
    if (this.peek().type === "punct" && ["=", "+=", "-=", "*=", "/=", "%=", "^="].includes(this.peek().value) && (left.k === "var" || left.k === "field" || left.k === "index")) {
      const op = this.tokens[this.pos++].value;
      this.newlines();
      return { k: "assign", op, target: left, value: this.ternary(noGt) };
    }
    if (this.is("?")) {
      this.pos++;
      this.newlines();
      const yes = this.ternary(noGt);
      this.newlines();
      this.take(":");
      this.newlines();
      return { k: "cond", test: left, yes, no: this.ternary(noGt) };
    }
    return left;
  }

  or(noGt: boolean): Expr {
    let left = this.and(noGt);
    while (this.is("||")) {
      this.pos++;
      this.newlines();
      left = { k: "or", left, right: this.and(noGt) };
    }
    return left;
  }

  and(noGt: boolean): Expr {
    let left = this.inExpr(noGt);
    while (this.is("&&")) {
      this.pos++;
      this.newlines();
      left = { k: "and", left, right: this.inExpr(noGt) };
    }
    return left;
  }

  inExpr(noGt: boolean): Expr {
    let left = this.match(noGt);
    while (this.peek().type === "in") {
      this.pos++;
      const name = this.peek();
      if (name.type !== "name") this.fail();
      this.pos++;
      left = { k: "in", subs: left.k === "group" ? left.list : [left], name: name.value };
    }
    return left;
  }

  match(noGt: boolean): Expr {
    let left = this.relation(noGt);
    while (this.is("~") || this.is("!~")) {
      const negate = this.tokens[this.pos++].value === "!~";
      left = { k: "match", negate, left, right: this.relation(noGt) };
    }
    return left;
  }

  relation(noGt: boolean): Expr {
    let left = this.concat(noGt);
    for (;;) {
      const token = this.peek();
      if (token.type === "punct" && token.value === "|" && this.peek(1).type === "getline") {
        this.pos += 2;
        const target = this.optionalLvalue();
        left = { k: "getline", command: left, target };
        continue;
      }
      if (token.type === "punct" && ["<", "<=", "==", "!=", ">=", ">"].includes(token.value) && !(noGt && token.value === ">")) {
        this.pos++;
        left = { k: "bin", op: token.value, left, right: this.concat(noGt) };
        continue;
      }
      return left;
    }
  }

  startsOperand(): boolean {
    const token = this.peek();
    if (["number", "string", "regex", "name", "funcname", "builtin"].includes(token.type)) return true;
    if (token.type === "punct" && ["$", "(", "!", "++", "--", "-", "+"].includes(token.value)) return token.value !== "-" && token.value !== "+" && token.value !== "!";
    return false;
  }

  concat(_noGt: boolean): Expr {
    let left = this.additive();
    while (this.startsOperand()) left = { k: "concat", left, right: this.additive() };
    return left;
  }

  additive(): Expr {
    let left = this.multiplicative();
    while (this.is("+") || this.is("-")) {
      const op = this.tokens[this.pos++].value;
      left = { k: "bin", op, left, right: this.multiplicative() };
    }
    return left;
  }

  multiplicative(): Expr {
    let left = this.unary();
    while (this.is("*") || this.is("/") || this.is("%")) {
      const op = this.tokens[this.pos++].value;
      left = { k: "bin", op, left, right: this.unary() };
    }
    return left;
  }

  unary(): Expr {
    if (this.is("!")) {
      this.pos++;
      return { k: "not", e: this.unary() };
    }
    if (this.is("-")) {
      this.pos++;
      return { k: "neg", e: this.unary() };
    }
    if (this.is("+")) {
      this.pos++;
      return { k: "plus", e: this.unary() };
    }
    return this.power();
  }

  power(): Expr {
    const base = this.postfix();
    if (this.is("^")) {
      this.pos++;
      const exponent = this.is("-") || this.is("+") || this.is("!") ? this.unary() : this.power();
      return { k: "bin", op: "^", left: base, right: exponent };
    }
    return base;
  }

  postfix(): Expr {
    const e = this.primary();
    if ((this.is("++") || this.is("--")) && (e.k === "var" || e.k === "field" || e.k === "index")) {
      const op = this.tokens[this.pos++].value;
      return { k: "incr", prefix: false, op, target: e };
    }
    return e;
  }

  optionalLvalue(): Expr | undefined {
    const token = this.peek();
    if (token.type === "name") return this.primary();
    if (token.type === "punct" && token.value === "$") return this.primary();
    return undefined;
  }

  primary(): Expr {
    const token = this.peek();
    switch (token.type) {
      case "number":
        this.pos++;
        return { k: "num", v: token.value.startsWith("0x") || token.value.startsWith("0X") ? parseInt(token.value, 16) : Number(token.value) };
      case "string":
        this.pos++;
        return { k: "str", v: token.value };
      case "regex":
        this.pos++;
        return { k: "re", v: regex(token.value) };
      case "name": {
        this.pos++;
        if (this.is("[")) {
          this.pos++;
          const subs = this.list("]");
          this.take("]");
          return { k: "index", name: token.value, subs };
        }
        return { k: "var", name: token.value };
      }
      case "funcname": {
        this.pos++;
        this.take("(");
        const args = this.list(")");
        this.take(")");
        return { k: "call", name: token.value, args };
      }
      case "builtin": {
        this.pos++;
        if (token.value === "length" && !this.is("(")) return { k: "builtin", name: "length", args: [] };
        this.take("(");
        const args = this.list(")");
        this.take(")");
        return { k: "builtin", name: token.value, args };
      }
      case "getline": {
        this.pos++;
        const target = this.optionalLvalue();
        if (this.is("<")) {
          this.pos++;
          return { k: "getline", target, file: this.primary() };
        }
        return { k: "getline", target };
      }
    }
    if (token.type === "punct") {
      if (token.value === "$") {
        this.pos++;
        if (this.is("++") || this.is("--")) {
          const op = this.tokens[this.pos++].value;
          return { k: "field", index: { k: "incr", prefix: true, op, target: this.primary() } };
        }
        if (this.is("-")) {
          this.pos++;
          return { k: "field", index: { k: "neg", e: this.primary() } };
        }
        return { k: "field", index: this.primary() };
      }
      if (token.value === "++" || token.value === "--") {
        this.pos++;
        const target = this.primary();
        if (target.k !== "var" && target.k !== "field" && target.k !== "index") this.fail();
        return { k: "incr", prefix: true, op: token.value, target };
      }
      if (token.value === "(") {
        this.pos++;
        const list = this.list(")");
        this.take(")");
        if (list.length === 1) return { k: "group", list };
        if (this.peek().type !== "in") this.fail();
        return { k: "group", list };
      }
      if (token.value === "-") {
        this.pos++;
        return { k: "neg", e: this.primary() };
      }
      if (token.value === "!") {
        this.pos++;
        return { k: "not", e: this.primary() };
      }
    }
    this.fail();
  }
}

function regex(source: string): RegExp {
  try {
    return posixRegExp(source, true);
  } catch {
    throw new AwkError("invalid regular expression /" + source + "/");
  }
}

class Strnum {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

type Value = number | string | Strnum | undefined;
type Cell = Value | Map<string, Value>;

const NUMERIC = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

function looksNumeric(text: string): boolean {
  return NUMERIC.test(text);
}

function toNum(value: Value): number {
  if (typeof value === "number") return value;
  if (value === undefined) return 0;
  const text = typeof value === "string" ? value : value.text;
  const match = text.match(/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
  if (match) return Number(match[0]);
  const hex = text.match(/^\s*[+-]?0[xX][0-9a-fA-F]+/);
  if (hex) return 0;
  const special = text.trim().match(/^([+-])(inf|nan)/i);
  if (special) return special[2].toLowerCase() === "inf" ? (special[1] === "-" ? -Infinity : Infinity) : NaN;
  return 0;
}

function isNumberish(value: Value): boolean {
  if (typeof value === "number" || value === undefined) return true;
  if (value instanceof Strnum) return looksNumeric(value.text);
  return false;
}

function truthy(value: Value): boolean {
  if (typeof value === "number") return value !== 0;
  if (value === undefined) return false;
  if (typeof value === "string") return value !== "";
  return looksNumeric(value.text) ? toNum(value) !== 0 : value.text !== "";
}

class NextSignal {}
class NextFileSignal {}
class ExitSignal {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}
class ReturnSignal {
  readonly value: Value;
  constructor(value: Value) {
    this.value = value;
  }
}
class LoopSignal {
  readonly kind: "break" | "continue";
  constructor(kind: "break" | "continue") {
    this.kind = kind;
  }
}

class Interpreter {
  ctx: CommandContext;
  program: Program;
  globals = new Map<string, Cell>();
  frames: Map<string, Cell>[] = [];
  fields: string[] = [""];
  nf = 0;
  outputs = new Map<string, { kind: "file" | "pipe"; text: string; append: boolean }>();
  readers = new Map<string, { lines: string[]; pos: number }>();
  records: string[] = [];
  preload?: () => Promise<void>;
  recordIndex = 0;
  steps = 0;
  depth = 0;
  seed = 0;
  exitCode = 0;

  constructor(ctx: CommandContext, program: Program) {
    this.ctx = ctx;
    this.program = program;
    const set = (name: string, value: Value) => this.globals.set(name, value);
    set("FS", " ");
    set("OFS", " ");
    set("ORS", "\n");
    set("RS", "\n");
    set("NR", 0);
    set("NF", 0);
    set("FNR", 0);
    set("SUBSEP", "\x1c");
    set("CONVFMT", "%.6g");
    set("OFMT", "%.6g");
    set("RSTART", 0);
    set("RLENGTH", -1);
    set("FILENAME", "");
    const environ = new Map<string, Value>();
    for (const [key, value] of Object.entries(ctx.env)) environ.set(key, new Strnum(value));
    this.globals.set("ENVIRON", environ);
  }

  tick() {
    if (++this.steps % 1024 === 0 && this.ctx.signal.aborted) throw new CommandError("execution aborted", 124);
    if (this.steps > this.ctx.limits.maxCommands * 100) throw new CommandError("too many steps", 124);
  }

  str(value: Value, output = false): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "";
    if (value instanceof Strnum) return value.text;
    if (Number.isInteger(value) && Math.abs(value) < 1e16) return String(value);
    const spec = this.scalar(output ? "OFMT" : "CONVFMT");
    if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf";
    const fmt = this.str(spec);
    return fmt === "%.6g" ? formatNumber(value) : format(fmt, [value], false).text;
  }

  lookup(name: string): Map<string, Cell> {
    const frame = this.frames[this.frames.length - 1];
    if (frame && frame.has(name)) return frame;
    return this.globals;
  }

  scalar(name: string): Value {
    if (name === "NF") return this.nf;
    const cell = this.lookup(name).get(name);
    if (cell instanceof Map) throw new AwkError("attempt to use array `" + name + "' in a scalar context");
    return cell;
  }

  setScalar(name: string, value: Value) {
    if (name === "NF") {
      this.setNF(Math.max(0, Math.trunc(toNum(value))));
      return;
    }
    const scope = this.lookup(name);
    if (scope.get(name) instanceof Map) throw new AwkError("attempt to use array `" + name + "' in a scalar context");
    scope.set(name, value);
  }

  array(name: string): Map<string, Value> {
    const scope = this.lookup(name);
    let cell = scope.get(name);
    if (cell === undefined) {
      cell = new Map();
      scope.set(name, cell);
    }
    if (!(cell instanceof Map)) throw new AwkError("can't use scalar `" + name + "' as array");
    return cell;
  }

  setRecord(text: string) {
    this.fields = [text];
    const fs = this.str(this.scalar("FS"));
    let parts: string[];
    if (text === "") parts = [];
    else if (fs === " ") parts = text.trim() === "" ? [] : text.trim().split(/[ \t\n]+/);
    else if (fs === "") parts = [...text];
    else if (fs.length === 1 && fs !== "\\") parts = text.split(fs === "\t" ? "\t" : fs);
    else parts = text.split(regex(fs));
    this.fields.push(...parts);
    this.nf = parts.length;
  }

  rebuild() {
    const ofs = this.str(this.scalar("OFS"));
    this.fields[0] = this.fields.slice(1, this.nf + 1).map(field => field ?? "").join(ofs);
  }

  setNF(n: number) {
    for (let i = this.nf + 1; i <= n; i++) this.fields[i] = "";
    this.fields.length = n + 1;
    this.nf = n;
    this.rebuild();
  }

  getField(index: number): Value {
    if (index < 0) throw new AwkError("attempt to access field " + index);
    if (index === 0) return new Strnum(this.fields[0] ?? "");
    if (index > this.nf) return new Strnum("");
    return new Strnum(this.fields[index] ?? "");
  }

  setField(index: number, value: Value) {
    if (index < 0) throw new AwkError("attempt to access field " + index);
    if (index === 0) {
      this.setRecord(this.str(value));
      return;
    }
    if (index > 100000) throw new AwkError("field index too large");
    for (let i = this.nf + 1; i < index; i++) this.fields[i] = "";
    this.fields[index] = this.str(value);
    if (index > this.nf) this.nf = index;
    this.rebuild();
  }

  async subscript(subs: Expr[]): Promise<string> {
    const parts: string[] = [];
    for (const sub of subs) parts.push(this.str(await this.eval(sub)));
    return parts.join(this.str(this.scalar("SUBSEP")));
  }

  async assignTo(target: Expr, value: Value) {
    if (target.k === "var") this.setScalar(target.name, value);
    else if (target.k === "field") this.setField(Math.trunc(toNum(await this.eval(target.index))), value);
    else if (target.k === "index") this.array(target.name).set(await this.subscript(target.subs), value);
    else if (target.k === "group" && target.list.length === 1) await this.assignTo(target.list[0], value);
    else throw new AwkError("assignment to non-lvalue");
  }

  async toRegex(e: Expr): Promise<RegExp> {
    if (e.k === "re") return e.v;
    return regex(this.str(await this.eval(e)));
  }

  compare(op: string, a: Value, b: Value): boolean {
    let result: number;
    if (isNumberish(a) && isNumberish(b)) {
      const x = toNum(a);
      const y = toNum(b);
      result = x < y ? -1 : x > y ? 1 : x === y ? 0 : NaN;
    } else {
      const x = this.str(a);
      const y = this.str(b);
      result = x < y ? -1 : x > y ? 1 : 0;
    }
    switch (op) {
      case "<": return result < 0;
      case "<=": return result <= 0;
      case ">": return result > 0;
      case ">=": return result >= 0;
      case "==": return result === 0;
      default: return result !== 0;
    }
  }

  async eval(e: Expr): Promise<Value> {
    switch (e.k) {
      case "num":
        return e.v;
      case "str":
        return e.v;
      case "re":
        e.v.lastIndex = 0;
        return e.v.test(this.fields[0] ?? "") ? 1 : 0;
      case "var":
        return this.scalar(e.name);
      case "field":
        return this.getField(Math.trunc(toNum(await this.eval(e.index))));
      case "index": {
        const array = this.array(e.name);
        const key = await this.subscript(e.subs);
        if (!array.has(key)) array.set(key, undefined);
        return array.get(key);
      }
      case "group":
        return this.eval(e.list[e.list.length - 1]);
      case "assign": {
        let value = await this.eval(e.value);
        if (e.op !== "=") {
          const current = toNum(await this.eval(e.target));
          value = this.arith(e.op.slice(0, -1), current, toNum(value));
        } else if (value instanceof Strnum) value = new Strnum(value.text);
        await this.assignTo(e.target, value);
        return value;
      }
      case "cond":
        return truthy(await this.eval(e.test)) ? this.eval(e.yes) : this.eval(e.no);
      case "and":
        return truthy(await this.eval(e.left)) && truthy(await this.eval(e.right)) ? 1 : 0;
      case "or":
        return truthy(await this.eval(e.left)) || truthy(await this.eval(e.right)) ? 1 : 0;
      case "not":
        return truthy(await this.eval(e.e)) ? 0 : 1;
      case "neg":
        return -toNum(await this.eval(e.e));
      case "plus":
        return toNum(await this.eval(e.e));
      case "bin": {
        const left = await this.eval(e.left);
        const right = await this.eval(e.right);
        if (["<", "<=", ">", ">=", "==", "!="].includes(e.op)) return this.compare(e.op, left, right) ? 1 : 0;
        return this.arith(e.op, toNum(left), toNum(right));
      }
      case "concat":
        return this.str(await this.eval(e.left)) + this.str(await this.eval(e.right));
      case "match": {
        const text = this.str(await this.eval(e.left));
        const re = await this.toRegex(e.right);
        re.lastIndex = 0;
        return re.test(text) !== e.negate ? 1 : 0;
      }
      case "in": {
        const key = await this.subscript(e.subs);
        return this.array(e.name).has(key) ? 1 : 0;
      }
      case "incr": {
        const current = toNum(await this.eval(e.target));
        const next = current + (e.op === "++" ? 1 : -1);
        await this.assignTo(e.target, next);
        return e.prefix ? next : current;
      }
      case "call":
        return this.call(e.name, e.args);
      case "builtin":
        return this.builtin(e.name, e.args);
      case "getline":
        return this.getline(e);
    }
  }

  arith(op: string, a: number, b: number): number {
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/":
        if (b === 0) throw new AwkError("division by zero");
        return a / b;
      case "%":
        if (b === 0) throw new AwkError("division by zero in %");
        return a % b;
      case "^": return a ** b;
    }
    throw new AwkError("unknown operator " + op);
  }

  async call(name: string, args: Expr[]): Promise<Value> {
    const fn = this.program.functions.get(name);
    if (!fn) throw new AwkError("calling undefined function " + name);
    if (++this.depth > this.ctx.limits.maxCallDepth) throw new AwkError("function call nesting too deep");
    const frame = new Map<string, Cell>();
    const bindings: [string, Map<string, Value>][] = [];
    for (let i = 0; i < fn.params.length; i++) {
      const arg = args[i];
      if (!arg) {
        frame.set(fn.params[i], undefined);
        continue;
      }
      if (arg.k === "var") {
        const cell = this.lookup(arg.name).get(arg.name);
        if (cell instanceof Map) {
          frame.set(fn.params[i], cell);
          continue;
        }
        if (cell === undefined && !this.lookup(arg.name).has(arg.name)) {
          const fresh = new Map<string, Value>();
          bindings.push([arg.name, fresh]);
          frame.set(fn.params[i], fresh);
          continue;
        }
      }
      frame.set(fn.params[i], await this.eval(arg));
    }
    this.frames.push(frame);
    try {
      await this.statements(fn.body);
      return undefined;
    } catch (error) {
      if (error instanceof ReturnSignal) return error.value;
      throw error;
    } finally {
      this.frames.pop();
      this.depth--;
      for (const [name, map] of bindings) if (map.size) this.lookup(name).set(name, map);
    }
  }

  replace(text: string, re: RegExp, replacement: string, global: boolean): { text: string; count: number } {
    let count = 0;
    const source = new RegExp(re.source, re.flags.replace("g", "") + "g");
    const result = text.replace(source, match => {
      if (!global && count > 0) return match;
      count++;
      let out = "";
      for (let i = 0; i < replacement.length; i++) {
        const c = replacement[i];
        if (c === "\\" && replacement[i + 1] === "&") {
          out += "&";
          i++;
        } else if (c === "\\" && replacement[i + 1] === "\\") {
          out += "\\";
          i++;
        } else if (c === "&") out += match;
        else out += c;
      }
      return out;
    });
    return { text: result, count };
  }

  async builtin(name: string, args: Expr[]): Promise<Value> {
    const value = async (index: number) => this.eval(args[index]);
    const text = async (index: number) => this.str(await value(index));
    const num = async (index: number) => toNum(await value(index));
    switch (name) {
      case "length": {
        if (!args.length) return [...(this.fields[0] ?? "")].length;
        const arg = args[0];
        if (arg.k === "var") {
          const cell = this.lookup(arg.name).get(arg.name);
          if (cell instanceof Map) return cell.size;
        }
        return [...(await text(0))].length;
      }
      case "substr": {
        const chars = [...(await text(0))];
        let start = Math.round(await num(1));
        let length = args.length > 2 ? Math.round(await num(2)) : Infinity;
        if (start < 1) start = 1;
        if (length <= 0 || Number.isNaN(length)) return "";
        return chars.slice(start - 1, length === Infinity ? undefined : start - 1 + length).join("");
      }
      case "index": {
        const haystack = await text(0);
        const needle = await text(1);
        return haystack.indexOf(needle) + 1;
      }
      case "split": {
        const source = await text(0);
        const target = args[1];
        if (target?.k !== "var") throw new AwkError("split: second argument is not an array");
        const array = this.array(target.name);
        array.clear();
        let parts: string[];
        if (source === "") parts = [];
        else if (args.length > 2) {
          const separator = args[2];
          if (separator.k === "re") parts = source.split(separator.v);
          else {
            const fs = await text(2);
            parts = fs === " " ? source.trim().split(/[ \t\n]+/).filter(Boolean) : fs === "" ? [...source] : fs.length === 1 ? source.split(fs) : source.split(regex(fs));
          }
        } else {
          const fs = this.str(this.scalar("FS"));
          parts = fs === " " ? source.trim().split(/[ \t\n]+/).filter(Boolean) : fs.length === 1 ? source.split(fs) : source.split(regex(fs));
        }
        parts.forEach((part, index) => array.set(String(index + 1), new Strnum(part)));
        return parts.length;
      }
      case "sub":
      case "gsub": {
        const re = await this.toRegex(args[0]);
        const replacement = await text(1);
        const target: Expr = args[2] ?? { k: "field", index: { k: "num", v: 0 } };
        const current = this.str(await this.eval(target));
        const result = this.replace(current, re, replacement, name === "gsub");
        if (result.count) await this.assignTo(target, result.text);
        return result.count;
      }
      case "gensub": {
        const re = await this.toRegex(args[0]);
        const replacement = await text(1);
        const how = await text(2);
        const target = args.length > 3 ? await text(3) : this.fields[0] ?? "";
        const global = /^[gG]/.test(how);
        const which = global ? 0 : Math.max(1, Math.trunc(toNum(how)));
        let count = 0;
        return target.replace(new RegExp(re.source, re.flags.replace("g", "") + "g"), (...matchArgs: unknown[]) => {
          let end = matchArgs.length - 2;
          if (typeof matchArgs[matchArgs.length - 1] === "object") end--;
          const groups = matchArgs.slice(0, end) as string[];
          count++;
          if (!global && count !== which) return groups[0];
          return replacement.replace(/\\(\d)|&|\\&/g, (token, digit: string | undefined) => (token === "\\&" ? "&" : token === "&" ? groups[0] : groups[Number(digit)] ?? ""));
        });
      }
      case "match": {
        const source = await text(0);
        const re = await this.toRegex(args[1]);
        const found = new RegExp(re.source, re.flags.replace("g", "")).exec(source);
        const start = found ? [...source.slice(0, found.index)].length + 1 : 0;
        const length = found ? [...found[0]].length : -1;
        this.globals.set("RSTART", start);
        this.globals.set("RLENGTH", length);
        if (args[2]?.k === "var" && found) {
          const array = this.array(args[2].name);
          array.clear();
          found.forEach((group, index) => array.set(String(index), group ?? ""));
        }
        return start;
      }
      case "sprintf": {
        if (!args.length) return "";
        const values: FormatValue[] = [];
        for (let i = 1; i < args.length; i++) values.push(this.formatArg(await value(i)));
        return format(await text(0), values, false).text;
      }
      case "sin": return Math.sin(await num(0));
      case "cos": return Math.cos(await num(0));
      case "atan2": return Math.atan2(await num(0), await num(1));
      case "exp": return Math.exp(await num(0));
      case "log": return Math.log(await num(0));
      case "sqrt": return Math.sqrt(await num(0));
      case "int": return Math.trunc(await num(0));
      case "rand": return Math.random();
      case "srand": {
        const previous = this.seed;
        this.seed = args.length ? await num(0) : Math.floor(Date.now() / 1000);
        return previous;
      }
      case "tolower": return (await text(0)).toLowerCase();
      case "toupper": return (await text(0)).toUpperCase();
      case "systime": return Math.floor(Date.now() / 1000);
      case "strftime": {
        const spec = args.length ? await text(0) : "%a %b %e %H:%M:%S %Z %Y";
        const when = args.length > 1 ? (await num(1)) * 1000 : Date.now();
        return strftime(spec, new Date(when));
      }
      case "and": return Number(BigInt(Math.trunc(await num(0))) & BigInt(Math.trunc(await num(1))));
      case "or": return Number(BigInt(Math.trunc(await num(0))) | BigInt(Math.trunc(await num(1))));
      case "xor": return Number(BigInt(Math.trunc(await num(0))) ^ BigInt(Math.trunc(await num(1))));
      case "lshift": return (await num(0)) * 2 ** (await num(1));
      case "rshift": return Math.floor((await num(0)) / 2 ** (await num(1)));
      case "compl": return Number(~BigInt(Math.trunc(await num(0))) & 0x1fffffffffffffn);
      case "system": {
        await this.flushAll();
        const result = await this.ctx.exec(await text(0));
        this.ctx.stdout.write(result.stdout);
        return result.status;
      }
      case "close": {
        const key = await text(0);
        this.readers.delete(key);
        const output = this.outputs.get(key);
        if (!output) return -1;
        await this.flush(key, output);
        this.outputs.delete(key);
        return 0;
      }
      case "fflush":
        return 0;
      case "asort":
      case "asorti": {
        const source = args[0];
        if (source?.k !== "var") throw new AwkError(name + ": argument is not an array");
        const array = this.array(source.name);
        const items = name === "asort" ? [...array.values()] : [...array.keys()];
        items.sort((a, b) => (isNumberish(a) && isNumberish(b) && typeof a !== "string" && typeof b !== "string" ? toNum(a) - toNum(b) : this.str(a) < this.str(b) ? -1 : this.str(a) > this.str(b) ? 1 : 0));
        const target = args[1]?.k === "var" ? this.array((args[1] as { name: string }).name) : array;
        target.clear();
        items.forEach((item, index) => target.set(String(index + 1), item));
        return items.length;
      }
    }
    throw new AwkError("function " + name + " never defined");
  }

  formatArg(value: Value): FormatValue {
    if (typeof value === "number") return value;
    if (value === undefined) return "";
    if (value instanceof Strnum) return looksNumeric(value.text) ? Number(value.text) : value.text;
    return value;
  }

  async getline(e: Expr & { k: "getline" }): Promise<Value> {
    let line: string | undefined;
    if (e.command) {
      const command = this.str(await this.eval(e.command));
      let reader = this.readers.get(command);
      if (!reader) {
        await this.flushAll();
        const result = await this.ctx.exec(command);
        reader = { lines: splitRecords(result.stdout, "\n"), pos: 0 };
        this.readers.set(command, reader);
      }
      line = reader.lines[reader.pos++];
    } else if (e.file) {
      const file = this.str(await this.eval(e.file));
      let reader = this.readers.get(file);
      if (!reader) {
        let content: string;
        try {
          content = file === "-" || file === "/dev/stdin" ? this.ctx.stdin.read() : decode(await this.ctx.fs.read(this.ctx.resolve(file)));
        } catch {
          return -1;
        }
        reader = { lines: splitRecords(content, this.str(this.scalar("RS"))), pos: 0 };
        this.readers.set(file, reader);
      }
      line = reader.lines[reader.pos++];
    } else {
      if (this.preload && this.recordIndex >= this.records.length) {
        const preload = this.preload;
        this.preload = undefined;
        await preload();
      }
      line = this.records[this.recordIndex];
      if (line !== undefined) {
        this.recordIndex++;
        this.globals.set("NR", toNum(this.scalar("NR")) + 1);
        this.globals.set("FNR", toNum(this.scalar("FNR")) + 1);
      }
    }
    if (line === undefined) return 0;
    if (e.target) await this.assignTo(e.target, new Strnum(line));
    else {
      this.setRecord(line);
      if (e.command || e.file) this.globals.set("NR", toNum(this.scalar("NR")) + 1);
    }
    return 1;
  }

  async write(text: string, redirect?: { op: string; target: Expr }) {
    if (!redirect) {
      this.ctx.stdout.write(text);
      return;
    }
    const key = this.str(await this.eval(redirect.target));
    if (key === "/dev/stdout" || key === "-") {
      this.ctx.stdout.write(text);
      return;
    }
    if (key === "/dev/stderr") {
      this.ctx.stderr.write(text);
      return;
    }
    let output = this.outputs.get(key);
    if (!output) {
      output = { kind: redirect.op === "|" ? "pipe" : "file", text: "", append: redirect.op === ">>" };
      this.outputs.set(key, output);
    }
    output.text += text;
    if (output.text.length > this.ctx.limits.maxBufferLength) throw new CommandError("output exceeded " + this.ctx.limits.maxBufferLength + " characters");
  }

  async flush(key: string, output: { kind: "file" | "pipe"; text: string; append: boolean }) {
    if (output.kind === "pipe") {
      const result = await this.ctx.exec(key, output.text);
      this.ctx.stdout.write(result.stdout);
    } else {
      await this.ctx.fs.write(this.ctx.resolve(key), encode(output.text), output.append);
      output.append = true;
    }
    output.text = "";
  }

  async flushAll() {
    for (const [key, output] of this.outputs) if (output.text || output.kind === "file") await this.flush(key, output);
  }

  async statements(list: Stmt[]) {
    for (const statement of list) await this.statement(statement);
  }

  async statement(s: Stmt): Promise<void> {
    this.tick();
    switch (s.k) {
      case "expr":
        await this.eval(s.e);
        return;
      case "print": {
        let text: string;
        if (!s.args.length) text = this.fields[0] ?? "";
        else {
          const parts: string[] = [];
          for (const arg of s.args) parts.push(this.str(await this.eval(arg), true));
          text = parts.join(this.str(this.scalar("OFS")));
        }
        await this.write(text + this.str(this.scalar("ORS")), s.redirect);
        return;
      }
      case "printf": {
        if (!s.args.length) throw new AwkError("printf: no format");
        const values: FormatValue[] = [];
        for (const arg of s.args.slice(1)) values.push(this.formatArg(await this.eval(arg)));
        await this.write(format(this.str(await this.eval(s.args[0])), values, false).text, s.redirect);
        return;
      }
      case "if":
        if (truthy(await this.eval(s.test))) await this.statement(s.yes);
        else if (s.no) await this.statement(s.no);
        return;
      case "while":
        for (let n = 0; truthy(await this.eval(s.test)); n++) {
          this.loop(n);
          if (await this.loopBody(s.body)) break;
        }
        return;
      case "do": {
        let n = 0;
        do {
          this.loop(n++);
          if (await this.loopBody(s.body)) break;
        } while (truthy(await this.eval(s.test)));
        return;
      }
      case "for":
        if (s.init) await this.statement(s.init);
        for (let n = 0; !s.test || truthy(await this.eval(s.test)); n++) {
          this.loop(n);
          if (await this.loopBody(s.body)) break;
          if (s.step) await this.statement(s.step);
        }
        return;
      case "forin": {
        const keys = [...this.array(s.array).keys()];
        for (let n = 0; n < keys.length; n++) {
          this.loop(n);
          this.setScalar(s.name, new Strnum(keys[n]));
          if (await this.loopBody(s.body)) break;
        }
        return;
      }
      case "block":
        await this.statements(s.body);
        return;
      case "next":
        throw new NextSignal();
      case "nextfile":
        throw new NextFileSignal();
      case "break":
      case "continue":
        throw new LoopSignal(s.k);
      case "exit":
        throw new ExitSignal(s.e ? Math.trunc(toNum(await this.eval(s.e))) : 0);
      case "return":
        throw new ReturnSignal(s.e ? await this.eval(s.e) : undefined);
      case "delete": {
        const array = this.array(s.name);
        if (s.subs) array.delete(await this.subscript(s.subs));
        else array.clear();
        return;
      }
    }
  }

  loop(n: number) {
    if (n > this.ctx.limits.maxLoopIterations * 100) throw new CommandError("too many loop iterations", 124);
  }

  async loopBody(body: Stmt): Promise<boolean> {
    try {
      await this.statement(body);
      return false;
    } catch (error) {
      if (error instanceof LoopSignal) return error.kind === "break";
      throw error;
    }
  }
}

function splitRecords(text: string, rs: string): string[] {
  if (rs === "\n") {
    const parts = text.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  }
  if (rs === "") return text.replace(/^\n+/, "").split(/\n\n+/).map(part => part.replace(/\n+$/, "")).filter(part => part !== "");
  const parts = text.split(rs.length === 1 ? rs : regex(rs));
  if (parts[parts.length - 1] === "" || parts[parts.length - 1] === "\n") parts.pop();
  return parts;
}

export const awk: CommandHandler = async ctx => {
  const args = ctx.args;
  let fs: string | undefined;
  const assigns: [string, string][] = [];
  let source: string | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg.startsWith("-F")) fs = arg.length > 2 ? arg.slice(2) : args[++i];
    else if (arg.startsWith("-v")) {
      const assignment = arg.length > 2 ? arg.slice(2) : args[++i];
      const eq = assignment.indexOf("=");
      if (eq < 0) throw new CommandError("-v: invalid assignment " + assignment, 2);
      assigns.push([assignment.slice(0, eq), assignment.slice(eq + 1)]);
    } else if (arg === "-f") source = (source ?? "") + decode(await ctx.fs.read(ctx.resolve(args[++i]))) + "\n";
    else if (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1 && !/^-[Fvf]/.test(arg))) {
      if (arg === "-e" || arg === "--source") source = (source ?? "") + args[++i] + "\n";
      else continue;
    } else break;
  }
  if (source === undefined) {
    if (i >= args.length) throw new CommandError("usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]", 2);
    source = args[i++];
  }
  const operands = args.slice(i);
  let program: Program;
  try {
    program = new Parser(lex(source)).program();
  } catch (error) {
    if (error instanceof AwkError) throw new CommandError(error.message, 2);
    throw error;
  }
  const interp = new Interpreter(ctx, program);
  const unescape = (value: string) => value.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", "\\": "\\", r: "\r" })[c] ?? "\\" + c);
  if (fs !== undefined) interp.globals.set("FS", fs === "t" ? "\t" : unescape(fs));
  for (const [name, value] of assigns) interp.globals.set(name, new Strnum(unescape(value)));
  const argv = new Map<string, Value>([["0", "awk"]]);
  operands.forEach((operand, index) => argv.set(String(index + 1), new Strnum(operand)));
  interp.globals.set("ARGV", argv);
  interp.globals.set("ARGC", operands.length + 1);
  let exitCode = 0;
  let exiting = false;
  let preloaded: string | undefined;
  interp.preload = async () => {
    const operand = operands.find(operand => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(operand)) ?? "-";
    let text = "";
    try {
      text = operand === "-" ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(operand)));
    } catch (error) {
      if (!(error instanceof FsError)) throw error;
    }
    preloaded = operand;
    interp.globals.set("FILENAME", operand === "-" ? "" : operand);
    interp.records = splitRecords(text, interp.str(interp.scalar("RS")));
    interp.recordIndex = 0;
  };
  try {
    try {
      for (const block of program.begin) await interp.statements(block);
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error;
      exitCode = error.code;
      exiting = true;
    }
    if (!exiting && (program.rules.length || program.end.length)) {
      const inputs = operands.length ? operands : ["-"];
      let consumed = false;
      for (const operand of inputs) {
        const assignment = operand.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
        if (assignment) {
          interp.globals.set(assignment[1], new Strnum(unescape(assignment[2])));
          continue;
        }
        consumed = true;
        if (preloaded === operand) {
          preloaded = undefined;
          if (await runFile(interp, program, undefined, operand)) {
            exiting = true;
            exitCode = interp.exitCode;
            break;
          }
          continue;
        }
        let text: string;
        try {
          text = operand === "-" ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(operand)));
        } catch (error) {
          if (!(error instanceof FsError)) throw error;
          ctx.stderr.write("awk: cannot open \"" + operand + "\" (No such file or directory)\n");
          exitCode = 2;
          continue;
        }
        if (await runFile(interp, program, text, operand)) {
          exiting = true;
          exitCode = interp.exitCode;
          break;
        }
      }
      if (!consumed && !exiting && await runFile(interp, program, preloaded === "-" ? undefined : ctx.stdin.read(), "")) {
        exiting = true;
        exitCode = interp.exitCode;
      }
    }
    try {
      for (const block of program.end) await interp.statements(block);
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error;
      exitCode = error.code;
    }
  } catch (error) {
    if (error instanceof AwkError) {
      await interp.flushAll();
      throw new CommandError(error.message, 2);
    }
    if (error instanceof NextSignal || error instanceof NextFileSignal) throw new CommandError("next used in BEGIN or END action", 2);
    throw error;
  }
  await interp.flushAll();
  return exitCode;
};

async function runFile(interp: Interpreter, program: Program, text: string | undefined, name: string): Promise<boolean> {
  interp.preload = undefined;
  interp.globals.set("FILENAME", name === "-" ? "" : name);
  if (text !== undefined) {
    interp.globals.set("FNR", 0);
    interp.records = splitRecords(text, interp.str(interp.scalar("RS")));
    interp.recordIndex = 0;
  }
  while (interp.recordIndex < interp.records.length) {
    const record = interp.records[interp.recordIndex++];
    interp.globals.set("NR", toNum(interp.scalar("NR")) + 1);
    interp.globals.set("FNR", toNum(interp.scalar("FNR")) + 1);
    interp.setRecord(record);
    try {
      for (const rule of program.rules) {
        let matched: boolean;
        if (!rule.pattern) matched = true;
        else if (rule.end) {
          if (rule.active) {
            matched = true;
            if (truthy(await interp.eval(rule.end))) rule.active = false;
          } else if (truthy(await interp.eval(rule.pattern))) {
            matched = true;
            rule.active = !truthy(await interp.eval(rule.end));
          } else matched = false;
        } else matched = truthy(await interp.eval(rule.pattern));
        if (!matched) continue;
        if (rule.action) await interp.statements(rule.action);
        else interp.ctx.stdout.write((interp.fields[0] ?? "") + interp.str(interp.scalar("ORS")));
      }
    } catch (error) {
      if (error instanceof NextSignal) continue;
      if (error instanceof NextFileSignal) break;
      if (error instanceof ExitSignal) {
        interp.exitCode = error.code;
        return true;
      }
      throw error;
    }
  }
  return false;
}

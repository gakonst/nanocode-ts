import { byte } from "./fs.ts";

const CLASSES: Record<string, string> = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
  word: "\\w",
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
};

function bracket(pattern: string, start: number, shell: boolean): [string, number] | undefined {
  let i = start + 1;
  let out = "[";
  if (pattern[i] === "!" || pattern[i] === "^") {
    out += "^";
    i++;
  }
  let first = true;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "]" && !first) return [out + "]", i + 1];
    first = false;
    if (c === "[" && pattern[i + 1] === ":") {
      const end = pattern.indexOf(":]", i + 2);
      if (end > 0) {
        out += CLASSES[pattern.slice(i + 2, end)] ?? "";
        i = end + 2;
        continue;
      }
    }
    if (c === "\\" && shell && i + 1 < pattern.length) {
      out += "\\" + pattern[i + 1];
      i += 2;
      continue;
    }
    out += c === "\\" || c === "]" || c === "[" || c === "^" ? "\\" + c : c;
    i++;
  }
  return undefined;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}

export function globSource(pattern: string, path = false): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) out += escapeRegExp(pattern[++i]);
    else if (c === "*") out += path ? "[^/]*" : "[\\s\\S]*";
    else if (c === "?") out += path ? "[^/]" : "[\\s\\S]";
    else if (c === "[") {
      const result = bracket(pattern, i, true);
      if (result) {
        out += result[0];
        i = result[1] - 1;
      } else out += "\\[";
    } else out += escapeRegExp(c);
  }
  return out;
}

export function globRegExp(pattern: string, flags = ""): RegExp {
  return new RegExp("^" + globSource(pattern) + "$", flags);
}

export function hasGlob(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") i++;
    else if (pattern[i] === "*" || pattern[i] === "?") return true;
    else if (pattern[i] === "[" && bracket(pattern, i, true)) return true;
  }
  return false;
}

export function unescapeGlob(pattern: string): string {
  return pattern.replace(/\\([\s\S])/g, "$1");
}

export function posixRegExp(pattern: string, extended: boolean, flags = ""): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      const n = pattern[++i];
      if (n === "<" || n === ">") out += "\\b";
      else if (!extended && "(){}+?|".includes(n)) out += n;
      else if (/[wWsSbBdD1-9]/.test(n)) out += "\\" + n;
      else if (n === "n") out += "\\n";
      else if (n === "t") out += "\\t";
      else if (n === "r") out += "\\r";
      else if (n === "f") out += "\\f";
      else if (n === "v") out += "\\v";
      else out += escapeRegExp(n);
    } else if (c === "[") {
      const result = bracket(pattern, i, false);
      if (result) {
        out += result[0];
        i = result[1] - 1;
      } else out += "\\[";
    } else if (!extended && "(){}+?|".includes(c)) out += "\\" + c;
    else if (c === "*" && (out === "" || out.endsWith("(") || out.endsWith("|") || out === "^")) out += "\\*";
    else if (extended && c === "{" && !/^\{\d+(,\d*)?\}/.test(pattern.slice(i))) out += "\\{";
    else if (extended && c === "}" && !/\{\d+(,\d*)?$/.test(out)) out += "\\}";
    else if (c === "/") out += "\\/";
    else out += c;
  }
  return new RegExp(out, flags);
}

export function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function joinLines(parts: string[]): string {
  return parts.length ? parts.join("\n") + "\n" : "";
}

const ESCAPE = /^\\(0[0-7]{0,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[\s\S])/;
const OCTAL = /^\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[\s\S])/;
const SIMPLE: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v", "\\": "\\" };

function escape(text: string, octal = false): [string, number, boolean] {
  const match = text.match(octal ? OCTAL : ESCAPE);
  if (!match) return ["\\", 1, false];
  const body = match[1];
  if (body === "c") return ["", 2, true];
  if (octal ? /^[0-7]/.test(body) : body[0] === "0") return [byte(parseInt((octal ? body : body.slice(1)) || "0", 8)), match[0].length, false];
  if (body.length > 1 && body[0] === "x") return [byte(parseInt(body.slice(1), 16)), match[0].length, false];
  if (body.length > 1 && (body[0] === "u" || body[0] === "U")) return [String.fromCodePoint(parseInt(body.slice(1), 16)), match[0].length, false];
  return [body in SIMPLE ? SIMPLE[body] : "\\" + body, match[0].length, false];
}

export function escapes(text: string): [string, boolean] {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\" || i + 1 >= text.length) {
      out += text[i];
      continue;
    }
    const [value, length, stop] = escape(text.slice(i));
    if (stop) return [out, true];
    out += value;
    i += length - 1;
  }
  return [out, false];
}

export type FormatValue = string | number;

function pad(text: string, width: number, left: boolean, zero: boolean): string {
  if (text.length >= width) return text;
  if (left) return text + " ".repeat(width - text.length);
  if (zero) {
    const prefix = text.match(/^[+\- ]?(0[xX])?/)![0];
    return prefix + "0".repeat(width - text.length) + text.slice(prefix.length);
  }
  return " ".repeat(width - text.length) + text;
}

export function toNumber(value: FormatValue): number {
  if (typeof value === "number") return value;
  const text = value.trim();
  if (/^['"]/.test(text)) return text.length > 1 ? text.codePointAt(1)! : 0;
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(text)) return parseInt(text, 16);
  if (text === "") return 0;
  const number = Number(text);
  if (!Number.isNaN(number)) return number;
  return parseFloat(text) || 0;
}

function general(n: number, precision: number, alternate: boolean): string {
  const p = precision || 1;
  const abs = Math.abs(n);
  const exponent = abs === 0 ? 0 : Math.floor(Math.log10(abs));
  let body: string;
  if (exponent < -4 || exponent >= p) {
    body = abs.toExponential(p - 1);
    if (!alternate) body = body.replace(/\.?0+e/, "e");
    body = body.replace(/e([+-])(\d)$/, "e$10$2");
  } else {
    body = abs.toFixed(Math.max(0, p - 1 - exponent));
    if (!alternate && body.includes(".")) body = body.replace(/\.?0+$/, "");
  }
  return body;
}

export function formatNumber(n: number, precision = 6): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "nan" : n < 0 ? "-inf" : "inf";
  return (n < 0 ? "-" : "") + general(n, precision, false);
}

function shellQuote(text: string): string {
  if (text === "") return "''";
  if (/[\x00-\x1f\x7f]/.test(text)) return "$'" + text.replace(/[\\']/g, "\\$&").replace(/[\x00-\x1f\x7f]/g, c => ({ "\n": "\\n", "\t": "\\t", "\r": "\\r", "\x1b": "\\E", "\x07": "\\a", "\b": "\\b", "\f": "\\f", "\v": "\\v" })[c] ?? "\\" + c.charCodeAt(0).toString(8).padStart(3, "0")) + "'";
  return text.replace(/[^\w@%+=:,.\/~-]|^~/g, "\\$&");
}

export function format(spec: string, args: FormatValue[], shell: boolean, time?: (spec: string, seconds: number) => string): { text: string; used: number; stop: boolean; errors?: string[] } {
  let out = "";
  let used = 0;
  const errors: string[] = [];
  const next = () => (used < args.length ? args[used++] : undefined);
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === "\\" && shell) {
      const [value, length, stop] = escape(spec.slice(i), true);
      if (stop) return { text: out, used, stop: true };
      out += value;
      i += length - 1;
      continue;
    }
    if (c !== "%") {
      out += c;
      continue;
    }
    const clock = time ? spec.slice(i).match(/^%(-?)(\d*)\(([^)]*)\)T/) : null;
    if (clock && time) {
      i += clock[0].length - 1;
      const arg = next();
      const value = arg === undefined || arg === "" ? -1 : toNumber(arg);
      const text = time(clock[3]!, value < 0 ? Math.floor(Date.now() / 1000) : value);
      out += pad(text, Number(clock[2] || 0), clock[1] === "-", false);
      continue;
    }
    const match = spec.slice(i).match(/^%([-+ 0#']*)(\*|\d+)?(?:\.(\*|\d*))?(l{0,2}|h{0,2}|j|z|L)?([diouxXfFeEgGsScbq%])/);
    if (!match) {
      out += c;
      continue;
    }
    i += match[0].length - 1;
    const flags = match[1];
    const conv = match[5];
    if (conv === "%") {
      out += "%";
      continue;
    }
    let width = match[2] === "*" ? toNumber(next() ?? 0) : Number(match[2] ?? 0);
    let left = flags.includes("-");
    if (width < 0) {
      left = true;
      width = -width;
    }
    const precision = match[3] === undefined ? undefined : match[3] === "*" ? toNumber(next() ?? 0) : Number(match[3] || 0);
    const arg = next();
    const sign = (n: number, body: string) => (n < 0 || Object.is(n, -0) ? "-" : flags.includes("+") ? "+" : flags.includes(" ") ? " " : "") + body;
    if (conv === "s" || conv === "S" || conv === "q") {
      let text = arg === undefined ? "" : typeof arg === "number" ? formatNumber(arg) : arg;
      if (conv === "q") text = shell ? shellQuote(text) : /^[\w@%+=:,.\/-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'";
      if (precision !== undefined) text = text.slice(0, precision);
      out += pad(text, width, left, false);
    } else if (conv === "b") {
      const [expanded, stop] = escapes(arg === undefined ? "" : String(arg));
      out += pad(expanded, width, left, false);
      if (stop) return { text: out, used, stop: true };
    } else if (conv === "c") {
      out += pad(arg === undefined ? "" : typeof arg === "number" ? String.fromCharCode(arg) : arg.slice(0, 1), width, left, false);
    } else {
      const n = arg === undefined ? 0 : toNumber(arg);
      if (shell && typeof arg === "string" && !/^\s*['"]/.test(arg) && !(/[diouxXc]/.test(conv) ? /^\s*[+-]?(0[xX][0-9a-fA-F]+|\d+)\s*$/ : /^\s*[+-]?(0[xX][0-9a-fA-F]+(\.[0-9a-fA-F]*)?(p[+-]?\d+)?|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|inf(inity)?|nan)\s*$/i).test(arg)) errors.push(arg + ": invalid number");
      let text: string;
      if (conv === "d" || conv === "i" || conv === "u") {
        const int = Math.trunc(Number.isFinite(n) ? n : 0);
        let digits = Math.abs(int).toString();
        if (precision !== undefined) digits = digits.padStart(precision, "0");
        text = sign(int, digits);
      } else if (conv === "o" || conv === "x" || conv === "X") {
        const int = Math.trunc(n);
        let digits = (int < 0 ? int >>> 0 : int).toString(conv === "o" ? 8 : 16);
        if (conv === "X") digits = digits.toUpperCase();
        if (precision !== undefined) digits = digits.padStart(precision, "0");
        if (flags.includes("#") && int !== 0) digits = (conv === "o" ? "0" : conv === "x" ? "0x" : "0X") + digits;
        text = digits;
      } else if (!Number.isFinite(n)) text = sign(n, Number.isNaN(n) ? "nan" : "inf");
      else if (conv === "f" || conv === "F") text = sign(n, Math.abs(n).toFixed(precision ?? 6));
      else if (conv === "e" || conv === "E") {
        const body = Math.abs(n).toExponential(precision ?? 6).replace(/e([+-])(\d)$/, "e$10$2");
        text = sign(n, conv === "E" ? body.toUpperCase() : body);
      } else {
        const body = general(n, precision ?? 6, flags.includes("#"));
        text = sign(n, conv === "G" ? body.toUpperCase() : body);
      }
      out += pad(text, width, left, flags.includes("0") && !left && (precision === undefined || !/[diouxX]/.test(conv)));
    }
  }
  return errors.length ? { text: out, used, stop: false, errors } : { text: out, used, stop: false };
}

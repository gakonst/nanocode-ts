import { CommandError, type CommandHandler } from "../shell.ts";
import { decode, encode } from "../fs.ts";

type Yaml = null | boolean | number | string | Yaml[] | { [key: string]: Yaml };

type Line = { indent: number; text: string; number: number; raw: string };

class YamlError extends Error {}

const KEY = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{\[\]},&*!|>%@`-][^#]*?|-[^\s#][^#]*?)\s*:(?:\s|$)/;

function stripComment(text: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s:\[{,-]/.test(text[i - 1]!))) quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i).replace(/\s+$/, "");
  }
  return text.replace(/\s+$/, "");
}

function scalar(text: string): Yaml {
  const value = text.trim();
  if (value === "" || value === "~" || value === "null" || value === "Null" || value === "NULL") return null;
  if (/^(true|True|TRUE)$/.test(value)) return true;
  if (/^(false|False|FALSE)$/.test(value)) return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(value)) return Number(value);
  if (/^0x[0-9a-fA-F]+$/.test(value)) return parseInt(value.slice(2), 16);
  if (/^0o[0-7]+$/.test(value)) return parseInt(value.slice(2), 8);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(value)) return Number(value);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(value)) return value.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(value)) return NaN;
  if (value.startsWith('"')) return styled(quoted(value), '"');
  if (value.startsWith("'")) return styled(value.slice(1, -1).replace(/''/g, "'"), "'");
  return value;
}

const styles = new Map<string, string>();

function styled(value: string, style: string): string {
  if (styles.size < 10000) styles.set(value, style);
  return value;
}

function quoted(text: string): string {
  let out = "";
  for (let i = 1; i < text.length - 1; i++) {
    const c = text[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = text[++i]!;
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", e: "\x1b", " ": " ", N: "\u0085", _: "\u00a0", a: "\x07", v: "\v" };
    if (next in simple) out += simple[next];
    else if (next === "x" || next === "u" || next === "U") {
      const size = next === "x" ? 2 : next === "u" ? 4 : 8;
      out += String.fromCodePoint(parseInt(text.slice(i + 1, i + 1 + size), 16));
      i += size;
    } else out += next;
  }
  return out;
}

class Flow {
  text: string;
  pos = 0;
  constructor(text: string) {
    this.text = text;
  }
  space() {
    while (this.pos < this.text.length && /[\s]/.test(this.text[this.pos]!)) this.pos++;
  }
  value(): Yaml {
    this.space();
    const c = this.text[this.pos];
    if (c === "[") {
      this.pos++;
      const items: Yaml[] = [];
      for (;;) {
        this.space();
        if (this.text[this.pos] === "]") {
          this.pos++;
          return items;
        }
        items.push(this.value());
        this.space();
        if (this.text[this.pos] === ",") this.pos++;
        else if (this.text[this.pos] !== "]") throw new YamlError("did not find expected ',' or ']'");
      }
    }
    if (c === "{") {
      this.pos++;
      const object: Record<string, Yaml> = {};
      for (;;) {
        this.space();
        if (this.text[this.pos] === "}") {
          this.pos++;
          return object;
        }
        const key = this.atom(true);
        this.space();
        let value: Yaml = null;
        if (this.text[this.pos] === ":") {
          this.pos++;
          value = this.value();
        }
        object[String(key)] = value;
        this.space();
        if (this.text[this.pos] === ",") this.pos++;
        else if (this.text[this.pos] !== "}") throw new YamlError("did not find expected ',' or '}'");
      }
    }
    return this.atom(false);
  }
  atom(key: boolean): Yaml {
    this.space();
    const c = this.text[this.pos];
    if (c === '"' || c === "'") {
      let end = this.pos + 1;
      while (end < this.text.length) {
        if (c === '"' && this.text[end] === "\\") end += 2;
        else if (this.text[end] === c && c === "'" && this.text[end + 1] === "'") end += 2;
        else if (this.text[end] === c) break;
        else end++;
      }
      const raw = this.text.slice(this.pos, end + 1);
      this.pos = end + 1;
      return scalar(raw);
    }
    let end = this.pos;
    while (end < this.text.length && !",]}".includes(this.text[end]!) && !(this.text[end] === ":" && (key || /\s/.test(this.text[end + 1] ?? " ")))) end++;
    const raw = this.text.slice(this.pos, end);
    this.pos = end;
    return key ? raw.trim() : scalar(raw);
  }
}

class Parser {
  lines: Line[];
  pos = 0;
  anchors = new Map<string, Yaml>();
  constructor(lines: Line[]) {
    this.lines = lines;
  }
  peek(): Line | undefined {
    while (this.pos < this.lines.length && this.lines[this.pos]!.text === "") this.pos++;
    return this.lines[this.pos];
  }
  document(): Yaml {
    const line = this.peek();
    if (!line) return null;
    return this.node(line.indent);
  }
  node(indent: number): Yaml {
    const line = this.peek();
    if (!line || line.indent < indent) return null;
    if (/^-(\s|$)/.test(line.text)) return this.sequence(line.indent);
    if (KEY.test(line.text) && !/^[\[{]/.test(line.text)) return this.mapping(line.indent);
    this.pos++;
    return this.inline(line.text, line.indent);
  }
  inline(text: string, indent: number): Yaml {
    let value = text;
    let anchor: string | undefined;
    const anchored = value.match(/^&(\S+)\s*/);
    if (anchored) {
      anchor = anchored[1];
      value = value.slice(anchored[0].length);
    }
    value = value.replace(/^!!?\S+\s*/, "");
    let result: Yaml;
    if (value.startsWith("*")) result = this.anchors.get(value.slice(1).trim()) ?? null;
    else if (/^[|>]/.test(value)) result = this.block(value, indent);
    else if (value === "") result = this.node(indent + 1);
    else if (/^[\[{]/.test(value)) {
      let source = value;
      while (!this.balanced(source) && this.peek()) source += " " + this.lines[this.pos++]!.text;
      result = new Flow(source).value();
    } else if (/^["']/.test(value) && !this.closed(value)) {
      let source = value;
      while (!this.closed(source) && this.peek()) source += " " + this.lines[this.pos++]!.text;
      result = scalar(source);
    } else {
      let source = value;
      while (this.peek() && this.peek()!.indent > indent && !/^-(\s|$)/.test(this.peek()!.text) && !KEY.test(this.peek()!.text)) source += " " + this.lines[this.pos++]!.text;
      result = scalar(source);
    }
    if (anchor) this.anchors.set(anchor, result);
    return result;
  }
  balanced(text: string): boolean {
    let depth = 0;
    let quote = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\" && quote === '"') i++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
    }
    return depth <= 0;
  }
  closed(text: string): boolean {
    const q = text[0];
    for (let i = 1; i < text.length; i++) {
      if (q === '"' && text[i] === "\\") i++;
      else if (text[i] === q) {
        if (q === "'" && text[i + 1] === "'") i++;
        else return true;
      }
    }
    return false;
  }
  block(header: string, indent: number): string {
    const folded = header[0] === ">";
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const explicit = header.match(/\d/);
    const rows: string[] = [];
    let blockIndent = explicit ? indent + Number(explicit[0]) : -1;
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos]!;
      if (line.raw !== "" && line.indent <= indent) break;
      if (line.raw === "") {
        rows.push("");
        this.pos++;
        continue;
      }
      if (blockIndent < 0) blockIndent = line.indent;
      if (line.indent < blockIndent) break;
      rows.push(" ".repeat(line.indent - blockIndent) + line.raw);
      this.pos++;
    }
    let trailing = 0;
    while (rows.length && rows[rows.length - 1] === "") {
      rows.pop();
      trailing++;
    }
    let body: string;
    if (folded) {
      body = "";
      rows.forEach((row, index) => {
        if (index === 0) body = row;
        else if (row === "" || rows[index - 1] === "" || /^\s/.test(row)) body += "\n" + row;
        else body += " " + row;
      });
      body = body.replace(/\n(?=\n)/g, "\n");
    } else body = rows.join("\n");
    if (!rows.length) return chomp === "keep" ? "\n".repeat(trailing) : "";
    if (chomp === "strip") return body;
    if (chomp === "keep") return body + "\n" + "\n".repeat(trailing);
    return body + "\n";
  }
  sequence(indent: number): Yaml[] {
    const items: Yaml[] = [];
    while (this.peek() && this.peek()!.indent === indent && /^-(\s|$)/.test(this.peek()!.text)) {
      const line = this.lines[this.pos]!;
      const rest = line.text.slice(1).replace(/^\s+/, "");
      const offset = line.text.length - rest.length;
      if (rest === "") {
        this.pos++;
        items.push(this.peek() && this.peek()!.indent > indent ? this.node(indent + 1) : null);
        continue;
      }
      if (/^-(\s|$)/.test(rest) || (KEY.test(rest) && !/^[\[{"']/.test(rest)) || (KEY.test(rest) && /^["']/.test(rest))) {
        this.lines[this.pos] = { indent: indent + offset, text: rest, number: line.number, raw: rest };
        items.push(this.node(indent + offset));
        continue;
      }
      this.pos++;
      items.push(this.inline(rest, indent));
    }
    return items;
  }
  mapping(indent: number): Record<string, Yaml> {
    const object: Record<string, Yaml> = {};
    while (this.peek() && this.peek()!.indent === indent && KEY.test(this.peek()!.text)) {
      const line = this.lines[this.pos++]!;
      const match = line.text.match(KEY)!;
      const rawKey = match[0].replace(/\s*:\s*$/, "").replace(/\s*:$/, "");
      const key = String(scalar(rawKey) ?? (rawKey === "" ? "" : rawKey));
      const rest = line.text.slice(match[0].length).trim();
      if (key === "<<") {
        const merged = rest === "" ? this.node(indent + 1) : this.inline(rest, indent);
        for (const source of Array.isArray(merged) ? merged : [merged]) if (source && typeof source === "object" && !Array.isArray(source)) for (const [k, v] of Object.entries(source)) if (!(k in object)) object[k] = v;
        continue;
      }
      if (rest === "" || /^&\S+$/.test(rest)) {
        const next = this.peek();
        let value: Yaml = null;
        if (next && next.indent > indent) value = this.node(next.indent);
        else if (next && next.indent === indent && /^-(\s|$)/.test(next.text)) value = this.sequence(indent);
        if (rest) this.anchors.set(rest.slice(1), value);
        object[key] = value;
        continue;
      }
      object[key] = this.inline(rest, indent);
    }
    return object;
  }
}

export function parseYaml(text: string): Yaml[] {
  const documents: Yaml[] = [];
  let current: Line[] = [];
  let started = false;
  const flush = () => {
    if (current.some(line => line.text !== "") || started) {
      const parser = new Parser(current.filter((line, index, all) => line.text !== "" || all.slice(index).some(other => other.text !== "")));
      documents.push(parser.document());
    }
    current = [];
  };
  text.replace(/\r\n/g, "\n").split("\n").forEach((raw, index) => {
    if (/^---(\s|$)/.test(raw)) {
      if (current.some(line => line.text !== "")) flush();
      started = true;
      const rest = raw.slice(3).trim();
      if (rest) current.push({ indent: 0, text: stripComment(rest), number: index + 1, raw: rest });
      return;
    }
    if (/^\.\.\.\s*$/.test(raw)) {
      flush();
      started = false;
      return;
    }
    if (/^%/.test(raw) && !current.length) return;
    const indent = raw.length - raw.replace(/^ +/, "").length;
    const body = raw.slice(indent);
    const textValue = body.startsWith("#") ? "" : stripComment(body);
    current.push({ indent, text: textValue, number: index + 1, raw: body.replace(/\s+$/, "") === "" ? "" : body });
  });
  flush();
  return documents;
}

const PLAIN = /^[^\s\-?:,\[\]{}#&*!|>'"%@`]([^:#]|:(?!\s)|#(?<!\s#))*$/;

function format(value: string): string {
  if (value === "") return '""';
  const style = styles.get(value);
  if (style === "'" && !value.includes("\n")) return "'" + value.replace(/'/g, "''") + "'";
  if (style === '"') return JSON.stringify(value);
  if (/\n/.test(value)) return JSON.stringify(value);
  if (!PLAIN.test(value) || /\s$/.test(value) || /:$/.test(value) || typeof scalar(value) !== "string") return /["\\]/.test(value) || /[\x00-\x1f]/.test(value) ? JSON.stringify(value) : '"' + value + '"';
  return value;
}

function scalarText(value: Yaml): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isNaN(value) ? ".nan" : value === Infinity ? ".inf" : value === -Infinity ? "-.inf" : String(value);
  return format(value as string);
}

export function stringifyYaml(value: Yaml, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return pad + "[]\n";
    return value.map(item => {
      if (item !== null && typeof item === "object" && (Array.isArray(item) ? item.length : Object.keys(item).length)) {
        const inner = stringifyYaml(item, indent + 2);
        return pad + "- " + inner.slice(indent + 2);
      }
      return pad + "- " + (item !== null && typeof item === "object" ? (Array.isArray(item) ? "[]" : "{}") : block(item, indent + 2)) + "\n";
    }).join("");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return pad + "{}\n";
    return entries.map(([key, item]) => {
      const name = pad + format(key) + ":";
      if (item !== null && typeof item === "object" && (Array.isArray(item) ? item.length : Object.keys(item).length)) return name + "\n" + stringifyYaml(item, indent + 2);
      return name + " " + (item !== null && typeof item === "object" ? (Array.isArray(item) ? "[]" : "{}") : block(item, indent + 2)) + "\n";
    }).join("");
  }
  return pad + block(value, indent) + "\n";
}

function block(value: Yaml, indent: number): string {
  if (typeof value === "string" && value.includes("\n") && !/[\x00-\x09\x0b-\x1f]/.test(value) && !/^\s/.test(value)) {
    const keep = value.endsWith("\n") ? (value.endsWith("\n\n") ? "+" : "") : "-";
    const body = value.replace(/\n$/, "");
    return "|" + keep + "\n" + body.split("\n").map(row => (row ? " ".repeat(indent) + row : "")).join("\n");
  }
  return scalarText(value);
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export const yq: CommandHandler = async ctx => {
  styles.clear();
  const args = [...ctx.args];
  let output = "yaml";
  let input = "auto";
  let inPlace = false;
  let nullInput = false;
  let exitStatus = false;
  let indent = 2;
  let raw = true;
  const operands: string[] = [];
  const jqArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (short: string, long: string): string | undefined => {
      if (arg === short || arg === long) return args[++i];
      if (arg.startsWith(long + "=")) return arg.slice(long.length + 1);
      if (arg.startsWith(short + "=")) return arg.slice(short.length + 1);
      if (arg.startsWith(short) && arg.length > short.length && !arg.startsWith("--")) return arg.slice(short.length);
      return undefined;
    };
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-i" || arg === "--inplace") inPlace = true;
    else if (arg === "-n" || arg === "--null-input") nullInput = true;
    else if (arg === "-e" || arg === "--exit-status") exitStatus = true;
    else if (arg === "-P" || arg === "--prettyPrint" || arg === "-C" || arg === "-M" || arg === "--no-colors" || arg === "--colors") continue;
    else if (arg === "-r" || arg === "--unwrapScalar" || arg === "--unwrapScalar=true") raw = true;
    else if (arg === "--unwrapScalar=false") raw = false;
    else if (arg === "-j" || arg === "--tojson") output = "json";
    else if (arg === "-V" || arg === "--version") {
      ctx.stdout.write("yq (https://github.com/mikefarah/yq/) version v4.44.3\n");
      return 0;
    } else if (arg.startsWith("-o") || arg.startsWith("--output-format")) output = value("-o", "--output-format") ?? "yaml";
    else if (arg.startsWith("-p") || arg.startsWith("--input-format")) input = value("-p", "--input-format") ?? "yaml";
    else if (arg.startsWith("-I") || arg.startsWith("--indent")) indent = Number(value("-I", "--indent") ?? 2);
    else if (arg === "--arg" || arg === "--argjson") jqArgs.push(arg, args[++i] ?? "", args[++i] ?? "");
    else if (arg.startsWith("-") && arg !== "-") throw new CommandError("unknown flag: " + arg, 1);
    else operands.push(arg);
  }
  if (operands[0] === "eval" || operands[0] === "e" || operands[0] === "eval-all" || operands[0] === "ea") operands.shift();
  output = { j: "json", y: "yaml", json: "json", yaml: "yaml", yml: "yaml" }[output] ?? output;
  if (output !== "json" && output !== "yaml") throw new CommandError("unknown output format " + output, 1);
  let expression = ".";
  const files: string[] = [];
  if (operands.length) {
    const first = operands[0]!;
    if (operands.length === 1 && !nullInput && (await ctx.fs.stat(ctx.resolve(first)))?.kind === "file" && !/^[.\[|]/.test(first)) files.push(first);
    else {
      expression = first;
      files.push(...operands.slice(1));
    }
  }
  const documents: { file: string; values: Yaml[] }[] = [];
  if (nullInput) documents.push({ file: "", values: [null] });
  else {
    for (const file of files.length ? files : ["-"]) {
      let text: string;
      try {
        text = file === "-" ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(file)));
      } catch {
        ctx.stderr.write("Error: open " + file + ": no such file or directory\n");
        return 1;
      }
      const json = input === "json" || (input === "auto" && /\.json$/.test(file));
      try {
        documents.push({ file, values: json ? text.trim().split(/\n(?=[{[])/).filter(Boolean).map(chunk => JSON.parse(chunk) as Yaml) : parseYaml(text) });
      } catch (error) {
        ctx.stderr.write("Error: bad file '" + file + "': " + (error instanceof Error ? error.message : String(error)) + "\n");
        return 1;
      }
    }
  }
  expression = expression.replace(/\b(str)?env\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, (_, string: string | undefined, name: string) => (string ? "($ENV." + name + " // \"\")" : "($ENV." + name + ")"));
  const serialize = (value: Yaml) => JSON.stringify(value, (_, item) => (typeof item === "number" && !Number.isFinite(item) ? null : item));
  let status = 0;
  let last: Yaml | undefined;
  const results: Yaml[] = [];
  const separators: number[] = [];
  for (const document of documents) {
    const values: Yaml[] = [];
    for (const [index, item] of document.values.entries()) {
      const result = await ctx.exec("jq -c " + (nullInput ? "-n " : "") + jqArgs.map(quote).join(" ") + " " + quote(expression), serialize(item) + "\n");
      if (result.status !== 0 && result.status !== 1) return result.status === 5 || result.status === 3 ? 1 : result.status;
      if (index > 0) separators.push(results.length + values.length);
      values.push(...result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as Yaml));
    }
    if (inPlace) {
      if (!document.file || document.file === "-") throw new CommandError("Write in place flag only applicable when giving an expression and at least one file", 1);
      const text = values.map(value => (output === "json" ? JSON.stringify(value, null, indent) + "\n" : stringifyYaml(value))).join("---\n");
      await ctx.fs.write(ctx.resolve(document.file), encode(text));
      continue;
    }
    results.push(...values);
    last = values[values.length - 1];
  }
  if (inPlace) return 0;
  let text = "";
  for (const [index, value] of results.entries()) {
    if (output === "yaml" && separators.includes(index)) text += "---\n";
    if (output === "json") text += (indent ? JSON.stringify(value, null, indent) : JSON.stringify(value)) + "\n";
    else if (raw && typeof value === "string") text += value + "\n";
    else text += indent === 2 ? stringifyYaml(value) : stringifyYaml(value).replace(/^( +)/gm, spaces => " ".repeat((spaces.length / 2) * indent));
  }
  ctx.stdout.write(text);
  if (exitStatus && (last === undefined || last === null || last === false)) status = 1;
  return status;
};

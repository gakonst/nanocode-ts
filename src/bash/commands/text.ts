import { CommandError, type CommandContext, type CommandHandler } from "../shell.ts";
import { FsError, decode, encode } from "../fs.ts";
import { escapes, format, globRegExp, joinLines, lines, posixRegExp } from "../text.ts";
import { allInput, eachInput, last, options } from "./util.ts";

const echo: CommandHandler = ctx => {
  let newline = true;
  let interpret = false;
  let i = 0;
  for (; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (!/^-[neE]+$/.test(arg)) break;
    for (const flag of arg.slice(1)) {
      if (flag === "n") newline = false;
      else if (flag === "e") interpret = true;
      else interpret = false;
    }
  }
  let text = ctx.args.slice(i).join(" ");
  if (interpret) {
    const [expanded, stop] = escapes(text);
    text = expanded;
    if (stop) newline = false;
  }
  ctx.stdout.write(newline ? text + "\n" : text);
  return 0;
};

const printf: CommandHandler = ctx => {
  const args = ctx.args[0] === "--" ? ctx.args.slice(1) : ctx.args;
  if (!args.length) throw new CommandError("usage: printf format [arguments]", 2);
  const [spec, ...rest] = args;
  let remaining = rest;
  for (;;) {
    const result = format(spec, remaining, true);
    ctx.stdout.write(result.text);
    if (result.stop) return 0;
    remaining = remaining.slice(result.used);
    if (!result.used || !remaining.length) return 0;
  }
};

function count(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const match = value.match(/^([+-]?\d+)([kKmMgGbB]?)$/);
  if (!match) throw new CommandError("invalid number: '" + value + "'");
  const scale = { "": 1, k: 1024, K: 1024, m: 1024 ** 2, M: 1024 ** 2, g: 1024 ** 3, G: 1024 ** 3, b: 512, B: 512 }[match[2]]!;
  return Number(match[1]) * scale;
}

async function headTail(ctx: CommandContext, tail: boolean): Promise<number> {
  const parsed = options(ctx.args, { flags: "qvfFz", values: "nc", numeric: true, long: { lines: "n", bytes: "c", quiet: "q", silent: "q", verbose: "v", follow: "f" } });
  const lineSpec = last(parsed, "n");
  const byteSpec = last(parsed, "c");
  const headers = (parsed.operands.length > 1 || parsed.flags.has("v")) && !parsed.flags.has("q");
  let first = true;
  return eachInput(ctx, parsed.operands, (text, name) => {
    if (headers) {
      ctx.stdout.write((first ? "" : "\n") + "==> " + (name === "-" ? "standard input" : name) + " <==\n");
      first = false;
    }
    if (byteSpec !== undefined) {
      const n = count(byteSpec, 0);
      if (tail) ctx.stdout.write(byteSpec.startsWith("+") ? text.slice(Math.max(0, n - 1)) : n === 0 ? "" : text.slice(-n));
      else ctx.stdout.write(n < 0 ? text.slice(0, n) : text.slice(0, n));
      return;
    }
    const n = count(lineSpec, 10);
    const all = text.split("\n");
    const trailing = all[all.length - 1] === "";
    if (trailing) all.pop();
    let start: number;
    let end: number;
    if (tail) {
      start = lineSpec?.startsWith("+") ? Math.max(0, n - 1) : Math.max(0, all.length - Math.abs(n));
      end = all.length;
    } else {
      start = 0;
      end = n < 0 ? Math.max(0, all.length + n) : Math.min(all.length, n);
    }
    if (end <= start) return;
    ctx.stdout.write(all.slice(start, end).join("\n") + (end < all.length || trailing ? "\n" : ""));
  });
}

const wc: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "lwcmL", long: { lines: "l", words: "w", bytes: "c", chars: "m", "max-line-length": "L" } });
  const f = parsed.flags;
  const fields = f.size ? ["l", "w", "m", "c", "L"].filter(flag => f.has(flag)) : ["l", "w", "c"];
  const rows: { counts: number[]; name: string; bytes: number }[] = [];
  const totals = fields.map(() => 0);
  const status = await eachInput(ctx, parsed.operands, (text, name) => {
    const counts = fields.map(field => {
      if (field === "l") return (text.match(/\n/g) ?? []).length;
      if (field === "w") return (text.match(/\S+/g) ?? []).length;
      if (field === "m") return [...text].length;
      if (field === "c") return encode(text).length;
      return Math.max(0, ...text.split("\n").map(line => line.length));
    });
    counts.forEach((value, index) => (totals[index] = fields[index] === "L" ? Math.max(totals[index], value) : totals[index] + value));
    rows.push({ counts, name: parsed.operands.length ? name : "", bytes: encode(text).length });
  });
  if (parsed.operands.length > 1) rows.push({ counts: totals, name: "total", bytes: 0 });
  const stdin = !parsed.operands.length || parsed.operands.includes("-");
  const bytes = rows.slice(0, parsed.operands.length || 1).reduce((sum, row) => sum + row.bytes, 0);
  const width = fields.length === 1 && rows.length === 1 ? 0 : Math.max(stdin ? 7 : 1, String(bytes).length);
  for (const row of rows) ctx.stdout.write(row.counts.map(value => String(value).padStart(width)).join(" ") + (row.name ? " " + row.name : "") + "\n");
  return status;
};

const grep: CommandHandler = async ctx => {
  const parsed = options(ctx.args, {
    flags: "ivncLlrRhHqsoxwEFGPZaIUz",
    values: "eABCmf",
    long: { "ignore-case": "i", "invert-match": "v", "line-number": "n", count: "c", "files-with-matches": "l", "files-without-match": "L", recursive: "r", "dereference-recursive": "R", "no-filename": "h", "with-filename": "H", quiet: "q", silent: "q", "no-messages": "s", "only-matching": "o", "line-regexp": "x", "word-regexp": "w", "extended-regexp": "E", "fixed-strings": "F", "basic-regexp": "G", "perl-regexp": "P", regexp: "e", "after-context": "A", "before-context": "B", context: "C", "max-count": "m", file: "f", include: "include", exclude: "exclude", "exclude-dir": "exclude-dir", color: "", colour: "", "null-data": "z", binary: "", text: "a" },
  });
  const f = parsed.flags;
  const operands = [...parsed.operands];
  const patterns: string[] = [...(parsed.values.get("e") ?? [])];
  for (const file of parsed.values.get("f") ?? []) patterns.push(...lines(decode(await ctx.fs.read(ctx.resolve(file)))));
  if (!parsed.values.has("e") && !parsed.values.has("f")) {
    if (!operands.length) throw new CommandError("usage: grep [OPTION]... PATTERNS [FILE]...", 2);
    patterns.push(...operands.shift()!.split("\n"));
  }
  const flags = (f.has("i") ? "i" : "") + "g";
  const sources = patterns.map(pattern => {
    let source: string;
    if (f.has("F")) source = pattern.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
    else if (f.has("P")) source = pattern;
    else source = posixRegExp(pattern, f.has("E"), "").source;
    if (f.has("w")) source = "(?<![\\w])(?:" + source + ")(?![\\w])";
    if (f.has("x")) source = "^(?:" + source + ")$";
    return source;
  });
  let regex: RegExp;
  try {
    regex = new RegExp(sources.map(source => "(?:" + source + ")").join("|"), flags);
  } catch (error) {
    throw new CommandError("invalid regular expression: " + (error as Error).message, 2);
  }
  const recursive = f.has("r") || f.has("R");
  if (!operands.length && recursive) operands.push(".");
  const include = (parsed.values.get("include") ?? []).map(glob => globRegExp(glob));
  const exclude = (parsed.values.get("exclude") ?? []).map(glob => globRegExp(glob));
  const excludeDir = (parsed.values.get("exclude-dir") ?? []).map(glob => globRegExp(glob));
  const targets: string[] = [];
  let status = 1;
  let errors = false;
  const collect = async (operand: string, top: boolean) => {
    const path = ctx.resolve(operand);
    const stat = await ctx.fs.stat(path);
    if (!stat) {
      if (!f.has("s")) ctx.stderr.write("grep: " + operand + ": No such file or directory\n");
      errors = true;
      return;
    }
    const name = operand.slice(operand.lastIndexOf("/") + 1);
    if (stat.kind === "directory") {
      if (!recursive) {
        if (!f.has("s")) ctx.stderr.write("grep: " + operand + ": Is a directory\n");
        errors = true;
        return;
      }
      if (!top && excludeDir.some(glob => glob.test(name))) return;
      for (const child of await ctx.fs.list(path)) await collect(operand.replace(/\/$/, "") + "/" + child, false);
      return;
    }
    if (!top || recursive) {
      if (include.length && !include.some(glob => glob.test(name))) return;
      if (exclude.some(glob => glob.test(name))) return;
    }
    targets.push(operand);
  };
  if (operands.length) for (const operand of operands) await collect(operand, true);
  const named = f.has("H") || (!f.has("h") && (targets.length > 1 || recursive || operands.length > 1));
  const after = Number(last(parsed, "A") ?? last(parsed, "C") ?? 0);
  const before = Number(last(parsed, "B") ?? last(parsed, "C") ?? 0);
  const max = last(parsed, "m") === undefined ? Infinity : Number(last(parsed, "m"));
  const search = (text: string, name: string): boolean => {
    const all = text.split(f.has("z") ? "\0" : "\n");
    if (all[all.length - 1] === "") all.pop();
    const prefix = (n: number, separator: string) => (named ? name + separator : "") + (f.has("n") ? n + 1 + separator : "");
    let matches = 0;
    let lastPrinted = -1;
    let pendingAfter = 0;
    let found = false;
    for (let i = 0; i < all.length && matches < max; i++) {
      const line = all[i];
      regex.lastIndex = 0;
      const hit = regex.test(line) !== f.has("v");
      if (!hit) {
        if (pendingAfter > 0 && !f.has("c") && !f.has("l") && !f.has("L") && !f.has("q")) {
          ctx.stdout.write(prefix(i, "-") + line + "\n");
          lastPrinted = i;
          pendingAfter--;
        }
        continue;
      }
      found = true;
      matches++;
      if (f.has("q") || f.has("l") || f.has("L")) break;
      if (f.has("c")) continue;
      if ((before || after) && lastPrinted >= 0 && i - before > lastPrinted + 1) ctx.stdout.write("--\n");
      for (let j = Math.max(lastPrinted + 1, i - before); j < i; j++) ctx.stdout.write(prefix(j, "-") + all[j] + "\n");
      if (f.has("o") && !f.has("v")) {
        regex.lastIndex = 0;
        for (const match of line.matchAll(regex)) if (match[0]) ctx.stdout.write(prefix(i, ":") + match[0] + "\n");
      } else ctx.stdout.write(prefix(i, ":") + line + "\n");
      lastPrinted = i;
      pendingAfter = after;
    }
    if (f.has("c")) ctx.stdout.write((named ? name + ":" : "") + matches + "\n");
    if (f.has("l") && found) ctx.stdout.write(name + "\n");
    if (f.has("L") && !found) ctx.stdout.write(name + "\n");
    return found;
  };
  if (!operands.length) {
    if (search(ctx.stdin.read(), "(standard input)")) status = 0;
  } else {
    for (const target of targets) {
      let text: string;
      try {
        text = decode(await ctx.fs.read(ctx.resolve(target)));
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
        errors = true;
        continue;
      }
      if (search(text, target)) {
        status = 0;
        if (f.has("q")) return 0;
      }
    }
  }
  return errors && status !== 0 && !f.has("q") ? 2 : status;
};

type SortKey = { start: number; startChar: number; end: number; endChar: number; flags: string };

function parseKey(spec: string): SortKey {
  const match = spec.match(/^(\d+)(?:\.(\d+))?([a-zA-Z]*)(?:,(\d+)(?:\.(\d+))?([a-zA-Z]*))?$/);
  if (!match) throw new CommandError("invalid key specification: " + spec, 2);
  return { start: Number(match[1]), startChar: Number(match[2] ?? 1), end: match[4] ? Number(match[4]) : Infinity, endChar: Number(match[5] ?? 0), flags: (match[3] ?? "") + (match[6] ?? "") };
}

function humanValue(text: string): number {
  const match = text.trim().match(/^([+-]?\d*\.?\d+)\s*([KMGTPE]?)/i);
  if (!match) return 0;
  return Number(match[1]) * 1024 ** " KMGTPE".indexOf((match[2] || " ").toUpperCase());
}

function versionCompare(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? [];
  const pb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    if (/^\d/.test(x) && /^\d/.test(y)) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const sort: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "nrufbsghVMcCRz", values: "ktoS", long: { "numeric-sort": "n", reverse: "r", unique: "u", "ignore-case": "f", "ignore-leading-blanks": "b", stable: "s", "general-numeric-sort": "g", "human-numeric-sort": "h", "version-sort": "V", key: "k", "field-separator": "t", output: "o", check: "c", "random-sort": "R" } });
  const f = parsed.flags;
  const { text, status } = await allInput(ctx, parsed.operands);
  const items = lines(text);
  const separator = last(parsed, "t");
  const keys = (parsed.values.get("k") ?? []).map(parseKey);
  const split = (line: string): string[] => (separator !== undefined ? line.split(separator) : line.match(/\s*\S+/g) ?? [""]);
  const extract = (line: string, key: SortKey): string => {
    const fields = split(line);
    if (key.end === Infinity) {
      const rest = fields.slice(key.start - 1).join(separator ?? "");
      return (separator === undefined ? rest.replace(/^\s+/, "") : rest).slice(key.startChar - 1);
    }
    const span = fields.slice(key.start - 1, key.end).join(separator ?? "");
    const trimmed = separator === undefined ? span.replace(/^\s+/, "") : span;
    const endOffset = key.endChar ? trimmed.length - (fields[key.end - 1] ?? "").replace(/^\s+/, "").length + key.endChar : trimmed.length;
    return trimmed.slice(key.startChar - 1, endOffset);
  };
  const compareWith = (a: string, b: string, flags: string): number => {
    const has = (flag: string) => flags.includes(flag);
    if (has("f")) {
      a = a.toUpperCase();
      b = b.toUpperCase();
    }
    if (has("b")) {
      a = a.trimStart();
      b = b.trimStart();
    }
    let result: number;
    if (has("n") || has("g")) {
      const x = parseFloat(a.trim()) || 0;
      const y = parseFloat(b.trim()) || 0;
      result = x - y;
    } else if (has("h")) result = humanValue(a) - humanValue(b);
    else if (has("V")) result = versionCompare(a, b);
    else result = a < b ? -1 : a > b ? 1 : 0;
    return has("r") ? -result : result;
  };
  const global = [...f].join("");
  const compare = (a: string, b: string): number => {
    for (const key of keys) {
      const flags = key.flags || global;
      const result = compareWith(extract(a, key), extract(b, key), flags.replace(/[usz]/g, ""));
      if (result) return result;
    }
    if (keys.length && f.has("s")) return 0;
    if (!keys.length) {
      const result = compareWith(a, b, global);
      if (result || f.has("s") || f.has("u")) return result;
    }
    if (f.has("u")) return 0;
    const result = a < b ? -1 : a > b ? 1 : 0;
    return f.has("r") ? -result : result;
  };
  if (f.has("c") || f.has("C")) {
    for (let i = 1; i < items.length; i++) {
      if (compare(items[i - 1], items[i]) > 0) {
        if (f.has("c")) ctx.stderr.write("sort: -:" + (i + 1) + ": disorder: " + items[i] + "\n");
        return 1;
      }
    }
    return 0;
  }
  let sorted = items.map((line, index) => ({ line, index }));
  if (f.has("R")) sorted.sort(() => Math.random() - 0.5);
  else sorted.sort((a, b) => compare(a.line, b.line) || a.index - b.index);
  if (f.has("u")) sorted = sorted.filter((item, index) => index === 0 || compare(sorted[index - 1].line, item.line) !== 0);
  const output = joinLines(sorted.map(item => item.line));
  const out = last(parsed, "o");
  if (out !== undefined) await ctx.fs.write(ctx.resolve(out), encode(output));
  else ctx.stdout.write(output);
  return status;
};

const uniq: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "cdui", values: "fsw", long: { count: "c", repeated: "d", unique: "u", "ignore-case": "i", "skip-fields": "f", "skip-chars": "s", "check-chars": "w" } });
  const f = parsed.flags;
  const { text, status } = await allInput(ctx, parsed.operands.slice(0, 1));
  const skipFields = Number(last(parsed, "f") ?? 0);
  const skipChars = Number(last(parsed, "s") ?? 0);
  const width = last(parsed, "w") === undefined ? undefined : Number(last(parsed, "w"));
  const key = (line: string) => {
    let value = line;
    for (let i = 0; i < skipFields; i++) value = value.replace(/^\s*\S+/, "");
    value = value.slice(skipChars);
    if (width !== undefined) value = value.slice(0, width);
    return f.has("i") ? value.toLowerCase() : value;
  };
  const groups: { line: string; count: number }[] = [];
  for (const line of lines(text)) {
    const previous = groups[groups.length - 1];
    if (previous && key(previous.line) === key(line)) previous.count++;
    else groups.push({ line, count: 1 });
  }
  const out = groups.filter(group => (f.has("d") ? group.count > 1 : true) && (f.has("u") ? group.count === 1 : true)).map(group => (f.has("c") ? String(group.count).padStart(7) + " " : "") + group.line);
  const result = joinLines(out);
  if (parsed.operands[1]) await ctx.fs.write(ctx.resolve(parsed.operands[1]), encode(result));
  else ctx.stdout.write(result);
  return status;
};

function ranges(spec: string): (n: number) => boolean {
  const parts = spec.split(",").map(part => {
    const match = part.match(/^(\d*)(-?)(\d*)$/);
    if (!match || (!match[1] && !match[3])) throw new CommandError("invalid field range", 1);
    const from = match[1] ? Number(match[1]) : 1;
    const to = match[2] ? (match[3] ? Number(match[3]) : Infinity) : from;
    return [from, to] as const;
  });
  return n => parts.some(([from, to]) => n >= from && n <= to);
}

const cut: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "sn", values: "dfcb", long: { delimiter: "d", fields: "f", characters: "c", bytes: "b", "only-delimited": "s", complement: "complement", "output-delimiter": "output-delimiter" } });
  const fields = last(parsed, "f");
  const chars = last(parsed, "c") ?? last(parsed, "b");
  if (!fields && !chars) throw new CommandError("you must specify a list of bytes, characters, or fields");
  const complement = parsed.values.has("complement");
  const selector = ranges((fields ?? chars)!);
  const pick = (n: number) => selector(n) !== complement;
  const delimiter = last(parsed, "d") ?? "\t";
  if (delimiter.length !== 1) throw new CommandError("the delimiter must be a single character");
  const output = last(parsed, "output-delimiter") ?? (fields ? delimiter : "");
  const { text, status } = await allInput(ctx, parsed.operands);
  const out: string[] = [];
  for (const line of lines(text)) {
    if (fields) {
      if (!line.includes(delimiter)) {
        if (!parsed.flags.has("s")) out.push(line);
        continue;
      }
      out.push(line.split(delimiter).filter((_, index) => pick(index + 1)).join(output));
    } else out.push([...line].filter((_, index) => pick(index + 1)).join(output));
  }
  ctx.stdout.write(joinLines(out));
  return status;
};

const CLASS_CHARS: Record<string, string> = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digit: "0123456789",
  space: " \t\n\r\f\v",
  blank: " \t",
  punct: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
  xdigit: "0123456789ABCDEFabcdef",
};
CLASS_CHARS.alpha = CLASS_CHARS.lower + CLASS_CHARS.upper;
CLASS_CHARS.alnum = CLASS_CHARS.alpha + CLASS_CHARS.digit;

function trSet(spec: string): string[] {
  const out: string[] = [];
  const [text] = escapes(spec);
  for (let i = 0; i < text.length; i++) {
    const cls = text.slice(i).match(/^\[:(\w+):\]/);
    if (cls && CLASS_CHARS[cls[1]]) {
      out.push(...CLASS_CHARS[cls[1]]);
      i += cls[0].length - 1;
      continue;
    }
    const repeat = text.slice(i).match(/^\[(.)\*(\d*)\]/);
    if (repeat) {
      out.push(...Array(Number(repeat[2] || 0) || 1).fill(repeat[1]));
      i += repeat[0].length - 1;
      continue;
    }
    if (text[i + 1] === "-" && i + 2 < text.length) {
      const from = text.charCodeAt(i);
      const to = text.charCodeAt(i + 2);
      for (let c = from; c <= to; c++) out.push(String.fromCharCode(c));
      i += 2;
      continue;
    }
    out.push(text[i]);
  }
  return out;
}

const tr: CommandHandler = ctx => {
  const parsed = options(ctx.args, { flags: "dscCt", long: { delete: "d", "squeeze-repeats": "s", complement: "c", truncate: "t" } });
  const f = parsed.flags;
  const [first, second] = parsed.operands;
  if (first === undefined) throw new CommandError("missing operand");
  const complement = f.has("c") || f.has("C");
  const set1 = new Set(trSet(first));
  const list1 = trSet(first);
  const set2 = second !== undefined ? trSet(second) : [];
  const inSet1 = (c: string) => set1.has(c) !== complement;
  const input = ctx.stdin.read();
  let out = "";
  let previous = "";
  const squeeze = f.has("s") ? new Set(f.has("d") || second === undefined ? (second === undefined ? [...set1] : set2) : set2) : undefined;
  for (const c of input) {
    let value: string | undefined = c;
    if (f.has("d")) {
      if (inSet1(c)) continue;
    } else if (second !== undefined && inSet1(c)) {
      if (complement) value = set2[set2.length - 1] ?? c;
      else {
        const index = list1.lastIndexOf(c);
        value = index < set2.length ? set2[index] : set2[set2.length - 1] ?? c;
      }
    }
    if (squeeze && value === previous && (second === undefined && !f.has("d") ? inSet1(value) : squeeze.has(value))) continue;
    out += value;
    previous = value;
  }
  ctx.stdout.write(out);
  return 0;
};

const seq: CommandHandler = ctx => {
  const parsed = options(ctx.args.map(arg => (/^-\d/.test(arg) ? "\u0000" + arg : arg)), { flags: "w", values: "sf", long: { separator: "s", "equal-width": "w", format: "f" } });
  const numbers = parsed.operands.map(arg => arg.replace("\u0000", ""));
  if (!numbers.length || numbers.length > 3) throw new CommandError("missing operand");
  const [first, step, end] = numbers.length === 1 ? ["1", "1", numbers[0]] : numbers.length === 2 ? [numbers[0], "1", numbers[1]] : numbers;
  const values = [first, step, end].map(Number);
  if (values.some(Number.isNaN)) throw new CommandError("invalid floating point argument");
  const [a, inc, b] = values;
  if (inc === 0) throw new CommandError("invalid Zero increment value: '0'");
  const decimals = Math.max(...[first, step].map(text => (text.includes(".") ? text.split(".")[1].length : 0)));
  const out: string[] = [];
  let length = 0;
  for (let i = 0; ; i++) {
    const value = a + i * inc;
    if (inc > 0 ? value > b + 1e-10 : value < b - 1e-10) break;
    if ((length += 8) > ctx.limits.maxBufferLength) throw new CommandError("output exceeded " + ctx.limits.maxBufferLength + " characters");
    out.push(last(parsed, "f") ? format(last(parsed, "f")!, [value], false).text : value.toFixed(decimals));
  }
  if (parsed.flags.has("w")) {
    const width = Math.max(...out.map(value => value.length));
    for (let i = 0; i < out.length; i++) out[i] = out[i].startsWith("-") ? "-" + out[i].slice(1).padStart(width - 1, "0") : out[i].padStart(width, "0");
  }
  ctx.stdout.write(out.length ? out.join(last(parsed, "s") ?? "\n") + "\n" : "");
  return 0;
};

const rev: CommandHandler = async ctx => {
  const { text, status } = await allInput(ctx, ctx.args);
  ctx.stdout.write(joinLines(lines(text).map(line => [...line].reverse().join(""))));
  return status;
};

const tac: CommandHandler = async ctx => {
  const { text, status } = await allInput(ctx, ctx.args);
  ctx.stdout.write(joinLines(lines(text).reverse()));
  return status;
};

const nl: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { values: "bwsv", long: { "body-numbering": "b", "number-width": "w", "number-separator": "s" } });
  const { text, status } = await allInput(ctx, parsed.operands);
  const all = last(parsed, "b") === "a";
  const width = Number(last(parsed, "w") ?? 6);
  const separator = last(parsed, "s") ?? "\t";
  let n = Number(last(parsed, "v") ?? 1);
  ctx.stdout.write(joinLines(lines(text).map(line => (line === "" && !all ? " ".repeat(width + separator.length) : String(n++).padStart(width) + separator + line))));
  return status;
};

const paste: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "s", values: "d", long: { serial: "s", delimiters: "d" } });
  const [delimiters] = escapes(last(parsed, "d") ?? "\t");
  const operands = parsed.operands.length ? parsed.operands : ["-"];
  const columns: string[][] = [];
  let status = 0;
  let stdin: string[] | undefined;
  for (const operand of operands) {
    if (operand === "-") {
      stdin ??= lines(ctx.stdin.read());
      columns.push(stdin);
      continue;
    }
    try {
      columns.push(lines(decode(await ctx.fs.read(ctx.resolve(operand)))));
    } catch {
      ctx.stderr.write("paste: " + operand + ": No such file or directory\n");
      status = 1;
    }
  }
  const delimiter = (index: number) => delimiters[index % Math.max(1, delimiters.length)] ?? "";
  const join = (values: string[]) => values.reduce((out, value, index) => (index ? out + delimiter(index - 1) : "") + value, "");
  if (parsed.flags.has("s")) ctx.stdout.write(joinLines(columns.map(join)));
  else {
    const height = Math.max(0, ...columns.map(column => column.length));
    ctx.stdout.write(joinLines(Array.from({ length: height }, (_, row) => join(columns.map(column => column[row] ?? "")))));
  }
  return status;
};

const xargs: CommandHandler = async ctx => {
  const args = ctx.args;
  let i = 0;
  let max: number | undefined;
  let replace: string | undefined;
  let delimiter: string | undefined;
  let skipEmpty = false;
  let trace = false;
  for (; i < args.length && args[i].startsWith("-") && args[i] !== "-"; i++) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "-0" || arg === "--null") delimiter = "\0";
    else if (arg === "-r" || arg === "--no-run-if-empty") skipEmpty = true;
    else if (arg === "-t" || arg === "--verbose") trace = true;
    else if (arg.startsWith("-n")) max = Number(arg.length > 2 ? arg.slice(2) : args[++i]);
    else if (arg.startsWith("-L")) max = Number(arg.length > 2 ? arg.slice(2) : args[++i]);
    else if (arg === "-I" || arg === "-i") replace = arg === "-i" ? "{}" : args[++i];
    else if (arg.startsWith("-I")) replace = arg.slice(2);
    else if (arg.startsWith("-d")) delimiter = escapes(arg.length > 2 ? arg.slice(2) : args[++i])[0];
    else if (arg.startsWith("-P")) {
      if (arg.length === 2) i++;
    } else if (arg.startsWith("-s") || arg.startsWith("-E")) {
      if (arg.length === 2) i++;
    } else if (arg === "-x" || arg === "-p") continue;
    else throw new CommandError("invalid option -- '" + arg.slice(1) + "'");
  }
  const command = args.slice(i).length ? args.slice(i) : ["echo"];
  const input = ctx.stdin.read();
  let items: string[];
  if (replace !== undefined) items = input.split(delimiter ?? "\n").filter((line, index, all) => line !== "" || index < all.length - 1).filter(line => line.trim() !== "");
  else if (delimiter !== undefined) items = input.split(delimiter).filter((item, index, all) => !(item === "" && index === all.length - 1));
  else items = [...input.matchAll(/"([^"]*)"|'([^']*)'|((?:\\.|[^\s"'])+)/g)].map(match => match[1] ?? match[2] ?? match[3].replace(/\\(.)/g, "$1"));
  if (!items.length && (skipEmpty || replace !== undefined)) return 0;
  let status = 0;
  const run = async (argv: string[]) => {
    if (trace) ctx.stderr.write(argv.join(" ") + "\n");
    const code = await ctx.run(argv, "");
    if (code === 255) throw new CommandError(argv[0] + ": exited with status 255; aborting", 124);
    if (code !== 0) status = code === 127 ? 127 : 123;
  };
  if (replace !== undefined) {
    for (const item of items) await run(command.map(word => word.split(replace!).join(item)));
  } else if (max) {
    for (let start = 0; start < Math.max(items.length, 1); start += max) await run([...command, ...items.slice(start, start + max)]);
  } else await run([...command, ...items]);
  return status;
};

const STRFTIME_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STRFTIME_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function strftime(spec: string, date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = Math.floor((date.getTime() - start) / 86400000) + 1;
  return spec.replace(/%([-_0]?)([a-zA-Z%+])/g, (whole, pad: string, c: string) => {
    let value: string;
    switch (c) {
      case "Y": value = String(date.getUTCFullYear()); break;
      case "y": value = two(date.getUTCFullYear() % 100); break;
      case "C": value = two(Math.floor(date.getUTCFullYear() / 100)); break;
      case "m": value = two(date.getUTCMonth() + 1); break;
      case "d": value = two(date.getUTCDate()); break;
      case "e": value = String(date.getUTCDate()).padStart(2, " "); break;
      case "H": value = two(date.getUTCHours()); break;
      case "k": value = String(date.getUTCHours()).padStart(2, " "); break;
      case "I": value = two(date.getUTCHours() % 12 || 12); break;
      case "l": value = String(date.getUTCHours() % 12 || 12).padStart(2, " "); break;
      case "M": value = two(date.getUTCMinutes()); break;
      case "S": value = two(date.getUTCSeconds()); break;
      case "N": value = String(date.getUTCMilliseconds() * 1000000).padStart(9, "0"); break;
      case "s": value = String(Math.floor(date.getTime() / 1000)); break;
      case "p": value = date.getUTCHours() < 12 ? "AM" : "PM"; break;
      case "P": value = date.getUTCHours() < 12 ? "am" : "pm"; break;
      case "a": value = STRFTIME_DAYS[date.getUTCDay()].slice(0, 3); break;
      case "A": value = STRFTIME_DAYS[date.getUTCDay()]; break;
      case "b":
      case "h": value = STRFTIME_MONTHS[date.getUTCMonth()].slice(0, 3); break;
      case "B": value = STRFTIME_MONTHS[date.getUTCMonth()]; break;
      case "j": value = String(day).padStart(3, "0"); break;
      case "u": value = String(date.getUTCDay() || 7); break;
      case "w": value = String(date.getUTCDay()); break;
      case "Z": value = "UTC"; break;
      case "z": value = "+0000"; break;
      case "F": value = strftime("%Y-%m-%d", date); break;
      case "T": value = strftime("%H:%M:%S", date); break;
      case "R": value = strftime("%H:%M", date); break;
      case "D": value = strftime("%m/%d/%y", date); break;
      case "c": value = strftime("%a %b %e %H:%M:%S %Y", date); break;
      case "x": value = strftime("%m/%d/%y", date); break;
      case "X": value = strftime("%H:%M:%S", date); break;
      case "n": value = "\n"; break;
      case "t": value = "\t"; break;
      case "%": value = "%"; break;
      case "+": value = strftime("%a %b %e %H:%M:%S %Z %Y", date); break;
      default: return whole;
    }
    if (pad === "-") value = value.replace(/^[0 ]+(?=.)/, "");
    else if (pad === "_") value = value.replace(/^0+(?=.)/, match => " ".repeat(match.length));
    return value;
  });
}

const date: CommandHandler = ctx => {
  const parsed = options(ctx.args, { flags: "uRI", values: "dr", long: { utc: "u", universal: "u", date: "d", "rfc-email": "R", "iso-8601": "iso", reference: "r" } });
  let when = new Date();
  const input = last(parsed, "d");
  if (input !== undefined) {
    const trimmed = input.trim();
    if (trimmed.startsWith("@")) when = new Date(Number(trimmed.slice(1)) * 1000);
    else if (trimmed === "now" || trimmed === "") when = new Date();
    else if (trimmed === "yesterday" || trimmed === "tomorrow") when = new Date(Date.now() + (trimmed === "yesterday" ? -86400000 : 86400000));
    else {
      const relative = trimmed.match(/^([+-]?\d+)\s*(second|minute|hour|day|week)s?(\s+ago)?$/);
      if (relative) {
        const unit = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }[relative[2]]!;
        when = new Date(Date.now() + Number(relative[1]) * unit * (relative[3] ? -1 : 1));
      } else {
        const parsedDate = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed + "T00:00:00Z" : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(trimmed) ? trimmed.replace(" ", "T") + "Z" : trimmed);
        if (Number.isNaN(parsedDate)) throw new CommandError("invalid date '" + input + "'");
        when = new Date(parsedDate);
      }
    }
  }
  const spec = parsed.operands.find(operand => operand.startsWith("+"));
  if (spec) ctx.stdout.write(strftime(spec.slice(1), when) + "\n");
  else if (parsed.flags.has("R")) ctx.stdout.write(strftime("%a, %d %b %Y %H:%M:%S +0000", when) + "\n");
  else if (parsed.flags.has("I") || parsed.values.has("iso")) {
    const precision = last(parsed, "iso");
    ctx.stdout.write((precision && precision !== "date" ? when.toISOString().replace(/\.\d+Z$/, "+00:00") : strftime("%F", when)) + "\n");
  } else ctx.stdout.write(strftime("%a %b %e %H:%M:%S %Z %Y", when) + "\n");
  return 0;
};

const sleep: CommandHandler = async ctx => {
  if (!ctx.args.length) throw new CommandError("missing operand");
  let total = 0;
  for (const arg of ctx.args) {
    const match = arg.match(/^(\d*\.?\d+)([smhd]?)$/);
    if (!match) throw new CommandError("invalid time interval '" + arg + "'");
    total += Number(match[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]]! * 1000;
  }
  await ctx.sleep(total);
  return 0;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const base64: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "di", values: "w", long: { decode: "d", "ignore-garbage": "i", wrap: "w" } });
  const operand = parsed.operands[0] ?? "-";
  const bytes = operand === "-" ? encode(ctx.stdin.read()) : await ctx.fs.read(ctx.resolve(operand));
  if (parsed.flags.has("d")) {
    const text = decode(bytes).replace(/[^A-Za-z0-9+/=_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
    let binary: string;
    try {
      binary = atob(text.padEnd(Math.ceil(text.length / 4) * 4, "="));
    } catch {
      throw new CommandError("invalid input");
    }
    ctx.stdout.write(decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    return 0;
  }
  const encoded = bytesToBase64(bytes);
  const wrap = Number(last(parsed, "w") ?? 76);
  ctx.stdout.write((wrap > 0 ? encoded.match(new RegExp(".{1," + wrap + "}", "g"))?.join("\n") ?? "" : encoded) + "\n");
  return 0;
};

function digest(algorithm: string): CommandHandler {
  return async ctx => {
    const parsed = options(ctx.args, { flags: "bctwz", long: { binary: "b", check: "c", text: "t", tag: "" } });
    let status = 0;
    for (const operand of parsed.operands.length ? parsed.operands : ["-"]) {
      let bytes: Uint8Array;
      try {
        bytes = operand === "-" ? encode(ctx.stdin.read()) : await ctx.fs.read(ctx.resolve(operand));
      } catch {
        ctx.stderr.write(ctx.name + ": " + operand + ": No such file or directory\n");
        status = 1;
        continue;
      }
      const hash = new Uint8Array(await crypto.subtle.digest(algorithm, bytes as Uint8Array<ArrayBuffer>));
      ctx.stdout.write([...hash].map(byte => byte.toString(16).padStart(2, "0")).join("") + "  " + operand + "\n");
    }
    return status;
  };
}

const expr: CommandHandler = ctx => {
  const tokens = ctx.args;
  let pos = 0;
  const isNumber = (value: string) => /^-?\d+$/.test(value);
  const primary = (): string => {
    const token = tokens[pos++];
    if (token === undefined) throw new CommandError("syntax error: missing argument", 2);
    if (token === "(") {
      const value = or();
      pos++;
      return value;
    }
    if (token === "length") return String(primary().length);
    if (token === "substr") {
      const text = primary();
      const start = Number(primary());
      const length = Number(primary());
      return text.substr(start - 1, length);
    }
    if (token === "index") {
      const text = primary();
      const chars = primary();
      const index = [...text].findIndex(c => chars.includes(c));
      return String(index + 1);
    }
    if (token === "match") {
      const text = primary();
      return match(text, primary());
    }
    return token;
  };
  const match = (text: string, pattern: string): string => {
    const result = text.match(posixRegExp("^" + pattern.replace(/^\^/, ""), false));
    if (!result) return /\\\(/.test(pattern) ? "" : "0";
    return result[1] ?? String(result[0].length);
  };
  const colon = (): string => {
    let value = primary();
    while (tokens[pos] === ":") {
      pos++;
      value = match(value, primary());
    }
    return value;
  };
  const mul = (): string => {
    let value = colon();
    while (["*", "/", "%"].includes(tokens[pos])) {
      const op = tokens[pos++];
      const right = colon();
      if (!isNumber(value) || !isNumber(right)) throw new CommandError("non-integer argument", 2);
      if (op !== "*" && Number(right) === 0) throw new CommandError("division by zero", 2);
      value = String(op === "*" ? Number(value) * Number(right) : op === "/" ? Math.trunc(Number(value) / Number(right)) : Number(value) % Number(right));
    }
    return value;
  };
  const add = (): string => {
    let value = mul();
    while (tokens[pos] === "+" || tokens[pos] === "-") {
      const op = tokens[pos++];
      const right = mul();
      if (!isNumber(value) || !isNumber(right)) throw new CommandError("non-integer argument", 2);
      value = String(op === "+" ? Number(value) + Number(right) : Number(value) - Number(right));
    }
    return value;
  };
  const cmp = (): string => {
    let value = add();
    while (["=", "==", "!=", "<", "<=", ">", ">="].includes(tokens[pos])) {
      const op = tokens[pos++];
      const right = add();
      const numeric = isNumber(value) && isNumber(right);
      const a: number | string = numeric ? Number(value) : value;
      const b: number | string = numeric ? Number(right) : right;
      const result = op === "=" || op === "==" ? a === b : op === "!=" ? a !== b : op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
      value = result ? "1" : "0";
    }
    return value;
  };
  const and = (): string => {
    let value = cmp();
    while (tokens[pos] === "&") {
      pos++;
      const right = cmp();
      value = value !== "" && value !== "0" && right !== "" && right !== "0" ? value : "0";
    }
    return value;
  };
  const or = (): string => {
    let value = and();
    while (tokens[pos] === "|") {
      pos++;
      const right = and();
      value = value !== "" && value !== "0" ? value : right !== "" && right !== "0" ? right : "0";
    }
    return value;
  };
  const value = or();
  ctx.stdout.write(value + "\n");
  return value === "" || value === "0" ? 1 : 0;
};

const fold: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "sb", values: "w", numeric: true, long: { width: "w", spaces: "s" } });
  const width = Number(last(parsed, "w") ?? last(parsed, "n") ?? 80);
  const { text, status } = await allInput(ctx, parsed.operands);
  const out = text.split("\n").map(line => {
    const parts: string[] = [];
    let rest = line;
    while (rest.length > width) {
      let cut = width;
      if (parsed.flags.has("s")) {
        const space = rest.lastIndexOf(" ", width - 1);
        if (space > 0) cut = space + 1;
      }
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    parts.push(rest);
    return parts.join("\n");
  });
  ctx.stdout.write(out.join("\n"));
  return status;
};

const column: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "tn", values: "so", long: { table: "t", separator: "s", "output-separator": "o" } });
  const { text, status } = await allInput(ctx, parsed.operands);
  const rows = lines(text);
  if (!parsed.flags.has("t")) {
    ctx.stdout.write(joinLines(rows));
    return status;
  }
  const separator = last(parsed, "s");
  const cells = rows.filter(row => row.trim() !== "").map(row => (separator ? row.split(new RegExp("[" + separator.replace(/[\]\\^-]/g, "\\$&") + "]")) : row.trim().split(/\s+/)));
  const widths: number[] = [];
  for (const row of cells) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)));
  const gap = last(parsed, "o") ?? "  ";
  ctx.stdout.write(joinLines(cells.map(row => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]))).join(gap))));
  return status;
};

function lcsDiff(a: string[], b: string[]): { op: " " | "-" | "+"; line: string }[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 25_000_000) throw new CommandError("inputs too large to compare");
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: { op: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ op: " ", line: a[i] });
      i++;
      j++;
    } else if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) out.push({ op: "+", line: b[j++] });
    else out.push({ op: "-", line: a[i++] });
  }
  return out;
}

const diff: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "uqiwbBN", values: "U", long: { unified: "U", brief: "q", "ignore-case": "i", "ignore-all-space": "w" } });
  const [left, right] = parsed.operands;
  if (left === undefined || right === undefined) throw new CommandError("missing operand", 2);
  const read = async (name: string) => (name === "-" ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(name))));
  const [a, b] = [lines(await read(left)), lines(await read(right))];
  const normal = (line: string) => {
    let value = line;
    if (parsed.flags.has("i")) value = value.toLowerCase();
    if (parsed.flags.has("w")) value = value.replace(/\s+/g, "");
    return value;
  };
  const edits = lcsDiff(a.map(normal), b.map(normal));
  let ai = 0;
  let bi = 0;
  const rich = edits.map(edit => {
    const item = { ...edit, line: edit.op === "+" ? b[bi] : a[ai], a: ai, b: bi };
    if (edit.op !== "+") ai++;
    if (edit.op !== "-") bi++;
    return item;
  });
  if (rich.every(edit => edit.op === " ")) return 0;
  if (parsed.flags.has("q")) {
    ctx.stdout.write("Files " + left + " and " + right + " differ\n");
    return 1;
  }
  if (parsed.flags.has("u") || parsed.values.has("U")) {
    const context = Number(last(parsed, "U") ?? 3);
    ctx.stdout.write("--- " + left + "\n+++ " + right + "\n");
    let i = 0;
    while (i < rich.length) {
      if (rich[i].op === " ") {
        i++;
        continue;
      }
      let start = Math.max(0, i - context);
      let end = i;
      while (end < rich.length) {
        if (rich[end].op !== " ") {
          end++;
          continue;
        }
        let run = end;
        while (run < rich.length && rich[run].op === " ") run++;
        if (run - end > context * 2 || run === rich.length) {
          end = Math.min(rich.length, end + context);
          break;
        }
        end = run;
      }
      const hunk = rich.slice(start, end);
      const aCount = hunk.filter(edit => edit.op !== "+").length;
      const bCount = hunk.filter(edit => edit.op !== "-").length;
      ctx.stdout.write("@@ -" + (hunk[0].a + (aCount ? 1 : 0)) + "," + aCount + " +" + (hunk[0].b + (bCount ? 1 : 0)) + "," + bCount + " @@\n");
      for (const edit of hunk) ctx.stdout.write(edit.op + edit.line + "\n");
      i = end;
      start = end;
    }
    return 1;
  }
  let i = 0;
  while (i < rich.length) {
    if (rich[i].op === " ") {
      i++;
      continue;
    }
    let end = i;
    while (end < rich.length && rich[end].op !== " ") end++;
    const block = rich.slice(i, end);
    const removed = block.filter(edit => edit.op === "-");
    const added = block.filter(edit => edit.op === "+");
    const range = (from: number, count: number) => (count > 1 ? from + 1 + "," + (from + count) : String(from + (count ? 1 : 0)));
    const kind = removed.length && added.length ? "c" : removed.length ? "d" : "a";
    ctx.stdout.write(range(block[0].a, removed.length) + kind + range(block[0].b, added.length) + "\n");
    for (const edit of removed) ctx.stdout.write("< " + edit.line + "\n");
    if (kind === "c") ctx.stdout.write("---\n");
    for (const edit of added) ctx.stdout.write("> " + edit.line + "\n");
    i = end;
  }
  return 1;
};

const comm: CommandHandler = async ctx => {
  const parsed = options(ctx.args, { flags: "123" });
  const [left, right] = parsed.operands;
  if (left === undefined || right === undefined) throw new CommandError("missing operand");
  const read = async (name: string) => lines(name === "-" ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(name))));
  const [a, b] = [await read(left), await read(right)];
  const show = [!parsed.flags.has("1"), !parsed.flags.has("2"), !parsed.flags.has("3")];
  const write = (column: number, line: string) => {
    if (!show[column]) return;
    ctx.stdout.write("\t".repeat(show.slice(0, column).filter(Boolean).length) + line + "\n");
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) write(0, a[i++]);
    else if (i >= a.length || b[j] < a[i]) write(1, b[j++]);
    else {
      write(2, a[i]);
      i++;
      j++;
    }
  }
  return 0;
};

export const textCommands: Record<string, CommandHandler> = {
  echo,
  printf,
  head: ctx => headTail(ctx, false),
  tail: ctx => headTail(ctx, true),
  wc,
  grep,
  egrep: ctx => grep({ ...ctx, args: ["-E", ...ctx.args] }),
  fgrep: ctx => grep({ ...ctx, args: ["-F", ...ctx.args] }),
  sort,
  uniq,
  cut,
  tr,
  seq,
  rev,
  tac,
  nl,
  paste,
  xargs,
  date,
  sleep,
  base64,
  sha256sum: digest("SHA-256"),
  sha1sum: digest("SHA-1"),
  sha512sum: digest("SHA-512"),
  expr,
  fold,
  column,
  diff,
  comm,
  whoami: ctx => void ctx.stdout.write((ctx.env.USER ?? "user") + "\n"),
  hostname: ctx => void ctx.stdout.write("localhost\n"),
  uname: ctx => void ctx.stdout.write((ctx.args.includes("-a") ? "Linux localhost 6.0.0 #1 SMP x86_64 GNU/Linux" : ctx.args.includes("-m") ? "x86_64" : "Linux") + "\n"),
  nproc: ctx => void ctx.stdout.write("1\n"),
  clear: () => 0,
};

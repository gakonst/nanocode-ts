import { CommandError, type CommandHandler } from "../shell.ts";
import { FsError, decode, encode } from "../fs.ts";
import { posixRegExp } from "../text.ts";
import { options } from "./util.ts";

type Address = { kind: "line"; line: number } | { kind: "last" } | { kind: "regex"; regex: RegExp | null } | { kind: "step"; first: number; step: number } | { kind: "relative"; count: number };

type SedCommand = {
  name: string;
  from?: Address;
  to?: Address;
  negate: boolean;
  regex?: RegExp | null;
  replacement?: string;
  global?: boolean;
  occurrence?: number;
  print?: boolean;
  text?: string;
  label?: string;
  file?: string;
  code?: number;
  source?: string;
  target?: string;
  block?: number;
  range?: { active: boolean; end: number };
};

class Parser {
  src: string;
  pos = 0;
  extended: boolean;

  constructor(src: string, extended: boolean) {
    this.src = src;
    this.extended = extended;
  }

  fail(message: string): never {
    throw new CommandError("-e expression #1, char " + (this.pos + 1) + ": " + message);
  }

  blanks() {
    while (this.pos < this.src.length && /[ \t]/.test(this.src[this.pos])) this.pos++;
  }

  delimited(delimiter: string): string {
    let out = "";
    while (this.pos < this.src.length && this.src[this.pos] !== delimiter) {
      if (this.src[this.pos] === "\\" && this.pos + 1 < this.src.length) {
        const next = this.src[this.pos + 1];
        if (next === delimiter) out += delimiter === "&" ? "\\&" : next;
        else if (next === "n") out += "\n";
        else out += "\\" + next;
        this.pos += 2;
        continue;
      }
      if (this.src[this.pos] === "[") {
        const end = this.src.slice(this.pos).match(/^\[\^?\]?(\[:\w+:\]|[^\]])*\]/);
        if (end) {
          out += end[0];
          this.pos += end[0].length;
          continue;
        }
      }
      out += this.src[this.pos++];
    }
    if (this.pos >= this.src.length) this.fail("unterminated `s' command");
    this.pos++;
    return out;
  }

  regex(source: string, flags: string): RegExp | null {
    if (source === "") return null;
    try {
      return posixRegExp(source, this.extended, flags);
    } catch (error) {
      this.fail("invalid regular expression: " + (error as Error).message);
    }
  }

  address(): Address | undefined {
    const c = this.src[this.pos];
    if (c === undefined) return undefined;
    if (/\d/.test(c)) {
      const match = this.src.slice(this.pos).match(/^(\d+)(?:~(\d+))?/)!;
      this.pos += match[0].length;
      if (match[2] !== undefined) return { kind: "step", first: Number(match[1]), step: Number(match[2]) };
      return { kind: "line", line: Number(match[1]) };
    }
    if (c === "$") {
      this.pos++;
      return { kind: "last" };
    }
    if (c === "/" || c === "\\") {
      let delimiter = "/";
      if (c === "\\") {
        delimiter = this.src[this.pos + 1];
        this.pos++;
      }
      this.pos++;
      const source = this.delimited(delimiter);
      let flags = "";
      while (this.src[this.pos] === "I" || this.src[this.pos] === "M") flags += this.src[this.pos++] === "I" ? "i" : "m";
      return { kind: "regex", regex: this.regex(source, flags) };
    }
    if (c === "+" || c === "~") {
      const match = this.src.slice(this.pos + 1).match(/^\d+/);
      if (!match) return undefined;
      this.pos += 1 + match[0].length;
      return { kind: "relative", count: Number(match[0]) };
    }
    return undefined;
  }

  text(): string {
    this.blanks();
    if (this.src[this.pos] === "\\") {
      this.pos++;
      if (this.src[this.pos] === "\n") this.pos++;
    }
    let out = "";
    while (this.pos < this.src.length && this.src[this.pos] !== "\n") {
      if (this.src[this.pos] === "\\" && this.pos + 1 < this.src.length) {
        const next = this.src[this.pos + 1];
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        this.pos += 2;
        continue;
      }
      out += this.src[this.pos++];
    }
    return out;
  }

  word(): string {
    this.blanks();
    const match = this.src.slice(this.pos).match(/^[^;\n}]*/)![0];
    this.pos += match.length;
    return match.trim();
  }

  parse(): SedCommand[] {
    const commands: SedCommand[] = [];
    const blocks: number[] = [];
    for (;;) {
      while (this.pos < this.src.length && /[\s;]/.test(this.src[this.pos])) this.pos++;
      if (this.pos >= this.src.length) break;
      if (this.src[this.pos] === "#") {
        while (this.pos < this.src.length && this.src[this.pos] !== "\n") this.pos++;
        continue;
      }
      const command: SedCommand = { name: "", negate: false };
      command.from = this.address();
      if (command.from && this.src[this.pos] === ",") {
        this.pos++;
        command.to = this.address();
        if (!command.to) this.fail("unexpected `,'");
        command.range = { active: false, end: 0 };
      }
      this.blanks();
      while (this.src[this.pos] === "!") {
        command.negate = true;
        this.pos++;
        this.blanks();
      }
      const name = this.src[this.pos++];
      if (name === undefined) this.fail("missing command");
      command.name = name;
      switch (name) {
        case "{":
          blocks.push(commands.length);
          break;
        case "}": {
          const open = blocks.pop();
          if (open === undefined) this.fail("unexpected `}'");
          commands[open].block = commands.length;
          break;
        }
        case "s": {
          const delimiter = this.src[this.pos++];
          if (!delimiter || delimiter === "\n" || delimiter === "\\") this.fail("unterminated `s' command");
          const source = this.delimited(delimiter);
          command.replacement = this.delimited(delimiter);
          let flags = "";
          for (;;) {
            const c = this.src[this.pos];
            if (c === "g") command.global = true;
            else if (c === "p") command.print = true;
            else if (c === "i" || c === "I") flags += "i";
            else if (c === "m" || c === "M") flags += "m";
            else if (c !== undefined && /\d/.test(c)) {
              const match = this.src.slice(this.pos).match(/^\d+/)![0];
              command.occurrence = Number(match);
              this.pos += match.length - 1;
            } else if (c === "w") {
              this.pos++;
              command.file = this.word();
              break;
            } else break;
            this.pos++;
          }
          command.regex = this.regex(source, flags);
          break;
        }
        case "y": {
          const delimiter = this.src[this.pos++];
          command.source = this.delimited(delimiter);
          command.target = this.delimited(delimiter);
          if ([...command.source].length !== [...command.target].length) this.fail("strings for `y' command are different lengths");
          break;
        }
        case "a":
        case "i":
        case "c":
          command.text = this.text();
          break;
        case "b":
        case "t":
        case "T":
        case ":": {
          const label = this.word();
          if (name === ":" && !label) this.fail("\":\" lacks a label");
          command.label = label;
          break;
        }
        case "r":
        case "R":
        case "w":
        case "W":
          command.file = this.word();
          break;
        case "q":
        case "Q": {
          this.blanks();
          const match = this.src.slice(this.pos).match(/^\d+/);
          if (match) {
            command.code = Number(match[0]);
            this.pos += match[0].length;
          }
          break;
        }
        case "p":
        case "P":
        case "d":
        case "D":
        case "n":
        case "N":
        case "g":
        case "G":
        case "h":
        case "H":
        case "x":
        case "=":
        case "l":
        case "z":
        case "F":
          break;
        default:
          this.pos--;
          this.fail("unknown command: `" + name + "'");
      }
      commands.push(command);
    }
    if (blocks.length) this.fail("unmatched `{'");
    return commands;
  }
}

function substitute(template: string, match: string[]): string {
  let out = "";
  let mode: "" | "U" | "L" = "";
  let once: "" | "u" | "l" = "";
  const add = (text: string) => {
    for (const c of text) {
      let value = mode === "U" ? c.toUpperCase() : mode === "L" ? c.toLowerCase() : c;
      if (once) {
        value = once === "u" ? value.toUpperCase() : value.toLowerCase();
        once = "";
      }
      out += value;
    }
  };
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === "&") add(match[0]);
    else if (c === "\\" && i + 1 < template.length) {
      const next = template[++i];
      if (/\d/.test(next)) add(match[Number(next)] ?? "");
      else if (next === "n") add("\n");
      else if (next === "t") add("\t");
      else if (next === "U" || next === "L") mode = next;
      else if (next === "E") mode = "";
      else if (next === "u" || next === "l") once = next;
      else add(next);
    } else add(c);
  }
  return out;
}

export const sed: CommandHandler = async ctx => {
  let suffix = "";
  const args = ctx.args.map(arg => {
    const match = arg.match(/^(?:-([nErsuz]*)i|--in-place=)(.*)$/);
    if (!match) return arg;
    suffix = match[2];
    return "-" + (match[1] ?? "") + "i";
  });
  const parsed = options(args, { flags: "nErsuziV", values: "efl", long: { quiet: "n", silent: "n", "regexp-extended": "E", expression: "e", file: "f", separate: "s", "in-place": "i", posix: "", debug: "", "null-data": "z", "line-length": "l", version: "V", help: "V", sandbox: "", "follow-symlinks": "" } });
  if (parsed.flags.has("V")) {
    ctx.stdout.write("sed (GNU sed) 4.9\n");
    return 0;
  }
  const inPlace = parsed.flags.has("i");
  const scripts = [...(parsed.values.get("e") ?? [])];
  for (const file of parsed.values.get("f") ?? []) scripts.push(decode(await ctx.fs.read(ctx.resolve(file))));
  const operands = [...parsed.operands];
  if (!scripts.length) {
    if (!operands.length) throw new CommandError("no script specified", 1);
    scripts.push(operands.shift()!);
  }
  const extended = parsed.flags.has("E") || parsed.flags.has("r");
  const commands = new Parser(scripts.join("\n"), extended).parse();
  const labels = new Map<string, number>();
  commands.forEach((command, index) => {
    if (command.name === ":") labels.set(command.label!, index);
  });
  for (const command of commands) if ((command.name === "b" || command.name === "t" || command.name === "T") && command.label && !labels.has(command.label)) throw new CommandError("can't find label for jump to `" + command.label + "'");
  const quiet = parsed.flags.has("n");
  const separator = parsed.flags.has("z") ? "\0" : "\n";
  const writes = new Map<string, string>();
  let lastRegex: RegExp | null = null;
  let exitCode = 0;
  let quit = false;
  const run = async (text: string): Promise<string> => {
    const input = text.split(separator);
    const trailing = input[input.length - 1] === "";
    if (trailing) input.pop();
    let out = "";
    let index = 0;
    let lineNumber = 0;
    let hold = "";
    for (const command of commands) if (command.range) command.range = { active: command.from?.kind === "line" && command.from.line === 0 && command.to?.kind === "regex", end: 0 };
    const isLast = () => index >= input.length;
    const emit = (value: string) => {
      out += value + separator;
    };
    const pick = (regex: RegExp | null | undefined): RegExp => {
      const value = regex ?? lastRegex;
      if (!value) throw new CommandError("no previous regular expression");
      lastRegex = value;
      return value;
    };
    const matchAddress = (address: Address, space: string): boolean => {
      switch (address.kind) {
        case "line":
          return lineNumber === address.line;
        case "last":
          return isLast();
        case "step":
          return address.step <= 0 ? lineNumber === address.first : lineNumber >= address.first && (lineNumber - address.first) % address.step === 0;
        case "regex": {
          const regex = pick(address.regex);
          regex.lastIndex = 0;
          return regex.test(space);
        }
        default:
          return false;
      }
    };
    const selected = (command: SedCommand, space: string): boolean => {
      let hit: boolean;
      if (!command.from) hit = true;
      else if (!command.to) hit = matchAddress(command.from, space);
      else {
        const range = command.range!;
        if (range.active) {
          hit = true;
          const to = command.to;
          if (to.kind === "line") {
            if (lineNumber >= to.line) range.active = false;
          } else if (to.kind === "relative") {
            if (lineNumber >= range.end) range.active = false;
          } else if (matchAddress(to, space)) range.active = false;
        } else if (matchAddress(command.from, space)) {
          hit = true;
          const to = command.to;
          if (to.kind === "line") range.active = to.line > lineNumber;
          else if (to.kind === "relative") {
            range.end = lineNumber + to.count;
            range.active = to.count > 0;
          } else range.active = to.kind === "last" ? !isLast() : true;
        } else hit = false;
      }
      return hit !== command.negate;
    };
    while (index < input.length && !quit) {
      let space = input[index++];
      lineNumber++;
      let appended = "";
      let substituted = false;
      let deleted = false;
      let restart = false;
      let pc = 0;
      while (pc < commands.length) {
        const command = commands[pc];
        if (!selected(command, space)) {
          pc = command.name === "{" ? command.block! + 1 : pc + 1;
          continue;
        }
        pc++;
        switch (command.name) {
          case "s": {
            const regex = pick(command.regex);
            const global = new RegExp(regex.source, regex.flags.replace("g", "") + "g");
            const target = command.occurrence ?? 1;
            let count = 0;
            let changed = false;
            let result = "";
            let last = 0;
            let previous = -1;
            for (let position = 0; position <= space.length; ) {
              global.lastIndex = position;
              const match = global.exec(space);
              if (!match) break;
              if (match[0] === "" && match.index === previous) {
                position = match.index + 1;
                continue;
              }
              count++;
              const replace = count === target || (command.global && count > target);
              if (replace) changed = true;
              result += space.slice(last, match.index) + (replace ? substitute(command.replacement!, [...match].map(group => group ?? "")) : match[0]);
              last = match.index + match[0].length;
              previous = last;
              position = match[0] === "" ? last + 1 : last;
              if (count >= target && !command.global) break;
            }
            result += space.slice(last);
            if (changed) {
              substituted = true;
              space = result;
              if (command.print) emit(space);
              if (command.file) writes.set(command.file, (writes.get(command.file) ?? "") + space + "\n");
            }
            break;
          }
          case "y": {
            const from = [...command.source!];
            const to = [...command.target!];
            space = [...space].map(c => {
              const position = from.indexOf(c);
              return position < 0 ? c : to[position];
            }).join("");
            break;
          }
          case "p":
            emit(space);
            break;
          case "P":
            emit(space.split("\n")[0]);
            break;
          case "d":
            deleted = true;
            pc = commands.length;
            break;
          case "D":
            if (!space.includes("\n")) {
              deleted = true;
              pc = commands.length;
            } else {
              space = space.slice(space.indexOf("\n") + 1);
              restart = true;
              pc = commands.length;
            }
            break;
          case "n":
            if (!quiet) emit(space);
            if (isLast()) {
              deleted = true;
              pc = commands.length;
              break;
            }
            space = input[index++];
            lineNumber++;
            break;
          case "N":
            if (isLast()) {
              pc = commands.length;
              break;
            }
            space += "\n" + input[index++];
            lineNumber++;
            break;
          case "g":
            space = hold;
            break;
          case "G":
            space += "\n" + hold;
            break;
          case "h":
            hold = space;
            break;
          case "H":
            hold += "\n" + space;
            break;
          case "x":
            [space, hold] = [hold, space];
            break;
          case "a":
            appended += command.text + "\n";
            break;
          case "i":
            out += command.text + "\n";
            break;
          case "c":
            if (!command.range || !command.range.active) out += command.text + "\n";
            deleted = true;
            pc = commands.length;
            break;
          case "=":
            out += lineNumber + "\n";
            break;
          case "l":
            out += JSON.stringify(space).slice(1, -1).replace(/\\"/g, '"') + "$\n";
            break;
          case "z":
            space = "";
            break;
          case "F":
            out += "-\n";
            break;
          case "r":
          case "R":
            appended += await ctx.fs.read(ctx.resolve(command.file!)).then(decode, () => "");
            break;
          case "w":
          case "W":
            writes.set(command.file!, (writes.get(command.file!) ?? "") + (command.name === "W" ? space.split("\n")[0] : space) + "\n");
            break;
          case "b":
            pc = command.label ? labels.get(command.label)! : commands.length;
            break;
          case "t":
            if (substituted) {
              substituted = false;
              pc = command.label ? labels.get(command.label)! : commands.length;
            }
            break;
          case "T":
            if (!substituted) pc = command.label ? labels.get(command.label)! : commands.length;
            else substituted = false;
            break;
          case "q":
            quit = true;
            exitCode = command.code ?? 0;
            pc = commands.length;
            break;
          case "Q":
            quit = true;
            exitCode = command.code ?? 0;
            deleted = true;
            pc = commands.length;
            break;
        }
      }
      if (!deleted && !quiet) out += space + (isLast() && !trailing && !appended ? "" : separator);
      out += appended;
      if (restart && !quit) {
        input.splice(--index, 0, space);
        lineNumber--;
      }
    }
    return out;
  };
  let status = 0;
  if (inPlace) {
    for (const operand of operands) {
      const path = ctx.resolve(operand);
      try {
        const original = decode(await ctx.fs.read(path));
        const result = await run(original);
        quit = false;
        if (suffix) await ctx.fs.write(suffix.includes("*") ? ctx.resolve(suffix.replace(/\*/g, operand.split("/").pop()!)) : path + suffix, encode(original));
        await ctx.fs.write(path, encode(result));
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
        ctx.stderr.write("sed: can't read " + operand + ": No such file or directory\n");
        status = 2;
      }
    }
  } else {
    let text = "";
    for (const operand of operands.length ? operands : ["-"]) {
      try {
        const chunk = operand === "-" ? ctx.stdin.read() : decode(await ctx.fs.read(ctx.resolve(operand)));
        text += chunk && !chunk.endsWith("\n") && operand !== operands[operands.length - 1] ? chunk + "\n" : chunk;
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
        ctx.stderr.write("sed: can't read " + operand + ": No such file or directory\n");
        status = 2;
      }
    }
    ctx.stdout.write(await run(text));
  }
  for (const [file, content] of writes) {
    if (file === "/dev/stdout") ctx.stdout.write(content);
    else await ctx.fs.write(ctx.resolve(file), encode(content));
  }
  return exitCode || status;
};

import { FsError, decode, encode, rejoin, resolvePath, type FileSystem } from "./fs.ts";
import { DECLARATIONS, SyntaxError as ParseError, ansiEscape, parse, type Assign, type Command, type Part, type Pipeline, type Redirect, type Script, type Word, type AndOr } from "./syntax.ts";
import { ArithError, evaluateArith } from "./arith.ts";
import { escapeRegExp, globRegExp, globSource, hasGlob, posixRegExp } from "./text.ts";
import { TestError, evaluateTest, type TestArg } from "./test.ts";

export type Limits = {
  maxCommands: number;
  maxLoopIterations: number;
  maxCallDepth: number;
  maxOutputLength: number;
  maxBufferLength: number;
  maxFileOperations: number;
  timeoutMs: number;
};

export class LimitError extends Error {
  readonly status: number;
  constructor(message: string, status = 126) {
    super(message);
    this.status = status;
  }
}

export class CommandError extends Error {
  readonly status: number;
  constructor(message: string, status = 1) {
    super(message);
    this.status = status;
  }
}

class FatalError extends Error {
  reported = false;
  readonly status: number;
  constructor(message: string, status = 1) {
    super(message);
    this.status = status;
  }
}

export class ExitSignal {
  readonly status: number;
  constructor(status: number) {
    this.status = status;
  }
}

class ReturnSignal {
  readonly status: number;
  constructor(status: number) {
    this.status = status;
  }
}

class LoopSignal {
  readonly kind: "break" | "continue";
  readonly levels: number;
  constructor(kind: "break" | "continue", levels: number) {
    this.kind = kind;
    this.levels = levels;
  }
}

export class Output {
  #chunks: string[] = [];
  length = 0;
  truncated = false;
  readonly limit: number;
  readonly strict: boolean;
  readonly discard: boolean;

  constructor(limit: number, strict = true, discard = false) {
    this.limit = limit;
    this.strict = strict;
    this.discard = discard;
  }

  write(text: string) {
    if (!text || this.discard) return;
    if (this.length + text.length > this.limit) {
      if (this.strict) throw new LimitError(`output exceeded ${this.limit} characters`);
      text = text.slice(0, this.limit - this.length);
      this.truncated = true;
      if (!text) return;
    }
    this.#chunks.push(text);
    this.length += text.length;
  }

  text(): string {
    if (this.#chunks.length > 1) this.#chunks = [this.#chunks.join("")];
    return rejoin(this.#chunks[0] ?? "");
  }
}

export class Input {
  #text: string;
  #pos = 0;

  constructor(text = "") {
    this.#text = text;
  }

  read(): string {
    const rest = this.#text.slice(this.#pos);
    this.#pos = this.#text.length;
    return rest;
  }

  line(delimiter = "\n"): { text: string; complete: boolean } | null {
    if (this.#pos >= this.#text.length) return null;
    const end = delimiter === "" ? this.#text.indexOf("\0", this.#pos) : this.#text.indexOf(delimiter, this.#pos);
    if (end < 0) return { text: this.read(), complete: false };
    const text = this.#text.slice(this.#pos, end);
    this.#pos = end + Math.max(1, delimiter.length);
    return { text, complete: true };
  }

  chars(count: number): string {
    const text = this.#text.slice(this.#pos, this.#pos + count);
    this.#pos += text.length;
    return text;
  }
}

export type IO = { stdin: Input; stdout: Output; stderr: Output };

export type CommandContext = {
  name: string;
  args: string[];
  stdin: Input;
  stdout: Output;
  stderr: Output;
  cwd: string;
  env: Record<string, string>;
  fs: FileSystem;
  fetch?: typeof fetch;
  signal: AbortSignal;
  limits: Limits;
  resolve(path: string): string;
  run(argv: string[], stdin?: string): Promise<number>;
  exec(script: string, stdin?: string): Promise<{ status: number; stdout: string }>;
  sleep(ms: number): Promise<void>;
};

export type CommandHandler = (context: CommandContext) => Promise<number | void> | number | void;

export type ShellHost = { fs: FileSystem; commands: Map<string, CommandHandler>; fetch?: typeof fetch; limits: Limits };

type Frame = Map<string, { value?: string[]; exported: boolean }>;

export class State {
  vars = new Map<string, string[]>();
  exported = new Set<string>();
  integers = new Set<string>();
  functions = new Map<string, Command>();
  frames: Frame[] = [];
  maps = new Map<string, Map<string, string>>();
  readonly = new Set<string>();
  jobs = new Map<string, number>();
  cases = new Map<string, "l" | "u">();
  stack: string[] = [];
  traps = new Map<string, string>();
  shopt = new Set<string>();
  positional: string[] = [];
  arg0 = "bash";
  optind = 1;
  optpos = 1;
  cwd = "/";
  status = 0;
  options = { errexit: false, nounset: false, pipefail: false, xtrace: false, noglob: false };

  clone(): State {
    const state = new State();
    for (const [name, value] of this.vars) state.vars.set(name, value.slice());
    for (const [name, map] of this.maps) state.maps.set(name, new Map(map));
    state.readonly = new Set(this.readonly);
    state.cases = new Map(this.cases);
    state.stack = [...this.stack];
    state.shopt = new Set(this.shopt);
    state.arg0 = this.arg0;
    state.optind = this.optind;
    state.optpos = this.optpos;
    state.exported = new Set(this.exported);
    state.integers = new Set(this.integers);
    state.functions = new Map(this.functions);
    state.positional = [...this.positional];
    state.cwd = this.cwd;
    state.status = this.status;
    state.options = { ...this.options };
    return state;
  }
}

type Piece = { text: string; quoted: boolean; split: boolean } | { split: "break" };

const BRACE_LIMIT = 100_000;

function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, "\\$&");
}

function message(error: unknown): string {
  if (error instanceof FsError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

type Item = { c: string } | { p: Part };

function braces(items: Item[], count: { n: number }): Item[][] {
  for (let i = 0; i < items.length; i++) {
    const open = items[i];
    if (!("c" in open) || open.c !== "{") continue;
    let depth = 0;
    let end = -1;
    const commas: number[] = [];
    for (let j = i; j < items.length; j++) {
      const item = items[j];
      if (!("c" in item)) continue;
      if (item.c === "{") depth++;
      else if (item.c === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      } else if (item.c === "," && depth === 1) commas.push(j);
    }
    if (end < 0) return [items];
    const prefix = items.slice(0, i);
    const suffix = items.slice(end + 1);
    let alternatives: Item[][] | undefined;
    if (commas.length) {
      const bounds = [i, ...commas, end];
      alternatives = bounds.slice(1).map((bound, k) => items.slice(bounds[k] + 1, bound));
    } else {
      const inner = items.slice(i + 1, end);
      if (inner.every(item => "c" in item)) {
        const text = inner.map(item => (item as { c: string }).c).join("");
        const numeric = text.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
        const letters = text.match(/^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/);
        if (numeric || letters) {
          const values: string[] = [];
          if (numeric) {
            const [from, to] = [Number(numeric[1]), Number(numeric[2])];
            const step = Math.abs(Number(numeric[3] ?? 1)) || 1;
            const width = /^-?0\d/.test(numeric[1]) || /^-?0\d/.test(numeric[2]) ? Math.max(numeric[1].length, numeric[2].length) : 0;
            for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) {
              values.push(width ? (n < 0 ? "-" + String(-n).padStart(width - 1, "0") : String(n).padStart(width, "0")) : String(n));
              if (values.length > BRACE_LIMIT) throw new LimitError("brace expansion too large");
            }
          } else {
            const [from, to] = [letters![1].charCodeAt(0), letters![2].charCodeAt(0)];
            const step = Math.abs(Number(letters![3] ?? 1)) || 1;
            for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) values.push(String.fromCharCode(n));
          }
          alternatives = values.map(value => [...value].map(c => ({ c })));
        }
      }
    }
    if (!alternatives) continue;
    const result: Item[][] = [];
    for (const alternative of alternatives) {
      for (const expanded of braces([...prefix, ...alternative, ...suffix], count)) {
        if (++count.n > BRACE_LIMIT) throw new LimitError("brace expansion too large");
        result.push(expanded);
      }
    }
    return result;
  }
  return [items];
}

function braceExpand(word: Word): Word[] {
  if (!word.some(part => part.type === "text" && !part.quoted && part.value.includes("{"))) return [word];
  const items: Item[] = [];
  for (const part of word) {
    if (part.type === "text" && !part.quoted) for (const c of part.value) items.push({ c });
    else items.push({ p: part });
  }
  const expanded = braces(items, { n: 0 });
  if (expanded.length === 1 && expanded[0] === items) return [word];
  return expanded.map(list => {
    const parts: Part[] = [];
    for (const item of list) {
      const last = parts[parts.length - 1];
      if ("c" in item) {
        if (last?.type === "text" && !last.quoted) last.value += item.c;
        else parts.push({ type: "text", value: item.c, quoted: false });
      } else parts.push(item.p);
    }
    return parts;
  });
}

export class Runner {
  state: State;
  readonly host: ShellHost;
  readonly signal: AbortSignal;
  failure: "syntax" | "limit" | undefined;
  temporaries: string[] = [];
  flushes: (() => Promise<void>)[] = [];
  #deferred: { path: string; body: Script }[] = [];
  #processes = 0;
  #ignored = false;
  #started = Date.now();
  #steps = 0;
  #depth = 0;
  #condition = 0;
  #substitution: number | undefined;

  constructor(host: ShellHost, state: State, signal: AbortSignal) {
    this.host = host;
    this.state = state;
    this.signal = signal;
  }

  check() {
    if (this.signal.aborted) throw new LimitError(typeof this.signal.reason === "string" ? this.signal.reason : "execution aborted", 124);
    if (++this.#steps > this.host.limits.maxCommands) throw new LimitError(`too many commands (limit ${this.host.limits.maxCommands})`);
  }

  enter() {
    if (++this.#depth > this.host.limits.maxCallDepth) {
      this.#depth--;
      throw new LimitError(`maximum call depth exceeded (limit ${this.host.limits.maxCallDepth})`);
    }
  }

  leave() {
    this.#depth--;
  }

  buffer(): Output {
    return new Output(this.host.limits.maxBufferLength);
  }

  resolve(path: string): string {
    return resolvePath(this.state.cwd, path);
  }

  get(name: string): string | undefined {
    return this.state.vars.get(name)?.[0];
  }

  set(name: string, value: string | string[]) {
    if (this.state.readonly.has(name)) throw new FatalError(name + ": readonly variable");
    this.state.vars.set(name, typeof value === "string" ? [value] : value);
  }

  async exitTrap(io: IO, status: number): Promise<number> {
    const action = this.state.traps.get("EXIT");
    if (action === undefined) return status;
    this.state.traps.delete("EXIT");
    this.state.status = status;
    try {
      await this.script(parse(action), io);
    } catch (error) {
      if (error instanceof ExitSignal) return error.status;
      if (!(error instanceof ReturnSignal || error instanceof LoopSignal || error instanceof ParseError)) throw error;
    }
    return status;
  }

  async cleanup() {
    for (const flush of this.flushes.splice(0)) await flush();
    for (const path of this.temporaries.splice(0)) await this.host.fs.remove(path).catch(() => undefined);
  }

  environment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this.state.exported) {
      const value = this.state.vars.get(name);
      if (value) env[name] = value[0] ?? "";
    }
    return env;
  }

  async script(script: Script, io: IO): Promise<number> {
    let status = this.state.status;
    for (const item of script) {
      if (item.background) {
        const job = String(this.state.jobs.size + 1000);
        this.state.jobs.set(job, await this.subshell(() => this.andOr(item, io)));
        this.state.vars.set("!", [job]);
        status = this.state.status = 0;
      } else status = await this.andOr(item, io);
    }
    return status;
  }

  async andOr(item: AndOr, io: IO): Promise<number> {
    let status = await this.guarded(item.first, io, item.rest.length > 0);
    for (let i = 0; i < item.rest.length; i++) {
      const { op, pipeline } = item.rest[i];
      if ((op === "&&") === (status === 0)) status = await this.guarded(pipeline, io, i < item.rest.length - 1);
    }
    return status;
  }

  async guarded(pipeline: Pipeline, io: IO, guarded: boolean): Promise<number> {
    if (guarded) this.#condition++;
    let status: number;
    try {
      status = await this.pipeline(pipeline, io);
    } finally {
      if (guarded) this.#condition--;
    }
    this.state.status = status;
    if (guarded || this.#condition > 0) {
      this.#ignored = status !== 0;
      return status;
    }
    const compound = pipeline.commands.length === 1 && pipeline.commands[0].type !== "simple" && !(pipeline.commands[0].type === "group" && pipeline.commands[0].subshell);
    if (compound && this.#ignored && status !== 0) return status;
    this.#ignored = false;
    if (status !== 0 && !pipeline.negate) {
      const trap = this.state.traps.get("ERR");
      if (trap) {
        this.state.traps.delete("ERR");
        try {
          await this.script(parse(trap), io);
        } finally {
          this.state.traps.set("ERR", trap);
          this.state.status = status;
        }
      }
      if (this.state.options.errexit) throw new ExitSignal(status);
    }
    return status;
  }

  async condition(script: Script, io: IO): Promise<number> {
    this.#condition++;
    try {
      return await this.script(script, io);
    } finally {
      this.#condition--;
    }
  }

  async subshell(run: () => Promise<number>, io?: IO): Promise<number> {
    const saved = this.state;
    this.state = saved.clone();
    try {
      let status: number;
      try {
        status = await run();
      } catch (error) {
        if (error instanceof ExitSignal || error instanceof ReturnSignal) status = error.status;
        else throw error;
      }
      return io && this.state.traps.has("EXIT") ? await this.exitTrap(io, status) : status;
    } finally {
      this.state = saved;
    }
  }

  async pipeline(pipeline: Pipeline, io: IO): Promise<number> {
    let status: number;
    if (pipeline.commands.length === 1) {
      status = await this.command(pipeline.commands[0], io);
      this.state.vars.set("PIPESTATUS", [String(status)]);
    } else {
      let input = io.stdin;
      const statuses: number[] = [];
      for (let i = 0; i < pipeline.commands.length; i++) {
        const last = i === pipeline.commands.length - 1;
        const stdout = last ? io.stdout : this.buffer();
        const stage = { stdin: input, stdout, stderr: io.stderr };
        statuses.push(await this.subshell(() => this.command(pipeline.commands[i], stage)));
        if (!last) input = new Input(stdout.text());
      }
      status = statuses[statuses.length - 1];
      this.state.vars.set("PIPESTATUS", statuses.map(String));
      if (this.state.options.pipefail) status = [...statuses].reverse().find(code => code !== 0) ?? 0;
    }
    return pipeline.negate ? Number(status === 0) : status;
  }

  async command(command: Command, io: IO): Promise<number> {
    this.check();
    if (command.type === "function") {
      this.state.functions.set(command.name, command.body);
      return 0;
    }
    const mark = this.#deferred.length;
    let redirected: { io: IO; flush(): Promise<void> };
    try {
      redirected = await this.redirect(command.redirects, io);
    } catch (error) {
      if (!(error instanceof FsError || error instanceof CommandError)) throw error;
      io.stderr.write("bash: " + message(error) + "\n");
      return 1;
    }
    const head = command.type === "simple" && command.words.length === 1 ? command.words[0] : undefined;
    if (Array.isArray(head) && head.length === 1 && head[0].type === "text" && !head[0].quoted && head[0].value === "exec" && command.redirects.length) {
      Object.assign(io, redirected.io);
      this.flushes.push(redirected.flush);
      return 0;
    }
    try {
      return await this.compound(command, redirected.io);
    } catch (error) {
      if (error instanceof FatalError && !error.reported && command.redirects.length) {
        redirected.io.stderr.write("bash: " + error.message + "\n");
        error.reported = true;
      }
      throw error;
    } finally {
      await redirected.flush();
      for (const { path, body } of this.#deferred.splice(mark)) {
        const text = decode(await this.host.fs.read(path).catch(() => new Uint8Array(0)));
        await this.subshell(() => this.script(body, { stdin: new Input(text), stdout: io.stdout, stderr: io.stderr }));
      }
    }
  }

  async processPath(part: Part & { type: "process" }, io: IO): Promise<string> {
    for (const dir of ["/dev", "/dev/fd"]) if (!(await this.host.fs.stat(dir))) await this.host.fs.mkdir(dir);
    const path = "/dev/fd/" + (63 - (this.#processes++ % 54));
    this.temporaries.push(path);
    if (part.output) {
      await this.host.fs.write(path, new Uint8Array(0));
      this.#deferred.push({ path, body: part.body });
      return path;
    }
    this.enter();
    const out = this.buffer();
    try {
      await this.subshell(() => this.script(part.body, { stdin: io.stdin, stdout: out, stderr: io.stderr }));
    } finally {
      this.leave();
    }
    await this.host.fs.write(path, encode(out.text()));
    return path;
  }

  async compound(command: Command, io: IO): Promise<number> {
    switch (command.type) {
      case "simple":
        return this.simple(command, io);
      case "if": {
        for (const clause of command.clauses) {
          if ((await this.condition(clause.cond, io)) === 0) return this.script(clause.body, io);
        }
        return command.otherwise ? this.script(command.otherwise, io) : 0;
      }
      case "while": {
        let status = 0;
        for (let iteration = 1; ; iteration++) {
          this.iteration(iteration);
          const cond = await this.condition(command.cond, io);
          if ((cond === 0) === command.until) break;
          const signal = await this.body(command.body, io);
          if (typeof signal === "number") status = signal;
          else if (signal === "break") break;
        }
        return status;
      }
      case "for": {
        let values: string[] = [];
        if (command.items) for (const item of command.items) values.push(...(await this.fields(item, io)));
        else values = [...this.state.positional];
        let status = 0;
        for (let i = 0; i < values.length; i++) {
          this.iteration(i + 1);
          this.set(command.name, values[i]);
          const signal = await this.body(command.body, io);
          if (typeof signal === "number") status = signal;
          else if (signal === "break") break;
        }
        return status;
      }
      case "cfor": {
        let status = 0;
        await this.arith(command.init, io);
        for (let iteration = 1; ; iteration++) {
          this.iteration(iteration);
          if (command.cond.length && (await this.arith(command.cond, io)) === 0) break;
          const signal = await this.body(command.body, io);
          if (typeof signal === "number") status = signal;
          else if (signal === "break") break;
          await this.arith(command.step, io);
        }
        return status;
      }
      case "case": {
        const value = await this.string(command.word, io);
        let status = 0;
        let falling = false;
        for (const item of command.items) {
          let matched = falling;
          if (!matched) {
            for (const pattern of item.patterns) {
              if (globRegExp(await this.pattern(pattern, io)).test(value)) {
                matched = true;
                break;
              }
            }
          }
          if (!matched) continue;
          status = await this.script(item.body, io);
          if (item.next === "break") return status;
          falling = item.next === "fall";
        }
        return status;
      }
      case "group": {
        if (!command.subshell) return this.script(command.body, io);
        const inner = { ...io };
        return this.subshell(() => this.script(command.body, inner), inner);
      }
      case "arith":
        try {
          return (await this.arith(command.expr, io)) !== 0 ? 0 : 1;
        } catch (error) {
          if (!(error instanceof ArithError)) throw error;
          io.stderr.write("bash: " + error.message + "\n");
          return 1;
        }
      case "test": {
        const args: TestArg[] = [];
        for (const token of command.tokens) {
          if ("op" in token) args.push({ text: token.op, op: true });
          else {
            const pieces = await this.pieces(token.word, io);
            args.push({ text: joinPieces(pieces, "text"), pattern: joinPieces(pieces, "pattern"), regex: joinPieces(pieces, "regex") });
          }
        }
        return this.test(args, true, io);
      }
    }
    return 0;
  }

  iteration(count: number) {
    if (count > this.host.limits.maxLoopIterations) throw new LimitError(`too many loop iterations (limit ${this.host.limits.maxLoopIterations})`);
  }

  async body(script: Script, io: IO): Promise<number | "break" | "continue"> {
    try {
      return await this.script(script, io);
    } catch (error) {
      if (!(error instanceof LoopSignal)) throw error;
      if (error.levels > 1) throw new LoopSignal(error.kind, error.levels - 1);
      return error.kind;
    }
  }

  async test(args: TestArg[], double: boolean, io: IO): Promise<number> {
    try {
      const result = await evaluateTest(args, double, {
        stat: path => this.host.fs.stat(this.resolve(path)),
        isSet: name => {
          const element = name.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/);
          if (!element) return this.state.vars.has(name) || this.state.maps.has(name);
          const map = this.state.maps.get(element[1]);
          if (map) return map.has(element[2]);
          return this.state.vars.get(element[1])?.[Number(element[2])] !== undefined;
        },
        match: (text, pattern) => globRegExp(pattern).test(text),
        regex: (text, source) => {
          const match = text.match(posixRegExp(source, true));
          this.set("BASH_REMATCH", match ? [...match].map(group => group ?? "") : []);
          return match !== null;
        },
      });
      return result ? 0 : 1;
    } catch (error) {
      if (!(error instanceof TestError || error instanceof globalThis.SyntaxError)) throw error;
      io.stderr.write((double ? "bash: " : "bash: test: ") + error.message + "\n");
      return 2;
    }
  }

  async arith(word: Word, io: IO): Promise<number> {
    const source = await this.string(word, io);
    return evaluateArith(source, {
      get: (name, index) => {
        const value = this.state.vars.get(name);
        if (value === undefined && this.state.options.nounset) throw new FatalError(name + ": unbound variable");
        return value?.[index ?? 0] ?? "";
      },
      set: (name, value, index) => {
        if (index === undefined) this.set(name, String(value));
        else {
          const array = (this.state.vars.get(name) ?? []).slice();
          array[index < 0 ? array.length + index : index] = String(value);
          this.set(name, array);
        }
      },
    });
  }

  async simple(command: Command & { type: "simple" }, io: IO): Promise<number> {
    this.#substitution = undefined;
    if (command.line !== undefined) this.state.vars.set("LINENO", [String(command.line)]);
    const head = command.words[0];
    if (head && Array.isArray(head) && head.length === 1 && head[0].type === "text" && !head[0].quoted && DECLARATIONS.has(head[0].value) && !this.state.functions.has(head[0].value)) {
      return this.declare(head[0].value, command.words.slice(1), io);
    }
    const argv: string[] = [];
    for (const word of command.words) if (Array.isArray(word)) argv.push(...(await this.fields(word, io)));
    if (!argv.length) {
      for (const assign of command.assigns) await this.assign(assign, io);
      return this.#substitution ?? 0;
    }
    const saved: [string, string[] | undefined, boolean][] = [];
    for (const assign of command.assigns) {
      saved.push([assign.name, this.state.vars.get(assign.name), this.state.exported.has(assign.name)]);
      await this.assign(assign, io);
      this.state.exported.add(assign.name);
    }
    try {
      if (this.state.options.xtrace) io.stderr.write("+ " + argv.join(" ") + "\n");
      return await this.dispatch(argv, io);
    } finally {
      for (const [name, value, exported] of saved.reverse()) {
        if (value === undefined) this.state.vars.delete(name);
        else this.state.vars.set(name, value);
        if (!exported) this.state.exported.delete(name);
      }
    }
  }

  async assign(assign: Assign, io: IO) {
    const { name } = assign;
    const map = this.state.maps.get(name);
    if (assign.items) {
      if (this.state.readonly.has(name)) throw new FatalError(name + ": readonly variable");
      if (map) {
        if (!assign.append) map.clear();
        for (let i = 0; i < assign.items.length; i++) {
          const key = assign.keys?.[i];
          if (key) map.set(await this.string(key, io), await this.string(assign.items[i], io));
          else {
            const value = await this.string(assign.items[i], io);
            const next = assign.items[++i];
            map.set(value, next ? await this.string(next, io) : "");
          }
        }
        return;
      }
      const array = assign.append ? (this.state.vars.get(name) ?? []).slice() : [];
      let position = array.length;
      for (let i = 0; i < assign.items.length; i++) {
        const key = assign.keys?.[i];
        if (key) {
          position = await this.arith(key, io);
          array[position++] = await this.string(assign.items[i], io);
        } else for (const value of await this.fields(assign.items[i], io)) array[position++] = value;
      }
      this.set(name, array);
      return;
    }
    let value = assign.value ? await this.string(assign.value, io) : "";
    if (map) {
      if (this.state.readonly.has(name)) throw new FatalError(name + ": readonly variable");
      const key = assign.index ? await this.string(assign.index, io) : "0";
      map.set(key, assign.append ? (map.get(key) ?? "") + value : value);
      return;
    }
    const letter = this.state.cases.get(name);
    if (letter) value = letter === "l" ? value.toLowerCase() : value.toUpperCase();
    if (this.state.integers.has(name)) {
      const number = await this.arith([{ type: "text", value: value || "0", quoted: true }], io);
      value = String(assign.append ? Number(this.get(name) ?? 0) + number : number);
      this.set(name, value);
      return;
    }
    if (assign.index) {
      const array = (this.state.vars.get(name) ?? []).slice();
      const index = await this.arith(assign.index, io);
      const position = index < 0 ? array.length + index : index;
      array[position] = assign.append ? (array[position] ?? "") + value : value;
      this.set(name, array);
      return;
    }
    if (assign.append) {
      const current = this.state.vars.get(name);
      this.set(name, current && current.length > 1 ? [...current, value] : (current?.[0] ?? "") + value);
    } else this.set(name, value);
  }

  local(name: string) {
    const frame = this.state.frames[this.state.frames.length - 1];
    if (!frame || frame.has(name)) return;
    frame.set(name, { value: this.state.vars.get(name), exported: this.state.exported.has(name) });
  }

  async declare(builtin: string, items: (Word | Assign)[], io: IO): Promise<number> {
    const flags = new Set<string>();
    const targets: (Assign | string)[] = [];
    for (const item of items) {
      if (!Array.isArray(item)) {
        targets.push(item);
        continue;
      }
      for (const field of await this.fields(item, io)) {
        if (/^[-+][a-zA-Z]+$/.test(field) && !targets.length) for (const flag of field.slice(1)) flags.add(field[0] === "+" ? "+" + flag : flag);
        else targets.push(field);
      }
    }
    if (builtin === "local" && !this.state.frames.length) {
      io.stderr.write("bash: local: can only be used in a function\n");
      return 1;
    }
    const exporting = builtin === "export" || flags.has("x");
    const scoped = builtin === "local" || ((builtin === "declare" || builtin === "typeset") && !flags.has("g") && this.state.frames.length > 0);
    if (!targets.length || flags.has("p")) {
      if (flags.has("f") || flags.has("F")) {
        for (const name of [...this.state.functions.keys()].sort()) io.stdout.write("declare -f " + name + "\n");
        return 0;
      }
      const names = targets.length ? targets.map(target => (typeof target === "string" ? target : target.name)) : [...this.state.vars.keys(), ...this.state.maps.keys()].sort();
      for (const name of names) {
        const map = this.state.maps.get(name);
        if (map) {
          io.stdout.write("declare -A " + name + "=(" + [...map].map(([key, value]) => "[" + key + "]=" + JSON.stringify(value) + " ").join("") + ")\n");
          continue;
        }
        if (exporting && !targets.length && !this.state.exported.has(name)) continue;
        const value = this.state.vars.get(name);
        if (!value) continue;
        const flag = (value.length > 1 ? "a" : "") + (this.state.exported.has(name) ? "x" : "");
        const body = value.length > 1 ? "(" + value.map((item, index) => "[" + index + "]=" + JSON.stringify(item)).join(" ") + ")" : JSON.stringify(value[0] ?? "");
        io.stdout.write("declare -" + (flag || "-") + " " + name + "=" + body + "\n");
      }
      return 0;
    }
    let status = 0;
    for (const target of targets) {
      let assign: Assign | undefined;
      let name: string;
      if (typeof target === "string") {
        const eq = target.indexOf("=");
        name = eq < 0 ? target : target.slice(0, eq);
        if (eq >= 0) assign = { name, value: [{ type: "text", value: target.slice(eq + 1), quoted: true }], append: false };
      } else {
        assign = target;
        name = target.name;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        io.stderr.write("bash: " + builtin + ": `" + name + "': not a valid identifier\n");
        status = 1;
        continue;
      }
      if (scoped) this.local(name);
      if (flags.has("i")) this.state.integers.add(name);
      if (flags.has("l") || flags.has("u")) this.state.cases.set(name, flags.has("l") ? "l" : "u");
      if (flags.has("A") && !this.state.maps.has(name)) {
        this.state.maps.set(name, new Map());
        this.state.vars.delete(name);
      }
      if (flags.has("f")) {
        if (!this.state.functions.has(name)) status = 1;
        continue;
      }
      if (assign) await this.assign(assign, io);
      else if (scoped && builtin === "local") this.state.vars.delete(name);
      else if (flags.has("a") && !this.state.vars.has(name)) this.set(name, []);
      if (exporting) this.state.exported.add(name);
      if (flags.has("+x") || flags.has("n")) this.state.exported.delete(name);
      if (builtin === "readonly" || flags.has("r")) this.state.readonly.add(name);
    }
    return status;
  }

  async dispatch(argv: string[], io: IO, functions = true): Promise<number> {
    const [name, ...args] = argv;
    const fn = functions ? this.state.functions.get(name) : undefined;
    if (fn) return this.call(fn, args, io, name);
    const builtin = BUILTINS[name];
    if (builtin) {
      try {
        return await builtin.call(this, args, io);
      } catch (error) {
        if (error instanceof CommandError || error instanceof FsError || error instanceof ArithError) {
          io.stderr.write("bash: " + name + ": " + message(error) + "\n");
          return error instanceof CommandError ? error.status : 1;
        }
        throw error;
      }
    }
    const handler = this.host.commands.get(name);
    if (handler) return this.external(name, handler, args, io);
    if (name.includes("/")) {
      const path = this.resolve(name);
      const stat = await this.host.fs.stat(path);
      if (stat?.kind === "file") {
        const wasm = this.host.commands.get("wasm");
        if (wasm && stat.size >= 8) {
          const head = await this.host.fs.read(path);
          if (head[0] === 0 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d) return this.external(name, wasm, [name, ...args], io);
        }
        return this.source(path, args, io, true, name);
      }
      io.stderr.write("bash: " + name + ": " + (stat ? "Is a directory" : "No such file or directory") + "\n");
      return stat ? 126 : 127;
    }
    io.stderr.write("bash: " + name + ": command not found\n");
    return 127;
  }

  async external(name: string, handler: CommandHandler, args: string[], io: IO): Promise<number> {
    const cwd = this.state.cwd;
    const context: CommandContext = {
      name,
      args,
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      cwd,
      env: this.environment(),
      fs: this.host.fs,
      fetch: this.host.fetch,
      signal: this.signal,
      limits: this.host.limits,
      resolve: path => resolvePath(cwd, path),
      run: async (argv, stdin) => {
        this.check();
        return this.dispatch(argv, { stdin: stdin === undefined ? io.stdin : new Input(stdin), stdout: io.stdout, stderr: io.stderr });
      },
      exec: async (script, stdin) => {
        this.check();
        const stdout = this.buffer();
        let parsed: Script;
        try {
          parsed = parse(script);
        } catch (error) {
          if (!(error instanceof ParseError)) throw error;
          io.stderr.write("bash: " + error.message + "\n");
          return { status: 2, stdout: "" };
        }
        this.enter();
        try {
          const status = await this.subshell(() => this.script(parsed, { stdin: new Input(stdin ?? ""), stdout, stderr: io.stderr }));
          return { status, stdout: stdout.text() };
        } finally {
          this.leave();
        }
      },
      sleep: ms => this.sleep(ms),
    };
    try {
      return (await handler(context)) ?? 0;
    } catch (error) {
      if (error instanceof LimitError || error instanceof ExitSignal || error instanceof FatalError) throw error;
      if (this.signal.aborted) throw new LimitError(typeof this.signal.reason === "string" ? this.signal.reason : "execution aborted", 124);
      io.stderr.write(name + ": " + message(error) + "\n");
      return error instanceof CommandError ? error.status : 1;
    }
  }

  async sleep(ms: number) {
    if (ms > 0) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, ms);
        this.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    this.check();
  }

  async call(body: Command, args: string[], io: IO, name: string): Promise<number> {
    this.enter();
    const positional = this.state.positional;
    const frame: Frame = new Map();
    const names = this.state.vars.get("FUNCNAME");
    this.state.vars.set("FUNCNAME", [name, ...(names ?? [])]);
    this.state.positional = args;
    this.state.frames.push(frame);
    try {
      return await this.command(body, io);
    } catch (error) {
      if (error instanceof ReturnSignal) return error.status;
      throw error;
    } finally {
      this.state.frames.pop();
      for (const [name, saved] of frame) {
        if (saved.value === undefined) this.state.vars.delete(name);
        else this.state.vars.set(name, saved.value);
        if (saved.exported) this.state.exported.add(name);
        else this.state.exported.delete(name);
      }
      this.state.positional = positional;
      if (names) this.state.vars.set("FUNCNAME", names);
      else this.state.vars.delete("FUNCNAME");
      this.leave();
    }
  }

  async source(path: string, args: string[], io: IO, isolated: boolean, arg0?: string): Promise<number> {
    const text = decode(await this.host.fs.read(path));
    let script: Script;
    try {
      script = parse(text);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      io.stderr.write("bash: " + path + ": " + error.message + "\n");
      return 2;
    }
    const run = async () => {
      this.enter();
      const positional = this.state.positional;
      if (args.length || isolated) this.state.positional = args;
      if (arg0 !== undefined) this.state.arg0 = arg0;
      try {
        return await this.script(script, io);
      } catch (error) {
        if (error instanceof ReturnSignal) return error.status;
        throw error;
      } finally {
        if (!isolated) this.state.positional = positional;
        this.leave();
      }
    };
    return isolated ? this.subshell(run) : run();
  }

  async redirect(redirects: Redirect[], io: IO): Promise<{ io: IO; flush(): Promise<void> }> {
    if (!redirects.length) return { io, flush: async () => undefined };
    const fds: [Input, Output, Output] = [io.stdin, io.stdout, io.stderr];
    const writes: { path: string; out: Output }[] = [];
    const open = async (target: string, append: boolean): Promise<Output> => {
      if (target === "/dev/null") return new Output(0, false, true);
      if (target === "/dev/stdout") return io.stdout;
      if (target === "/dev/stderr") return io.stderr;
      if (target === "") throw new CommandError("ambiguous redirect");
      const path = this.resolve(target);
      const stat = await this.host.fs.stat(path);
      if (stat?.kind === "directory") throw new FsError("EISDIR", target);
      if (!append || !stat) await this.host.fs.write(path, new Uint8Array(0));
      const out = this.buffer();
      writes.push({ path, out });
      return out;
    };
    const flush = async () => {
      for (const { path, out } of writes) if (out.length) await this.host.fs.write(path, encode(out.text()), true);
    };
    try {
      for (const redirect of redirects) {
        const op = redirect.op;
        if (op === "<<" || op === "<<-" || op === "<<<") {
          const text = op !== "<<<" ? await this.string(redirect.body ?? [], io) : (await this.string(redirect.target, io)) + "\n";
          if ((redirect.fd ?? 0) === 0) fds[0] = new Input(text);
          continue;
        }
        const target = await this.string(redirect.target, io);
        if (op === "<" || op === "<>") {
          if ((redirect.fd ?? 0) !== 0) continue;
          if (target === "/dev/null") fds[0] = new Input("");
          else if (target !== "/dev/stdin") fds[0] = new Input(decode(await this.host.fs.read(this.resolve(target))));
          continue;
        }
        if ((op === ">&" || op === "<&") && /^\d+-?$/.test(target)) {
          const fd = redirect.fd ?? (op === ">&" ? 1 : 0);
          const from = Number(target.replace("-", ""));
          if (fd === 1 || fd === 2) {
            if (from === 1 || from === 2) fds[fd] = fds[from] as Output;
          } else if (fd === 0 && from === 0) fds[0] = io.stdin;
          continue;
        }
        if ((op === ">&" || op === "<&") && target === "-") {
          const fd = redirect.fd ?? (op === ">&" ? 1 : 0);
          if (fd === 1 || fd === 2) fds[fd] = new Output(0, false, true);
          else if (fd === 0) fds[0] = new Input("");
          continue;
        }
        if (op === "&>" || op === "&>>" || (op === ">&" && redirect.fd === null)) {
          const out = await open(target, op === "&>>");
          fds[1] = out;
          fds[2] = out;
          continue;
        }
        const fd = redirect.fd ?? 1;
        const out = await open(target, op === ">>");
        if (fd === 1 || fd === 2) fds[fd] = out;
      }
    } catch (error) {
      await flush();
      throw error;
    }
    return { io: { stdin: fds[0], stdout: fds[1], stderr: fds[2] }, flush };
  }

  async substitute(body: Script, io: IO): Promise<string> {
    const only = body.length === 1 && !body[0].rest.length && body[0].first.commands.length === 1 ? body[0].first.commands[0] : undefined;
    if (only?.type === "simple" && !only.words.length && !only.assigns.length && only.redirects.length === 1 && only.redirects[0].op === "<") {
      const target = await this.string(only.redirects[0].target, io);
      try {
        const text = decode(await this.host.fs.read(this.resolve(target)));
        this.#substitution = 0;
        return text.replace(/\n+$/, "");
      } catch (error) {
        io.stderr.write("bash: " + message(error) + "\n");
        this.#substitution = 1;
        return "";
      }
    }
    this.enter();
    const out = this.buffer();
    try {
      const status = await this.subshell(() => this.script(body, { stdin: io.stdin, stdout: out, stderr: io.stderr }));
      this.#substitution = status;
      this.state.status = status;
    } finally {
      this.leave();
    }
    return out.text().replace(/\n+$/, "");
  }

  special(name: string): string[] | undefined {
    const state = this.state;
    switch (name) {
      case "?":
        return [String(state.status)];
      case "#":
        return [String(state.positional.length)];
      case "$":
        return ["1"];
      case "!":
        return state.vars.get("!") ?? [""];
      case "0":
        return [state.arg0];
      case "-":
        return [(state.options.errexit ? "e" : "") + (state.options.nounset ? "u" : "") + (state.options.xtrace ? "x" : "") + "hBc"];
      case "RANDOM":
        return [String(Math.floor(Math.random() * 32768))];
      case "SECONDS":
        return state.vars.get(name) ?? [String(Math.floor((Date.now() - this.#started) / 1000))];
      case "EPOCHSECONDS":
        return [String(Math.floor(Date.now() / 1000))];
      case "EPOCHREALTIME":
        return [(Date.now() / 1000).toFixed(6)];
      case "BASHPID":
        return ["1"];
      case "SRANDOM":
        return [String(Math.floor(Math.random() * 4294967296))];
    }
    if (/^\d+$/.test(name)) {
      const value = state.positional[Number(name) - 1];
      return value === undefined ? undefined : [value];
    }
    return state.vars.get(name);
  }

  async param(part: Part & { type: "param" }, io: IO): Promise<{ values: string[]; list: boolean; joined: boolean }> {
    let name = part.name;
    if (part.op === "names") {
      const names = [...new Set([...this.state.vars.keys(), ...this.state.maps.keys()])].filter(key => key.startsWith(name)).sort();
      return { values: names, list: true, joined: false };
    }
    if (part.op === "indirect" && part.index) {
      const key = await this.string(part.index, io);
      if (key === "@" || key === "*") {
        const map = this.state.maps.get(name);
        return { values: map ? [...map.keys()] : Object.keys(this.state.vars.get(name) ?? []), list: true, joined: key === "*" };
      }
    }
    if (part.op === "indirect") {
      name = this.special(name)?.[0] ?? "";
      const bracket = name.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/);
      if (bracket) {
        const values = this.state.vars.get(bracket[1]) ?? [];
        if (bracket[2] === "@" || bracket[2] === "*") return { values, list: true, joined: bracket[2] === "*" };
        const index = evaluateArith(bracket[2], { get: n => this.get(n) ?? "", set: () => undefined });
        return { values: [values[index] ?? ""], list: false, joined: false };
      }
    }
    const index = part.index ? await this.string(part.index, io) : undefined;
    const all = name === "@" || name === "*" || index === "@" || index === "*";
    const joined = name === "*" || index === "*";
    let values: string[] | undefined;
    const map = this.state.maps.get(name);
    if (map) {
      if (index === "@" || index === "*") values = [...map.values()];
      else {
        const value = map.get(index ?? "0");
        values = value === undefined ? undefined : [value];
      }
    } else if (name === "@" || name === "*") values = this.state.positional;
    else if (index === "@" || index === "*") values = this.state.vars.get(name)?.filter(() => true);
    else if (index !== undefined) {
      const array = this.state.vars.get(name);
      if (array) {
        let position = await this.arith([{ type: "text", value: index, quoted: true }], io);
        if (position < 0) position += array.length;
        values = array[position] === undefined ? undefined : [array[position]];
      }
    } else {
      const value = this.special(name);
      values = value === undefined ? undefined : [value[0] ?? ""];
    }
    if (part.op === "length") {
      if (all) return { values: [String(values?.length ?? 0)], list: false, joined: false };
      return { values: [String([...(values?.[0] ?? "")].length)], list: false, joined: false };
    }
    const unset = values === undefined;
    const empty = unset || (all ? values!.length === 0 : values![0] === "");
    const op = part.op;
    if (["-", ":-", "=", ":=", "+", ":+", "?", ":?"].includes(op)) {
      const test = op.startsWith(":") ? empty : unset;
      const kind = op.replace(":", "");
      if (kind === "+") return test ? { values: [""], list: false, joined: false } : { values: [await this.string(part.arg ?? [], io)], list: false, joined: false };
      if (!test) return { values: values!, list: all, joined };
      const value = await this.string(part.arg ?? [], io);
      if (kind === "=") this.set(name, value);
      if (kind === "?") throw new FatalError(name + ": " + (value || "parameter null or not set"), 127);
      return { values: [value], list: false, joined: false };
    }
    if (unset) {
      if (this.state.options.nounset && !all && !/^[@*#?$!-]$/.test(name)) throw new FatalError(name + ": unbound variable", 127);
      return { values: all ? [] : [""], list: all, joined };
    }
    let result = values!;
    if (op === "#" || op === "##" || op === "%" || op === "%%") {
      const source = globSource(await this.pattern(part.arg ?? [], io));
      const greedy = op.length === 2;
      const whole = new RegExp("^(?:" + source + ")$");
      result = result.map(value => {
        if (op[0] === "#") {
          for (let n = greedy ? value.length : 0; greedy ? n >= 0 : n <= value.length; n += greedy ? -1 : 1) {
            if (whole.test(value.slice(0, n))) return value.slice(n);
          }
          return value;
        }
        for (let n = greedy ? 0 : value.length; greedy ? n <= value.length : n >= 0; n += greedy ? 1 : -1) {
          if (whole.test(value.slice(n))) return value.slice(0, n);
        }
        return value;
      });
    } else if (op.startsWith("/")) {
      const source = globSource(await this.pattern(part.arg ?? [], io));
      const replacement = part.arg2 ? await this.string(part.arg2, io) : "";
      const anchored = op === "/#" ? "^(?:" + source + ")" : op === "/%" ? "(?:" + source + ")$" : source;
      if (source !== "") {
        const regex = new RegExp(anchored, op === "//" ? "g" : "");
        result = result.map(value => value.replace(regex, () => replacement));
      }
    } else if (op === ":") {
      const offset = await this.arith(part.arg ?? [], io);
      const length = part.arg2 ? await this.arith(part.arg2, io) : undefined;
      const slice = <T,>(items: T[]): T[] => {
        const start = offset < 0 ? Math.max(0, items.length + offset) : offset;
        const end = length === undefined ? items.length : length < 0 ? items.length + length : start + length;
        return items.slice(start, Math.max(start, end));
      };
      if (all) {
        const source = name === "@" || name === "*" ? ["bash", ...result] : result;
        result = slice(source);
      } else result = [slice([...result[0]]).join("")];
    } else if (op === "^^" || op === ",," || op === "^" || op === ",") {
      const source = part.arg?.length ? globSource(await this.pattern(part.arg, io)) : "";
      const allowed = source ? new RegExp("^(?:" + source + ")$") : undefined;
      const convert = (c: string) => (allowed && !allowed.test(c) ? c : op[0] === "^" ? c.toUpperCase() : c.toLowerCase());
      result = result.map(value => (op.length === 2 ? [...value].map(convert).join("") : value ? convert(value.charAt(0)) + value.slice(1) : value));
    }
    else if (op === "@Q" || op === "@K") result = result.map(shellQuote);
    else if (op === "@U") result = result.map(value => value.toUpperCase());
    else if (op === "@u") result = result.map(value => value.charAt(0).toUpperCase() + value.slice(1));
    else if (op === "@L") result = result.map(value => value.toLowerCase());
    else if (op === "@A") result = [name + "=" + shellQuote(result[0] ?? "")];
    else if (op === "@a") result = [(map ? "A" : (this.state.vars.get(name)?.length ?? 0) > 1 ? "a" : "") + (this.state.integers.has(name) ? "i" : "") + (this.state.readonly.has(name) ? "r" : "") + (this.state.exported.has(name) ? "x" : "")];
    else if (op === "@E")
      result = result.map(value => {
        let out = "";
        for (let i = 0; i < value.length; i++) {
          if (value[i] !== "\\") out += value[i];
          else {
            const [text, length] = ansiEscape(value, i + 1);
            out += text;
            i += length;
          }
        }
        return out;
      });
    return { values: result, list: all, joined };
  }

  async pieces(word: Word, io: IO): Promise<Piece[]> {
    const pieces: Piece[] = [];
    for (const part of word) {
      switch (part.type) {
        case "text":
          pieces.push({ text: part.value, quoted: part.quoted, split: false });
          break;
        case "tilde":
          pieces.push({ text: part.user ? "/home/" + part.user : this.get("HOME") ?? "/", quoted: true, split: false });
          break;
        case "param": {
          const { values, list, joined } = await this.param(part, io);
          if (list && part.quoted && !joined) {
            values.forEach((value, index) => {
              if (index) pieces.push({ split: "break" });
              pieces.push({ text: value, quoted: true, split: false });
            });
          } else {
            const separator = joined && part.quoted ? (this.get("IFS") ?? " ").slice(0, 1) : " ";
            pieces.push({ text: values.join(separator), quoted: part.quoted, split: !part.quoted });
          }
          break;
        }
        case "command": {
          const text = await this.substitute(part.body, io);
          pieces.push({ text, quoted: part.quoted, split: !part.quoted });
          break;
        }
        case "arith": {
          const value = await this.arith(part.expr, io);
          pieces.push({ text: String(value), quoted: part.quoted, split: !part.quoted });
          break;
        }
        case "process":
          pieces.push({ text: await this.processPath(part, io), quoted: true, split: false });
          break;
      }
    }
    return pieces;
  }

  async string(word: Word, io: IO): Promise<string> {
    return joinPieces(await this.pieces(word, io), "text");
  }

  async pattern(word: Word, io: IO): Promise<string> {
    return joinPieces(await this.pieces(word, io), "pattern");
  }

  async fields(word: Word, io: IO): Promise<string[]> {
    const out: string[] = [];
    for (const expanded of braceExpand(word)) {
      const pieces = await this.pieces(expanded, io);
      const fields: { text: string; pattern: string; glob: boolean }[] = [];
      let current = { text: "", pattern: "", glob: false, content: false };
      const flush = () => {
        if (current.content) fields.push(current);
        current = { text: "", pattern: "", glob: false, content: false };
      };
      const ifs = this.state.vars.has("IFS") ? this.get("IFS")! : " \t\n";
      const white = [...ifs].filter(c => " \t\n".includes(c)).join("");
      const other = [...ifs].filter(c => !" \t\n".includes(c)).join("");
      const splitter = ifs === "" ? undefined : new RegExp(other ? "[" + escapeRegExp(white) + "]*[" + escapeRegExp(other) + "][" + escapeRegExp(white) + "]*|[" + escapeRegExp(white || " ") + "]+" : "[" + escapeRegExp(white) + "]+");
      for (const piece of pieces) {
        if (piece.split === "break") {
          current.content = true;
          flush();
          continue;
        }
        if (piece.quoted) {
          current.text += piece.text;
          current.pattern += escapeGlob(piece.text);
          current.content = true;
        } else if (!piece.split || !splitter) {
          current.text += piece.text;
          current.pattern += piece.text;
          current.glob ||= hasGlob(piece.text);
          current.content ||= piece.text !== "";
        } else {
          const segments = piece.text.split(splitter);
          segments.forEach((segment, index) => {
            if (index > 0) {
              if (other && index < segments.length) current.content = true;
              flush();
            }
            if (segment !== "") {
              current.text += segment;
              current.pattern += segment;
              current.glob ||= hasGlob(segment);
              current.content = true;
            }
          });
          if (segments.length > 1 && segments[segments.length - 1] === "") current.content = false;
        }
      }
      flush();
      for (const field of fields) {
        if (field.glob && !this.state.options.noglob) {
          const matches = await this.glob(field.pattern);
          if (matches.length) {
            out.push(...matches);
            continue;
          }
          if (this.state.shopt.has("nullglob")) continue;
          if (this.state.shopt.has("failglob")) throw new CommandError("no match: " + field.text);
        }
        out.push(field.text);
      }
    }
    return out;
  }

  async glob(pattern: string): Promise<string[]> {
    const absolute = pattern.startsWith("/");
    const segments = pattern.split("/").filter(Boolean);
    const dot = this.state.shopt.has("dotglob");
    const star = this.state.shopt.has("globstar");
    const join = (base: string, name: string) => (base === "" ? name : base === "/" ? "/" + name : base + "/" + name);
    let paths: string[] = [absolute ? "/" : ""];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const last = i === segments.length - 1;
      const next: string[] = [];
      if (star && segment === "**") {
        const walk = async (base: string) => {
          const dir = this.resolve(base || ".");
          if ((await this.host.fs.stat(dir))?.kind !== "directory") return;
          for (const name of (await this.host.fs.list(dir)).sort()) {
            if (name.startsWith(".") && !dot) continue;
            const path = join(base, name);
            if ((await this.host.fs.stat(this.resolve(path)))?.kind === "directory") {
              next.push(path);
              await walk(path);
            } else if (last) next.push(path);
          }
        };
        for (const base of paths) {
          if (!last) next.push(base);
          await walk(base);
        }
        paths = next;
        if (!paths.length) break;
        continue;
      }
      for (const base of paths) {
        const dir = this.resolve(base || ".");
        if (!hasGlob(segment)) {
          const literal = segment.replace(/\\([\s\S])/g, "$1");
          const path = join(base, literal);
          if (last ? await this.host.fs.stat(this.resolve(path)) : (await this.host.fs.stat(this.resolve(path)))?.kind === "directory") next.push(path);
          continue;
        }
        const stat = await this.host.fs.stat(dir);
        if (stat?.kind !== "directory") continue;
        const regex = new RegExp("^" + globSource(segment, true) + "$");
        const hidden = segment.startsWith(".") || segment.startsWith("\\.");
        for (const name of await this.host.fs.list(dir)) {
          if (name.startsWith(".") && !hidden && !dot) continue;
          if (!regex.test(name)) continue;
          const path = join(base, name);
          if (!last && (await this.host.fs.stat(this.resolve(path)))?.kind !== "directory") continue;
          next.push(path);
        }
      }
      paths = next;
      if (!paths.length) break;
    }
    paths = paths.filter(path => path !== "" && path !== "/");
    if (pattern.endsWith("/")) {
      const directories: string[] = [];
      for (const path of paths) if ((await this.host.fs.stat(this.resolve(path)))?.kind === "directory") directories.push(path + "/");
      paths = directories;
    }
    return [...new Set(paths)].sort();
  }
}

function shellQuote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) return "$'" + value.replace(/[\\']/g, "\\$&").replace(/[\x00-\x1f\x7f]/g, c => ({ "\n": "\\n", "\t": "\\t", "\r": "\\r" })[c] ?? "\\" + c.charCodeAt(0).toString(8).padStart(3, "0")) + "'";
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function joinPieces(pieces: Piece[], mode: "text" | "pattern" | "regex"): string {
  let out = "";
  for (const piece of pieces) {
    if (piece.split === "break") out += " ";
    else if (mode === "text" || !piece.quoted) out += piece.text;
    else out += mode === "pattern" ? escapeGlob(piece.text) : escapeRegExp(piece.text);
  }
  return out;
}

type Builtin = (this: Runner, args: string[], io: IO) => Promise<number>;

function count(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  if (!/^-?\d+$/.test(text)) throw new CommandError(text + ": numeric argument required", 2);
  return Number(text);
}

function readFields(text: string, names: number, ifs: string): string[] {
  const white = [...ifs].filter(c => " \t\n".includes(c));
  const isWhite = (c: string) => white.includes(c);
  const isSep = (c: string) => ifs.includes(c);
  let pos = 0;
  while (pos < text.length && isWhite(text[pos])) pos++;
  const fields: string[] = [];
  while (fields.length < names - 1 && pos < text.length) {
    let end = pos;
    while (end < text.length && !isSep(text[end])) end++;
    fields.push(text.slice(pos, end));
    pos = end;
    while (pos < text.length && isWhite(text[pos])) pos++;
    if (pos < text.length && isSep(text[pos]) && !isWhite(text[pos])) {
      pos++;
      while (pos < text.length && isWhite(text[pos])) pos++;
    }
  }
  let rest = text.slice(pos);
  let end = rest.length;
  while (end > 0 && isWhite(rest[end - 1])) end--;
  rest = rest.slice(0, end);
  if (pos < text.length || fields.length < names) fields.push(rest);
  return fields;
}

const noop: Builtin = async () => 0;

const SHELL_BUILTINS = new Set(["echo", "printf", "kill", "test", "[", "pwd", "read", "true", "false", "type", "command", "ulimit", "umask", "wait", "jobs", "fg", "bg", "help", "history", "times"]);

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until", "do", "done", "in", "function", "time", "{", "}", "!", "[[", "]]", "coproc"]);

export const BUILTINS: Record<string, Builtin> = {
  ":": noop,
  true: noop,
  false: async () => 1,
  async wait(args) {
    const ids = args.filter(arg => !arg.startsWith("-"));
    if (!ids.length) return args.includes("-n") ? [...this.state.jobs.values()].pop() ?? 127 : 0;
    let status = 0;
    for (const id of ids) status = this.state.jobs.get(id.replace(/^%/, "")) ?? 127;
    return status;
  },
  jobs: noop,
  alias: noop,
  unalias: noop,
  hash: noop,
  ulimit: noop,
  umask: noop,
  disown: noop,
  async cd(args, io) {
    const target = args.filter(arg => arg !== "-P" && arg !== "-L")[0] ?? this.get("HOME") ?? "/";
    const destination = target === "-" ? this.get("OLDPWD") ?? this.state.cwd : target;
    const path = this.resolve(destination);
    const stat = await this.host.fs.stat(path);
    if (!stat) throw new CommandError(target + ": No such file or directory");
    if (stat.kind !== "directory") throw new CommandError(target + ": Not a directory");
    this.set("OLDPWD", this.state.cwd);
    this.state.cwd = path;
    this.set("PWD", path);
    if (target === "-") io.stdout.write(path + "\n");
    return 0;
  },
  async trap(args, io) {
    if (!args.length || args[0] === "-p") {
      for (const [signal, action] of this.state.traps) if (args.length < 2 || args.includes(signal)) io.stdout.write("trap -- " + shellQuote(action) + " " + signal + "\n");
      return 0;
    }
    if (args[0] === "-l") return 0;
    const rest = args[0] === "--" ? args.slice(1) : args;
    const reset = rest.length === 1 || /^(-|\d+)$/.test(rest[0]) && rest[0] !== "0";
    const action = reset ? "-" : rest[0];
    for (const raw of reset && rest[0] !== "-" ? rest : rest.slice(1)) {
      let signal = raw.toUpperCase().replace(/^SIG/, "");
      if (signal === "0") signal = "EXIT";
      if (action === "-") this.state.traps.delete(signal);
      else this.state.traps.set(signal, action);
    }
    return 0;
  },
  async shopt(args, io) {
    let mode = "";
    const names: string[] = [];
    for (const arg of args) {
      if (/^-[supqo]+$/.test(arg)) mode = arg.replace(/[op-]/g, "").slice(-1) || mode;
      else names.push(arg);
    }
    if (mode === "s" || mode === "u") {
      for (const name of names) {
        if (mode === "s") this.state.shopt.add(name);
        else this.state.shopt.delete(name);
      }
      return 0;
    }
    let status = 0;
    for (const name of names.length ? names : ["dotglob", "extglob", "failglob", "globstar", "nocaseglob", "nocasematch", "nullglob"]) {
      const on = this.state.shopt.has(name);
      if (!on) status = 1;
      if (mode !== "q") io.stdout.write(name.padEnd(15) + "\t" + (on ? "on" : "off") + "\n");
    }
    return status;
  },
  async getopts(args, io) {
    const [spec, name, ...rest] = args;
    if (spec === undefined || name === undefined) throw new CommandError("usage: getopts optstring name [arg ...]", 2);
    const argv = rest.length ? rest : this.state.positional;
    const silent = spec.startsWith(":");
    const letters = silent ? spec.slice(1) : spec;
    let index = Number(this.get("OPTIND") ?? "1") || 1;
    if (index !== this.state.optind) this.state.optpos = 1;
    const arg = argv[index - 1];
    this.state.vars.delete("OPTARG");
    if (arg === undefined || arg === "-" || !arg.startsWith("-") || arg === "--") {
      if (arg === "--") index++;
      this.state.optind = index;
      this.state.optpos = 1;
      this.set("OPTIND", String(index));
      this.set(name, "?");
      return 1;
    }
    const letter = arg[this.state.optpos] ?? "";
    let next = this.state.optpos + 1;
    const position = letter === ":" ? -1 : letters.indexOf(letter);
    if (position < 0) {
      this.set(name, "?");
      if (silent) this.set("OPTARG", letter);
      else io.stderr.write("bash: illegal option -- " + letter + "\n");
    } else if (letters[position + 1] === ":") {
      if (next < arg.length) {
        this.set("OPTARG", arg.slice(next));
        this.set(name, letter);
      } else if (argv[index] !== undefined) {
        this.set("OPTARG", argv[index]);
        this.set(name, letter);
        index++;
      } else if (silent) {
        this.set(name, ":");
        this.set("OPTARG", letter);
      } else {
        io.stderr.write("bash: option requires an argument -- " + letter + "\n");
        this.set(name, "?");
      }
      next = arg.length;
    } else this.set(name, letter);
    if (next >= arg.length) {
      index++;
      next = 1;
    }
    this.state.optpos = next;
    this.state.optind = index;
    this.set("OPTIND", String(index));
    return 0;
  },
  async pushd(args, io) {
    const target = args.find(arg => !arg.startsWith("-") || arg === "-");
    const previous = this.state.cwd;
    if (target === undefined) {
      const top = this.state.stack.shift();
      if (top === undefined) throw new CommandError("no other directory");
      await BUILTINS.cd.call(this, [top], { ...io, stdout: this.buffer() });
    } else {
      const status = await BUILTINS.cd.call(this, [target], { ...io, stdout: this.buffer() });
      if (status) return status;
    }
    this.state.stack.unshift(previous);
    io.stdout.write([this.state.cwd, ...this.state.stack].join(" ") + "\n");
    return 0;
  },
  async popd(_args, io) {
    const top = this.state.stack.shift();
    if (top === undefined) throw new CommandError("directory stack empty");
    await BUILTINS.cd.call(this, [top], { ...io, stdout: this.buffer() });
    io.stdout.write([this.state.cwd, ...this.state.stack].join(" ") + "\n");
    return 0;
  },
  async dirs(_args, io) {
    io.stdout.write([this.state.cwd, ...this.state.stack].join(" ") + "\n");
    return 0;
  },
  async pwd(_args, io) {
    io.stdout.write(this.state.cwd + "\n");
    return 0;
  },
  async unset(args) {
    let functions = false;
    for (const arg of args) {
      if (arg === "-f") functions = true;
      else if (arg === "-v") functions = false;
      else if (functions) this.state.functions.delete(arg);
      else {
        const element = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/);
        if (element) {
          const map = this.state.maps.get(element[1]);
          if (map) {
            map.delete(element[2]);
            continue;
          }
          const array = this.state.vars.get(element[1])?.slice();
          if (array) {
            const index = evaluateArith(element[2], { get: n => this.get(n) ?? "", set: () => undefined });
            delete array[index < 0 ? array.length + index : index];
            this.state.vars.set(element[1], array);
          }
          continue;
        }
        if (this.state.readonly.has(arg)) throw new CommandError(arg + ": cannot unset: readonly variable");
        this.local(arg);
        this.state.maps.delete(arg);
        this.state.vars.delete(arg);
        this.state.exported.delete(arg);
      }
    }
    return 0;
  },
  async set(args, io) {
    if (!args.length) {
      for (const [name, value] of [...this.state.vars].sort(([a], [b]) => (a < b ? -1 : 1))) io.stdout.write(name + "=" + (value[0] ?? "") + "\n");
      return 0;
    }
    const options: Record<string, keyof State["options"]> = { e: "errexit", u: "nounset", x: "xtrace", f: "noglob", errexit: "errexit", nounset: "nounset", xtrace: "xtrace", pipefail: "pipefail", noglob: "noglob" };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--" || arg === "-") {
        this.state.positional = args.slice(i + 1);
        return 0;
      }
      if (!/^[-+]/.test(arg)) {
        this.state.positional = args.slice(i);
        return 0;
      }
      const enable = arg[0] === "-";
      for (const flag of arg.slice(1)) {
        if (flag === "o") {
          const name = args[++i];
          if (name === undefined) {
            for (const [key, value] of Object.entries(this.state.options)) io.stdout.write(key.padEnd(15) + (value ? "on" : "off") + "\n");
            continue;
          }
          if (options[name]) this.state.options[options[name]] = enable;
          else if (!["posix", "vi", "emacs", "monitor", "notify", "noclobber", "allexport", "hashall", "braceexpand", "history", "ignoreeof", "verbose", "nolog", "physical", "functrace", "errtrace", "noexec", "keyword", "onecmd", "privileged", "interactive-comments"].includes(name)) throw new CommandError(name + ": invalid option name", 2);
        } else if (options[flag]) this.state.options[options[flag]] = enable;
      }
    }
    return 0;
  },
  async shift(args) {
    const n = count(args[0], 1);
    if (n > this.state.positional.length || n < 0) return 1;
    this.state.positional = this.state.positional.slice(n);
    return 0;
  },
  async read(args, io) {
    let raw = false;
    let delimiter = "\n";
    let array: string | undefined;
    let chars: number | undefined;
    const names: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (/^-[a-zA-Z]+$/.test(arg) && !names.length) {
        for (let j = 1; j < arg.length; j++) {
          const flag = arg[j];
          const value = () => (j + 1 < arg.length ? arg.slice(j + 1) : args[++i]);
          if (flag === "r") raw = true;
          else if (flag === "s") continue;
          else if (flag === "a") {
            array = value();
            break;
          } else if (flag === "d") {
            delimiter = value() ?? "";
            break;
          } else if (flag === "n" || flag === "N") {
            chars = Number(value());
            break;
          } else if (flag === "p" || flag === "t" || flag === "u") {
            value();
            break;
          }
        }
      } else names.push(arg);
    }
    let line: { text: string; complete: boolean } | null;
    if (chars !== undefined) {
      const text = io.stdin.chars(chars);
      line = text ? { text, complete: true } : null;
    } else line = io.stdin.line(delimiter);
    const targets = names.length ? names : array ? [] : ["REPLY"];
    if (!line) {
      for (const name of targets) this.set(name, "");
      if (array) this.set(array, []);
      return 1;
    }
    let text = line.text;
    if (!raw) text = text.replace(/\\([\s\S])/g, "$1");
    const ifs = this.state.vars.has("IFS") ? this.get("IFS")! : " \t\n";
    if (array) this.set(array, readFields(text, Number.MAX_SAFE_INTEGER, ifs).filter((field, index, all) => field !== "" || index < all.length - 1));
    if (targets.length === 1 && !names.length) this.set("REPLY", line.text);
    else {
      const fields = readFields(text, targets.length, ifs);
      targets.forEach((name, index) => this.set(name, fields[index] ?? ""));
    }
    return line.complete ? 0 : 1;
  },
  async mapfile(args, io) {
    let strip = false;
    let delimiter = "\n";
    let name = "MAPFILE";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-t") strip = true;
      else if (args[i] === "-d") delimiter = args[++i] ?? "\n";
      else if (args[i].startsWith("-")) i++;
      else name = args[i];
    }
    const values: string[] = [];
    for (let line = io.stdin.line(delimiter); line; line = io.stdin.line(delimiter)) values.push(strip || !line.complete ? line.text : line.text + delimiter);
    this.set(name, values);
    return 0;
  },
  async eval(args, io) {
    const source = args.join(" ");
    let script: Script;
    try {
      script = parse(source);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      io.stderr.write("bash: eval: " + error.message + "\n");
      return 2;
    }
    this.enter();
    try {
      return await this.script(script, io);
    } finally {
      this.leave();
    }
  },
  async source(args, io) {
    if (!args.length) throw new CommandError("filename argument required", 2);
    return this.source(this.resolve(args[0]), args.slice(1), io, false);
  },
  async exit(args) {
    throw new ExitSignal(args.length ? count(args[0], 0) & 255 : this.state.status);
  },
  async return(args) {
    throw new ReturnSignal(args.length ? count(args[0], 0) & 255 : this.state.status);
  },
  async break(args) {
    throw new LoopSignal("break", count(args[0], 1));
  },
  async continue(args) {
    throw new LoopSignal("continue", count(args[0], 1));
  },
  async let(args) {
    let value = 0;
    for (const arg of args) value = await this.arith([{ type: "text", value: arg, quoted: true }], { stdin: new Input(), stdout: this.buffer(), stderr: this.buffer() });
    return value === 0 ? 1 : 0;
  },
  async test(args, io) {
    return this.test(args.map(text => ({ text })), false, io);
  },
  async "["(args, io) {
    if (args[args.length - 1] !== "]") {
      io.stderr.write("bash: [: missing `]'\n");
      return 2;
    }
    return this.test(args.slice(0, -1).map(text => ({ text })), false, io);
  },
  async type(args, io) {
    let status = 0;
    const terse = args[0] === "-t";
    for (const name of args.filter(arg => !arg.startsWith("-"))) {
      const kind = KEYWORDS.has(name) ? "keyword" : this.state.functions.has(name) ? "function" : BUILTINS[name] || SHELL_BUILTINS.has(name) ? "builtin" : this.host.commands.has(name) ? "file" : undefined;
      if (!kind) {
        if (!terse) io.stderr.write("bash: type: " + name + ": not found\n");
        status = 1;
      } else if (terse) io.stdout.write(kind + "\n");
      else io.stdout.write(kind === "function" ? name + " is a function\n" : kind === "builtin" ? name + " is a shell builtin\n" : kind === "keyword" ? name + " is a shell keyword\n" : name + " is /usr/bin/" + name + "\n");
    }
    return status;
  },
  async command(args, io) {
    if (args[0] === "-v" || args[0] === "-V") {
      let status = 0;
      for (const name of args.slice(1)) {
        if (this.state.functions.has(name) || BUILTINS[name] || SHELL_BUILTINS.has(name) || KEYWORDS.has(name)) io.stdout.write(name + "\n");
        else if (this.host.commands.has(name)) io.stdout.write("/usr/bin/" + name + "\n");
        else status = 1;
      }
      return status;
    }
    if (!args.length) return 0;
    return this.dispatch(args, io, false);
  },
  async builtin(args, io) {
    const builtin = args.length ? BUILTINS[args[0]] : undefined;
    if (!builtin) throw new CommandError((args[0] ?? "") + ": not a shell builtin");
    return builtin.call(this, args.slice(1), io);
  },
  async which(args, io) {
    let status = 0;
    for (const name of args.filter(arg => !arg.startsWith("-"))) {
      if (this.host.commands.has(name) || BUILTINS[name]) io.stdout.write("/usr/bin/" + name + "\n");
      else status = 1;
    }
    return status;
  },
  async exec(args, io) {
    if (!args.length) return 0;
    throw new ExitSignal(await this.dispatch(args, io));
  },
  async env(args, io) {
    const assigns: [string, string][] = [];
    let clear = false;
    let i = 0;
    for (; i < args.length; i++) {
      if (args[i] === "-i" || args[i] === "-") clear = true;
      else if (args[i] === "-u") {
        assigns.push([args[++i], "\0"]);
      } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i])) {
        const eq = args[i].indexOf("=");
        assigns.push([args[i].slice(0, eq), args[i].slice(eq + 1)]);
      } else break;
    }
    const command = args.slice(i);
    return this.subshell(async () => {
      if (clear) {
        for (const name of this.state.exported) this.state.vars.delete(name);
        this.state.exported.clear();
      }
      for (const [name, value] of assigns) {
        if (value === "\0") {
          this.state.vars.delete(name);
          this.state.exported.delete(name);
        } else {
          this.set(name, value);
          this.state.exported.add(name);
        }
      }
      if (!command.length) {
        for (const [name, value] of Object.entries(this.environment())) io.stdout.write(name + "=" + value + "\n");
        return 0;
      }
      return this.dispatch(command, io, false);
    });
  },
  async printenv(args, io) {
    const env = this.environment();
    if (!args.length) {
      for (const [name, value] of Object.entries(env)) io.stdout.write(name + "=" + value + "\n");
      return 0;
    }
    let status = 0;
    for (const name of args) {
      if (name in env) io.stdout.write(env[name] + "\n");
      else status = 1;
    }
    return status;
  },
  async printf(args, io) {
    if (args[0] === "-v" && args.length >= 2) {
      const handler = this.host.commands.get("printf");
      if (!handler) return 1;
      const out = this.buffer();
      const status = await this.external("printf", handler, args.slice(2), { ...io, stdout: out });
      this.set(args[1], out.text());
      return status;
    }
    const handler = this.host.commands.get("printf");
    return handler ? this.external("printf", handler, args, io) : 127;
  },
  async bash(args, io) {
    const options: string[] = [];
    let i = 0;
    for (; i < args.length && /^[-+][a-zA-Z]+$/.test(args[i]); i++) options.push(args[i]);
    const command = options.some(option => option.includes("c"));
    const flags = options.map(option => option.replace(/[cl]/g, "")).filter(option => option.length > 1);
    return this.subshell(async () => {
      if (flags.length) await BUILTINS.set.call(this, flags, io);
      if (command) {
        const source = args[i] ?? "";
        let script: Script;
        try {
          script = parse(source);
        } catch (error) {
          if (!(error instanceof ParseError)) throw error;
          io.stderr.write("bash: -c: " + error.message + "\n");
          return 2;
        }
        if (args[i + 1] !== undefined) this.state.arg0 = args[i + 1];
        this.state.positional = args.slice(i + 2);
        this.enter();
        try {
          return await this.script(script, io);
        } finally {
          this.leave();
        }
      }
      if (i >= args.length) {
        const source = io.stdin.read();
        this.enter();
        try {
          return await this.script(parse(source), io);
        } finally {
          this.leave();
        }
      }
      return this.source(this.resolve(args[i]), args.slice(i + 1), io, false, args[i]);
    });
  },
  async timeout(args, io) {
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) i += args[i] === "-s" || args[i] === "-k" ? 2 : 1;
    const command = args.slice(i + 1);
    if (!command.length) throw new CommandError("missing operand", 125);
    return this.dispatch(command, io);
  },
  async time(args, io) {
    const start = Date.now();
    const status = args.length ? await this.dispatch(args, io) : 0;
    io.stderr.write("\nreal\t" + ((Date.now() - start) / 1000).toFixed(3) + "s\nuser\t0.000s\nsys\t0.000s\n");
    return status;
  },
};

BUILTINS["."] = BUILTINS.source;
BUILTINS.readarray = BUILTINS.mapfile;
BUILTINS.sh = BUILTINS.bash;

export async function run(runner: Runner, source: string, io: IO): Promise<number> {
  let status = await guard(runner, io, () => runner.script(parse(source), io));
  if (runner.state.traps.has("EXIT")) status = await guard(runner, io, () => runner.exitTrap(io, status));
  try {
    await runner.cleanup();
  } catch (error) {
    io.stderr.write("bash: " + message(error) + "\n");
  }
  return status;
}

async function guard(runner: Runner, io: IO, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ExitSignal || error instanceof ReturnSignal) return error.status;
    if (error instanceof LoopSignal) return 0;
    if (error instanceof ParseError) {
      runner.failure = "syntax";
      io.stderr.write("bash: " + error.message + "\n");
      return 2;
    }
    if (error instanceof LimitError) {
      runner.failure = "limit";
      io.stderr.write("bash: " + error.message + "\n");
      return error.status;
    }
    if (error instanceof FatalError || error instanceof ArithError || error instanceof CommandError) {
      if (!(error instanceof FatalError && error.reported)) io.stderr.write("bash: " + error.message + "\n");
      return error instanceof FatalError || error instanceof CommandError ? error.status : 1;
    }
    throw error;
  }
}

import { LimitError } from "../shell.ts";

export type WasmOptions = { interpreter?: WebAssembly.Module | Promise<WebAssembly.Module>; force?: boolean; fuel?: number; memoryBytes?: number };

export type ValueType = "i32" | "i64" | "f32" | "f64" | "v128" | "ref";

export type Signature = { params: ValueType[]; results: ValueType[] };

export type ExternKind = "function" | "memory" | "table" | "global" | "tag";

export type ImportEntry = { module: string; name: string; kind: ExternKind; signature?: Signature };

export type ExportEntry = { name: string; kind: ExternKind; signature?: Signature };

export type Value = number | bigint;

export type HostFunction = (...args: never[]) => unknown;

export type CallOptions = { check?: () => void };

export type Live = {
  engine: "native" | "interpreter";
  call(name: string, args: readonly (Value | string)[], options?: CallOptions): Value | Value[] | undefined;
  bytes(): Uint8Array<ArrayBuffer>;
  view(): DataView;
  grow(pages: number): number;
  dispose(): void;
};

export type Loaded = {
  engine: "native" | "interpreter";
  imports: ImportEntry[];
  exports: ExportEntry[];
  instantiate(functions: readonly (HostFunction | undefined)[], options?: CallOptions): Live;
  dispose(): void;
};

export class Trap extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Trap";
  }
}

export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

const SLICE = 10_000_000;

const CHECK_BUDGET = 1_000_000;

const CHECK_TABLE = "__nanocode_check";

const HELPER = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 7, 1, 1, 0x68, 1, 0x63, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 1, 10, 6, 1, 4, 0, 0x10, 0, 0x0b]);

class Unsupported extends Error {}

function leb(value: number): number[] {
  const out: number[] = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest) byte |= 0x80;
    out.push(byte);
  } while (rest);
  return out;
}

function sleb(value: number): number[] {
  const out: number[] = [];
  let rest = value | 0;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if ((rest === 0 && !(byte & 0x40)) || (rest === -1 && byte & 0x40)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function instrument(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length < 8) return undefined;
  let pos = 8;
  const u32 = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[pos++];
      if (byte === undefined) throw new Unsupported();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return result;
    }
  };
  const skipLeb = () => {
    while (bytes[pos++]! & 0x80) if (pos > bytes.length) throw new Unsupported();
  };
  const heap = () => skipLeb();
  const valtype = () => {
    const byte = bytes[pos++]!;
    if (byte === 0x63 || byte === 0x64) heap();
  };
  const blocktype = () => {
    const byte = bytes[pos]!;
    if (byte === 0x40 || (byte >= 0x6f && byte <= 0x7f) || (byte >= 0x69 && byte <= 0x6e)) pos++;
    else if (byte === 0x63 || byte === 0x64) {
      pos++;
      heap();
    } else skipLeb();
  };
  const memarg = () => {
    const align = u32();
    if (align & 0x40) skipLeb();
    skipLeb();
  };
  type Section = { id: number; head: number; start: number; end: number };
  const sections: Section[] = [];
  while (pos < bytes.length) {
    const head = pos;
    const id = bytes[pos++]!;
    const size = u32();
    sections.push({ id, head, start: pos, end: pos + size });
    pos += size;
  }
  if (pos !== bytes.length) return undefined;
  const find = (id: number) => sections.find(section => section.id === id);
  const code = find(10);
  if (!code) return undefined;
  const count = (section: Section | undefined) => {
    if (!section) return 0;
    pos = section.start;
    return u32();
  };
  let imported = { table: 0, global: 0 };
  const importSection = find(2);
  if (importSection) {
    pos = importSection.start;
    const n = u32();
    for (let i = 0; i < n; i++) {
      const module = u32();
      pos += module;
      const field = u32();
      pos += field;
      const kind = bytes[pos++];
      if (kind === 0) skipLeb();
      else if (kind === 1) {
        valtype();
        const flags = u32();
        skipLeb();
        if (flags & 1) skipLeb();
        imported.table++;
      } else if (kind === 2) {
        const flags = u32();
        skipLeb();
        if (flags & 1) skipLeb();
      } else if (kind === 3) {
        valtype();
        pos++;
        imported.global++;
      } else if (kind === 4) {
        pos++;
        skipLeb();
      } else throw new Unsupported();
    }
  }
  const typeIndex = count(find(1));
  const tableIndex = imported.table + count(find(4));
  const globalIndex = imported.global + count(find(6));
  const site = [0x23, ...leb(globalIndex), 0x41, 1, 0x6b, 0x24, ...leb(globalIndex), 0x23, ...leb(globalIndex), 0x45, 0x04, 0x40, 0x41, 0, 0x11, ...leb(typeIndex), ...leb(tableIndex), 0x41, ...sleb(CHECK_BUDGET), 0x24, ...leb(globalIndex), 0x0b];
  pos = code.start;
  const functions = u32();
  const bodies: Uint8Array[] = [];
  let loops = 0;
  for (let f = 0; f < functions; f++) {
    const size = u32();
    const start = pos;
    const end = pos + size;
    const groups = u32();
    for (let g = 0; g < groups; g++) {
      skipLeb();
      valtype();
    }
    const pieces: Uint8Array[] = [];
    let copied = start;
    while (pos < end) {
      const op = bytes[pos++]!;
      switch (op) {
        case 0x03:
          blocktype();
          pieces.push(bytes.subarray(copied, pos), new Uint8Array(site));
          copied = pos;
          loops++;
          break;
        case 0x02: case 0x04: case 0x06:
          blocktype();
          break;
        case 0x1f: {
          blocktype();
          const n = u32();
          for (let i = 0; i < n; i++) {
            const kind = bytes[pos++]!;
            if (kind === 0 || kind === 1) skipLeb();
            skipLeb();
          }
          break;
        }
        case 0x07: case 0x08: case 0x09: case 0x0c: case 0x0d: case 0x10: case 0x12: case 0x14: case 0x15: case 0x18: case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x3f: case 0x40: case 0x41: case 0x42: case 0xd2: case 0xd4: case 0xd6:
          skipLeb();
          break;
        case 0x0e: {
          const n = u32();
          for (let i = 0; i <= n; i++) skipLeb();
          break;
        }
        case 0x11: case 0x13:
          skipLeb();
          skipLeb();
          break;
        case 0x1c: {
          const n = u32();
          for (let i = 0; i < n; i++) valtype();
          break;
        }
        case 0x43:
          pos += 4;
          break;
        case 0x44:
          pos += 8;
          break;
        case 0xd0:
          heap();
          break;
        case 0xfc: {
          const sub = u32();
          if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
            skipLeb();
            skipLeb();
          } else if (sub === 9 || sub === 11 || sub === 13 || sub === 15 || sub === 16 || sub === 17) skipLeb();
          else if (sub > 17) throw new Unsupported();
          break;
        }
        case 0xfd: {
          const sub = u32();
          if (sub <= 11 || sub === 92 || sub === 93) memarg();
          else if (sub === 12 || sub === 13) pos += 16;
          else if (sub >= 21 && sub <= 34) pos += 1;
          else if (sub >= 84 && sub <= 91) {
            memarg();
            pos += 1;
          }
          break;
        }
        case 0xfe: {
          const sub = u32();
          if (sub === 3) pos += 1;
          else memarg();
          break;
        }
        default:
          if (op >= 0x28 && op <= 0x3e) memarg();
          else if (op === 0xfb || op === 0x05 || op === 0x0a || op === 0x19 || op === 0x00 || op === 0x01 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b || (op >= 0x45 && op <= 0xc4) || op === 0xd1 || op === 0xd3 || op === 0xd5) {
            if (op === 0xfb) throw new Unsupported();
          } else throw new Unsupported();
      }
    }
    if (pos !== end) throw new Unsupported();
    pieces.push(bytes.subarray(copied, end));
    const length = pieces.reduce((total, piece) => total + piece.length, 0);
    const body = new Uint8Array(leb(length).length + length);
    body.set(leb(length));
    let at = leb(length).length;
    for (const piece of pieces) {
      body.set(piece, at);
      at += piece.length;
    }
    bodies.push(body);
  }
  if (!loops) return undefined;
  const vector = (section: Section | undefined, extra: number[]) => {
    const n = count(section);
    const rest = section ? bytes.subarray(pos, section.end) : new Uint8Array();
    return new Uint8Array([...leb(n + 1), ...rest, ...extra]);
  };
  const name = new TextEncoder().encode(CHECK_TABLE);
  const replaced = new Map<number, Uint8Array>([
    [1, vector(find(1), [0x60, 0, 0])],
    [4, vector(find(4), [0x70, 0, 1])],
    [6, vector(find(6), [0x7f, 1, 0x41, ...sleb(CHECK_BUDGET), 0x0b])],
    [7, vector(find(7), [...leb(name.length), ...name, 1, ...leb(tableIndex)])],
  ]);
  const codeLength = leb(functions).length + bodies.reduce((total, body) => total + body.length, 0);
  const codeBytes = new Uint8Array(codeLength);
  codeBytes.set(leb(functions));
  let at = leb(functions).length;
  for (const body of bodies) {
    codeBytes.set(body, at);
    at += body.length;
  }
  replaced.set(10, codeBytes);
  const order = [1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11];
  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  const emitted = new Set<number>();
  const emit = (id: number) => {
    const body = replaced.get(id)!;
    out.push(new Uint8Array([id, ...leb(body.length)]), body);
    emitted.add(id);
  };
  for (const section of sections) {
    if (section.id !== 0) {
      for (const id of order.slice(0, order.indexOf(section.id))) if (replaced.has(id) && !emitted.has(id) && !find(id)) emit(id);
    }
    if (replaced.has(section.id)) emit(section.id);
    else out.push(bytes.subarray(section.head, section.end));
  }
  for (const id of order) if (replaced.has(id) && !emitted.has(id)) emit(id);
  const total = out.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of out) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function guarded(bytes: Uint8Array): Uint8Array | undefined {
  try {
    return instrument(bytes);
  } catch (error) {
    if (error instanceof Unsupported || error instanceof RangeError) return undefined;
    throw error;
  }
}



const TYPES: Record<string, ValueType> = { i: "i32", I: "i64", f: "f32", F: "f64", v: "v128", r: "ref" };

const KINDS: Record<string, ExternKind> = { func: "function", memory: "memory", table: "table", global: "global" };

let nativeRefused: string | undefined;

function refusedMessage(text: string): boolean {
  return /disallowed|not allowed|code generation|CSP|unsafe-eval/i.test(text);
}

export async function load(bytes: Uint8Array, options: WasmOptions = {}): Promise<Loaded> {
  if (!(options.force && options.interpreter) && nativeRefused === undefined) {
    try {
      const compile = (WebAssembly as unknown as { compile(bytes: Uint8Array): Promise<WebAssembly.Module> }).compile;
      const patched = guarded(bytes);
      if (patched) {
        const module = await compile(patched).catch(() => undefined);
        helper ??= await compile(HELPER).catch(() => undefined);
        if (module && helper) return native(module, true);
      }
      return native(await compile(bytes.slice()), false);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!refusedMessage(text)) throw error;
      nativeRefused = text;
    }
  }
  if (!options.interpreter) throw new Refused("this host cannot compile WebAssembly at runtime (" + nativeRefused + ") and has no interpreter (BashOptions.wasm.interpreter, nanocode-ts/interpreter.wasm)");
  return interpret(await machine(await options.interpreter), bytes, options);
}

function nativeKind(kind: string): ExternKind {
  return kind === "function" || kind === "memory" || kind === "table" || kind === "global" ? kind : "tag";
}

let helper: WebAssembly.Module | undefined;

function native(module: WebAssembly.Module, instrumented: boolean): Loaded {
  const imports = WebAssembly.Module.imports(module).map(entry => ({ module: entry.module, name: entry.name, kind: nativeKind(entry.kind) }));
  const exports = WebAssembly.Module.exports(module).filter(entry => !instrumented || entry.name !== CHECK_TABLE).map(entry => ({ name: entry.name, kind: nativeKind(entry.kind) }));
  return {
    engine: "native",
    imports,
    exports,
    dispose: () => {},
    instantiate: (functions, options = {}) => {
      let check = options.check;
      const object: Record<string, Record<string, unknown>> = {};
      imports.forEach((entry, index) => {
        const space = (object[entry.module] ??= {});
        space[entry.name] = functions[index] ?? (() => {
          throw new Trap(entry.module + "." + entry.name + " is not provided by this host");
        });
      });
      let instance: WebAssembly.Instance;
      try {
        instance = new WebAssembly.Instance(module, object as WebAssembly.Imports);
      } catch (error) {
        throw error instanceof WebAssembly.RuntimeError ? new Trap(error.message) : error;
      }
      const table = instrumented ? instance.exports[CHECK_TABLE] : undefined;
      if (table instanceof WebAssembly.Table && helper) {
        const tick = new WebAssembly.Instance(helper, { h: { c: () => check?.() } });
        table.set(0, tick.exports["f"]);
      }
      const memory = () => {
        const found = instance.exports["memory"] ?? Object.values(instance.exports).find(value => value instanceof WebAssembly.Memory);
        if (!(found instanceof WebAssembly.Memory)) throw new Trap("the module exports no memory");
        return found;
      };
      return {
        engine: "native",
        bytes: () => new Uint8Array(memory().buffer),
        view: () => new DataView(memory().buffer),
        grow: pages => {
          try {
            return memory().grow(pages);
          } catch {
            return -1;
          }
        },
        dispose: () => {},
        call: (name, args, call = {}) => {
          if (call.check) check = call.check;
          const fn = instance.exports[name];
          if (typeof fn !== "function") throw new Trap("no exported function named " + name);
          const invoke = (values: unknown[]) => {
            try {
              return (fn as (...args: unknown[]) => Value | Value[] | undefined)(...values);
            } catch (error) {
              throw error instanceof WebAssembly.RuntimeError ? new Trap(error.message) : error;
            }
          };
          try {
            return invoke(args.map(arg => (typeof arg === "string" ? Number(arg) : arg)));
          } catch (error) {
            if (!(error instanceof TypeError) || !args.some(arg => typeof arg === "string")) throw error;
            return invoke(args.map(arg => (typeof arg === "string" ? BigInt(arg) : arg)));
          }
        },
      };
    },
  };
}

type Raw = {
  memory: WebAssembly.Memory;
  alloc(length: number): number;
  dealloc(pointer: number, length: number): void;
  out_ptr(): number;
  out_len(): number;
  load(pointer: number, length: number): number;
  module_drop(id: number): void;
  imports(id: number): number;
  exports(id: number): number;
  instantiate(id: number, memoryBytes: number, fuelLo: number, fuelHi: number): number;
  instance_drop(id: number): void;
  invoke(id: number, name: number, nameLength: number, slots: number, count: number, fuelLo: number, fuelHi: number): number;
  resume(id: number, slots: number, fuelLo: number, fuelHi: number): number;
  memory_ptr(id: number): number;
  memory_len(id: number): number;
  memory_grow(id: number, pages: number): number;
};

type Bound = { functions: readonly (HostFunction | undefined)[]; imports: readonly ImportEntry[] };

type Machine = { raw: Raw; bound: Map<number, Bound>; pending: Bound | undefined; thrown: { error: unknown } | undefined; slots: number; capacity: number; broken: boolean; live: number; release: () => void; dataView: DataView };

const RELEASE_BYTES = 16 * 1024 * 1024;

const MACHINES = new WeakMap<WebAssembly.Module, Promise<Machine>>();

function machine(module: WebAssembly.Module): Promise<Machine> {
  let found = MACHINES.get(module);
  if (found) return found;
  found = (async () => {
    const state = {} as Machine;
    const imports = { host: { call: (instance: number, index: number, slots: number, params: number, results: number) => hostCall(state, instance, index, slots, params, results) } };
    const instance = (await WebAssembly.instantiate(module, imports)) as unknown as WebAssembly.Instance;
    state.raw = instance.exports as unknown as Raw;
    state.bound = new Map();
    state.pending = undefined;
    state.thrown = undefined;
    state.capacity = 64;
    state.slots = state.raw.alloc(state.capacity * 8);
    state.broken = false;
    state.live = 0;
    state.dataView = new DataView(state.raw.memory.buffer);
    state.release = () => {
      if (state.live > 0 || state.raw.memory.buffer.byteLength <= RELEASE_BYTES) return;
      if (MACHINES.get(module) === found) MACHINES.delete(module);
    };
    return state;
  })();
  MACHINES.set(module, found);
  found.catch(() => MACHINES.delete(module));
  return found;
}

function readSlot(view: DataView, pointer: number, type: ValueType): Value {
  if (type === "i32") return view.getInt32(pointer, true);
  if (type === "i64") return view.getBigInt64(pointer, true);
  if (type === "f32") return view.getFloat32(pointer, true);
  if (type === "f64") return view.getFloat64(pointer, true);
  throw new Trap("only i32, i64, f32 and f64 values cross the host boundary");
}

function writeSlot(view: DataView, pointer: number, type: ValueType, value: unknown) {
  view.setBigUint64(pointer, 0n, true);
  if (type === "i32") view.setInt32(pointer, typeof value === "bigint" ? Number(BigInt.asIntN(32, value)) : Number(value ?? 0) | 0, true);
  else if (type === "i64") view.setBigInt64(pointer, BigInt.asIntN(64, typeof value === "bigint" ? value : BigInt(typeof value === "string" ? value : Math.trunc(Number(value ?? 0)))), true);
  else if (type === "f32") view.setFloat32(pointer, Number(value ?? 0), true);
  else if (type === "f64") view.setFloat64(pointer, Number(value ?? 0), true);
  else throw new Trap("only i32, i64, f32 and f64 values cross the host boundary");
}

function machineView(state: Machine): DataView {
  if (state.dataView.buffer !== state.raw.memory.buffer) state.dataView = new DataView(state.raw.memory.buffer);
  return state.dataView;
}

function hostCall(state: Machine, instance: number, index: number, slots: number, params: number, results: number): number {
  try {
    const bound = state.bound.get(instance) ?? state.pending;
    const entry = bound?.imports[index];
    const fn = bound?.functions[index];
    if (!entry || !entry.signature) throw new Trap("unknown import " + index);
    if (!fn) throw new Trap(entry.module + "." + entry.name + " is not provided by this host");
    const view = machineView(state);
    const args: Value[] = [];
    for (let i = 0; i < params; i++) args.push(readSlot(view, slots + i * 8, entry.signature.params[i] ?? "i32"));
    const value = (fn as (...args: Value[]) => unknown)(...args);
    const after = machineView(state);
    const values = results > 1 && Array.isArray(value) ? value : [value];
    for (let i = 0; i < results; i++) writeSlot(after, slots + i * 8, entry.signature.results[i] ?? "i32", values[i]);
    return 0;
  } catch (error) {
    state.thrown = { error };
    return 1;
  }
}

function text(raw: Raw): string {
  return new TextDecoder().decode(new Uint8Array(raw.memory.buffer, raw.out_ptr() >>> 0, raw.out_len() >>> 0));
}

function lines(raw: Raw, count: number): string[][] {
  if (count <= 0) return [];
  return text(raw).split("\n").map(line => line.split("\t"));
}

function signature(params: string | undefined, results: string | undefined): Signature {
  return { params: [...(params ?? "")].map(code => TYPES[code] ?? "ref"), results: [...(results ?? "")].map(code => TYPES[code] ?? "ref") };
}

function guard<T>(state: Machine, work: () => T): T {
  if (state.broken) throw new Trap("the WebAssembly interpreter failed earlier in this isolate");
  try {
    return work();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      state.broken = true;
      throw new Trap("the WebAssembly interpreter failed: " + error.message);
    }
    throw error;
  }
}

function withBytes<T>(raw: Raw, bytes: Uint8Array, work: (pointer: number) => T): T {
  const pointer = raw.alloc(bytes.length) >>> 0;
  new Uint8Array(raw.memory.buffer, pointer, bytes.length).set(bytes);
  try {
    return work(pointer);
  } finally {
    raw.dealloc(pointer, bytes.length);
  }
}

function fuel(amount: number): [number, number] {
  const value = BigInt(Math.max(0, Math.min(Math.floor(amount), Number.MAX_SAFE_INTEGER)));
  return [Number(value & 0xffffffffn), Number(value >> 32n)];
}

function interpret(state: Machine, bytes: Uint8Array, options: WasmOptions): Loaded {
  const raw = state.raw;
  const id = guard(state, () => withBytes(raw, bytes, pointer => raw.load(pointer, bytes.length)));
  if (id < 0) throw new Trap(text(raw));
  state.live++;
  let dropped = false;
  const imports: ImportEntry[] = lines(raw, raw.imports(id)).map(([module = "", name = "", kind = "", params, results]) => ({ module, name, kind: KINDS[kind] ?? "tag", ...(kind === "func" ? { signature: signature(params, results) } : {}) }));
  const exports: ExportEntry[] = lines(raw, raw.exports(id)).map(([name = "", kind = "", params, results]) => ({ name, kind: KINDS[kind] ?? "tag", ...(kind === "func" ? { signature: signature(params, results) } : {}) }));
  const budget = options.fuel ?? Number.POSITIVE_INFINITY;
  const memoryBytes = Math.min(options.memoryBytes ?? 0xffffffff, 0xffffffff);
  return {
    engine: "interpreter",
    imports,
    exports,
    dispose: () => {
      if (dropped) return;
      dropped = true;
      if (!state.broken) raw.module_drop(id);
      state.live--;
      state.release();
    },
    instantiate: (functions, callOptions = {}) => {
      const bound: Bound = { functions, imports };
      state.pending = bound;
      state.thrown = undefined;
      const instance = guard(state, () => raw.instantiate(id, memoryBytes, ...fuel(Math.min(budget, 1e12))));
      state.pending = undefined;
      if (instance < 0) {
        const thrown = state.thrown as { error: unknown } | undefined;
        state.thrown = undefined;
        if (thrown) throw thrown.error;
        if (instance === -2) throw new Trap(text(raw));
        const failure = new Error(text(raw));
        failure.name = "LinkError";
        throw failure;
      }
      state.bound.set(instance, bound);
      state.live++;
      callOptions.check?.();
      let disposed = false;
      let cached: { buffer: ArrayBuffer; pointer: number; length: number; bytes?: Uint8Array<ArrayBuffer>; view?: DataView } | undefined;
      const memory = () => {
        const pointer = raw.memory_ptr(instance) >>> 0;
        const length = raw.memory_len(instance) >>> 0;
        if (!pointer && !length) throw new Trap("the module exports no memory");
        const buffer = raw.memory.buffer;
        if (!cached || cached.buffer !== buffer || cached.pointer !== pointer || cached.length !== length) cached = { buffer, pointer, length };
        return cached;
      };
      return {
        engine: "interpreter",
        bytes: () => {
          const found = memory();
          return (found.bytes ??= new Uint8Array(found.buffer, found.pointer, found.length));
        },
        view: () => {
          const found = memory();
          return (found.view ??= new DataView(found.buffer, found.pointer, found.length));
        },
        grow: pages => guard(state, () => raw.memory_grow(instance, pages)),
        dispose: () => {
          if (disposed) return;
          disposed = true;
          state.bound.delete(instance);
          if (!state.broken) raw.instance_drop(instance);
          state.live--;
          state.release();
        },
        call: (name, args, call = {}) => {
          const entry = exports.find(item => item.name === name);
          if (!entry || entry.kind !== "function" || !entry.signature) throw new Trap("no exported function named " + name);
          const types = entry.signature;
          if (args.length !== types.params.length) throw new Trap(name + " takes " + types.params.length + " arguments, not " + args.length);
          const width = Math.max(types.params.length, types.results.length, 1);
          if (width > state.capacity) {
            raw.dealloc(state.slots, state.capacity * 8);
            state.capacity = width;
            state.slots = raw.alloc(width * 8) >>> 0;
          }
          const slots = state.slots >>> 0;
          let view = machineView(state);
          types.params.forEach((type, index) => writeSlot(view, slots + index * 8, type, args[index]));
          state.thrown = undefined;
          const encoded = new TextEncoder().encode(name);
          let used = Math.min(budget, SLICE);
          let status = guard(state, () => withBytes(raw, encoded, pointer => raw.invoke(instance, pointer, encoded.length, slots, types.params.length, ...fuel(used))));
          while (status === 2) {
            call.check?.();
            if (used >= budget) throw new LimitError("wasm: the program used its budget of " + budget + " fuel units", 124);
            const next = Math.min(budget - used, SLICE);
            used += next;
            status = guard(state, () => raw.resume(instance, slots, ...fuel(next)));
          }
          if (status === 3 || state.thrown) {
            const thrown = state.thrown as { error: unknown } | undefined;
            state.thrown = undefined;
            if (thrown) throw thrown.error;
          }
          if (status === 1) throw new Trap(text(raw));
          if (status !== 0) throw new Error(text(raw));
          view = machineView(state);
          const results = types.results.map((type, index) => readSlot(view, slots + index * 8, type));
          if (results.length > 1) return results;
          return results[0];
        },
      };
    },
  };
}

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

const TYPES: Record<string, ValueType> = { i: "i32", I: "i64", f: "f32", F: "f64", v: "v128", r: "ref" };

const KINDS: Record<string, ExternKind> = { func: "function", memory: "memory", table: "table", global: "global" };

let nativeRefused: string | undefined;

function refusedMessage(text: string): boolean {
  return /disallowed|not allowed|code generation|CSP|unsafe-eval/i.test(text);
}

export async function load(bytes: Uint8Array, options: WasmOptions = {}): Promise<Loaded> {
  if (!(options.force && options.interpreter) && nativeRefused === undefined) {
    try {
      return native(await (WebAssembly as unknown as { compile(bytes: Uint8Array): Promise<WebAssembly.Module> }).compile(bytes.slice()));
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

function native(module: WebAssembly.Module): Loaded {
  const imports = WebAssembly.Module.imports(module).map(entry => ({ module: entry.module, name: entry.name, kind: nativeKind(entry.kind) }));
  const exports = WebAssembly.Module.exports(module).map(entry => ({ name: entry.name, kind: nativeKind(entry.kind) }));
  return {
    engine: "native",
    imports,
    exports,
    dispose: () => {},
    instantiate: functions => {
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
        call: (name, args) => {
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

type Machine = { raw: Raw; bound: Map<number, Bound>; pending: Bound | undefined; thrown: { error: unknown } | undefined; slots: number; capacity: number; broken: boolean };

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

function hostCall(state: Machine, instance: number, index: number, slots: number, params: number, results: number): number {
  try {
    const bound = state.bound.get(instance) ?? state.pending;
    const entry = bound?.imports[index];
    const fn = bound?.functions[index];
    if (!entry || !entry.signature) throw new Trap("unknown import " + index);
    if (!fn) throw new Trap(entry.module + "." + entry.name + " is not provided by this host");
    const view = new DataView(state.raw.memory.buffer);
    const args: Value[] = [];
    for (let i = 0; i < params; i++) args.push(readSlot(view, slots + i * 8, entry.signature.params[i] ?? "i32"));
    const value = (fn as (...args: Value[]) => unknown)(...args);
    const after = new DataView(state.raw.memory.buffer);
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
  const imports: ImportEntry[] = lines(raw, raw.imports(id)).map(([module = "", name = "", kind = "", params, results]) => ({ module, name, kind: KINDS[kind] ?? "tag", ...(kind === "func" ? { signature: signature(params, results) } : {}) }));
  const exports: ExportEntry[] = lines(raw, raw.exports(id)).map(([name = "", kind = "", params, results]) => ({ name, kind: KINDS[kind] ?? "tag", ...(kind === "func" ? { signature: signature(params, results) } : {}) }));
  const budget = options.fuel ?? Number.POSITIVE_INFINITY;
  const memoryBytes = Math.min(options.memoryBytes ?? 0xffffffff, 0xffffffff);
  return {
    engine: "interpreter",
    imports,
    exports,
    dispose: () => {
      if (!state.broken) raw.module_drop(id);
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
      callOptions.check?.();
      let disposed = false;
      const memory = () => {
        const pointer = raw.memory_ptr(instance) >>> 0;
        const length = raw.memory_len(instance) >>> 0;
        if (!pointer && !length) throw new Trap("the module exports no memory");
        return { pointer, length };
      };
      return {
        engine: "interpreter",
        bytes: () => {
          const found = memory();
          return new Uint8Array(raw.memory.buffer, found.pointer, found.length);
        },
        view: () => {
          const found = memory();
          return new DataView(raw.memory.buffer, found.pointer, found.length);
        },
        grow: pages => guard(state, () => raw.memory_grow(instance, pages)),
        dispose: () => {
          if (disposed) return;
          disposed = true;
          state.bound.delete(instance);
          if (!state.broken) raw.instance_drop(instance);
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
          let view = new DataView(raw.memory.buffer);
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
          view = new DataView(raw.memory.buffer);
          const results = types.results.map((type, index) => readSlot(view, slots + index * 8, type));
          if (results.length > 1) return results;
          return results[0];
        },
      };
    },
  };
}

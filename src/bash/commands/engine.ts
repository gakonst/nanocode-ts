import { LimitError } from "../shell.ts";

export type ValueType = "i32" | "i64" | "f32" | "f64" | "v128" | "ref";

export type Signature = { params: ValueType[]; results: ValueType[] };

export type ExternKind = "function" | "memory" | "table" | "global" | "tag";

export type ImportEntry = { module: string; name: string; kind: ExternKind; signature?: Signature };

export type ExportEntry = { name: string; kind: ExternKind; signature?: Signature };

export type Value = number | bigint;

export type HostFunction = (...args: never[]) => unknown;

export type CallOptions = { check?: () => void };

export type Live = {
  engine: "native";
  call(name: string, args: readonly (Value | string)[], options?: CallOptions): Value | Value[] | undefined;
  bytes(): Uint8Array<ArrayBuffer>;
  view(): DataView;
  grow(pages: number): number;
  dispose(): void;
};

export type Loaded = {
  engine: "native";
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




let nativeRefused: string | undefined;

function refusedMessage(text: string): boolean {
  return /disallowed|not allowed|code generation|CSP|unsafe-eval/i.test(text);
}

export function browser(): boolean {
  const scope = globalThis as { document?: unknown; DedicatedWorkerGlobalScope?: unknown; SharedWorkerGlobalScope?: unknown };
  return scope.document !== undefined || scope.DedicatedWorkerGlobalScope !== undefined || scope.SharedWorkerGlobalScope !== undefined;
}

export async function load(bytes: Uint8Array): Promise<Loaded> {
  if (nativeRefused === undefined) {
    try {
      return native(await (WebAssembly as unknown as { compile(bytes: Uint8Array): Promise<WebAssembly.Module> }).compile(bytes.slice()));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!refusedMessage(text)) throw error;
      nativeRefused = text;
    }
  }
  throw new Refused("this host cannot compile WebAssembly at runtime (" + nativeRefused + ")");
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

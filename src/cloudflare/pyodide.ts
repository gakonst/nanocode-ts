import { MODULES, PYODIDE_VERSION as BUILT } from "nanocode-ts/pyodide-modules";
import { PYODIDE_URL, PYODIDE_VERSION, type Pyodide } from "../bash/commands/python.ts";
import { fingerprint } from "../fingerprint.ts";

type Instantiate = (source: unknown, imports?: WebAssembly.Imports) => Promise<unknown>;

let installed = false;

function lookup(bytes: unknown): WebAssembly.Module {
  if (bytes instanceof WebAssembly.Module) return bytes;
  const key = fingerprint(bytes as ArrayBufferView);
  const found = MODULES[key];
  if (!found) throw new Error("Python here runs only the native code built into this Worker (Pyodide with numpy, matplotlib, Pillow and their dependencies) and pure-Python wheels from pip; WebAssembly module " + key + " is not built in");
  return found;
}

function install(): void {
  if (installed) return;
  installed = true;
  const scope = globalThis as unknown as { process?: { browser?: boolean; type?: string }; location?: URL };
  if (scope.process) {
    try {
      scope.process.browser = true;
      scope.process.type = "renderer";
    } catch {}
  }
  scope.location ??= new URL(PYODIDE_URL);
  const wasm = WebAssembly as unknown as Record<string, unknown>;
  const Compiled = WebAssembly.Module;
  const instantiate = WebAssembly.instantiate.bind(WebAssembly) as unknown as Instantiate;
  const Module = function (bytes: unknown) {
    return lookup(bytes);
  } as unknown as Record<string, unknown>;
  Module.prototype = Compiled.prototype;
  Module.customSections = Compiled.customSections;
  Module.imports = Compiled.imports;
  Module.exports = Compiled.exports;
  wasm.Module = Module;
  wasm.compile = async (bytes: unknown) => lookup(bytes);
  const instantiated: Instantiate = async (bytes, imports) => {
    const module = lookup(bytes);
    const instance = await instantiate(module, imports);
    return bytes instanceof Compiled ? instance : { module, instance };
  };
  wasm.instantiate = instantiated;
  wasm.instantiateStreaming = async (response: Response | PromiseLike<Response>, imports?: WebAssembly.Imports) => instantiated(new Uint8Array(await (await response).arrayBuffer()), imports);
  const main = new TextEncoder().encode("nanocode-pyodide:" + BUILT);
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/pyodide.asm.wasm")) return new Response(main);
    const integrity = init?.integrity;
    if (!integrity) return original(input, init);
    const response = await original(input, { ...init, integrity: undefined });
    if (!response.ok) return response;
    const body = await response.arrayBuffer();
    const [algorithm, expected] = integrity.split("-", 2) as [string, string];
    const digest = new Uint8Array(await crypto.subtle.digest(algorithm.toUpperCase().replace("SHA", "SHA-"), body));
    if (btoa(String.fromCharCode(...digest)) !== expected) throw new Error("integrity check failed for " + url);
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

export async function loadWorkersPyodide(): Promise<Pyodide> {
  if (BUILT !== PYODIDE_VERSION) throw new Error("nanocode-ts precompiled Pyodide " + BUILT + " but expects " + PYODIDE_VERSION);
  install();
  const [loader, asm] = await Promise.all([import("pyodide/pyodide.mjs"), import("pyodide/pyodide.asm.mjs")]);
  if (loader.version !== BUILT) throw new Error("the pyodide package is " + loader.version + ", but nanocode-ts precompiled " + BUILT + ": install pyodide@" + BUILT);
  return await loader.loadPyodide({ indexURL: PYODIDE_URL, packageBaseUrl: PYODIDE_URL, createPyodideModule: asm.default, stdout: () => {}, stderr: () => {} }) as Pyodide;
}


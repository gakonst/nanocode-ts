declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "nanocode-ts/pyodide-modules" {
  export const PYODIDE_VERSION: string;
  export const MODULES: Record<string, WebAssembly.Module>;
}

declare module "pyodide/pyodide.asm.mjs" {
  const createPyodideModule: (settings: object) => Promise<unknown>;
  export default createPyodideModule;
}

declare module "pyodide/pyodide.mjs" {
  export const version: string;
  export function loadPyodide(config: Record<string, unknown>): Promise<unknown>;
}


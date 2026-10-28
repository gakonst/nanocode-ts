/**
 * Options of the shell's WebAssembly commands (`wasm`, `wasmtime`, and `.wasm` programs) and of
 * Code Mode's WebAssembly cells.
 *
 * @module
 */

/** Options of the WebAssembly runtime. */
export type Options = {
  /** Runs modules on the interpreter even when the host compiles WebAssembly. Requires `interpreter`. */
  force?: boolean
  /** Instruction budget of one interpreted call. Defaults to no limit. */
  fuel?: number
  /** Interpreter module (`nanocode-ts/interpreter.wasm`) for hosts that cannot compile WebAssembly at runtime. */
  interpreter?: WebAssembly.Module | Promise<WebAssembly.Module>
  /** Largest linear memory in bytes of an interpreted module. Defaults to 4 GiB. */
  memoryBytes?: number
}

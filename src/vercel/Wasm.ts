/**
 * Loads the nanocode WebAssembly module from the package files once per process.
 *
 * @module
 */
import * as fs from 'node:fs/promises'

// The key is durable: every copy of the package in one process shares the compiled module.
const key = Symbol.for('nanocode-ts//vercel//module')

/** Compiles `nanocode_wasm.wasm` beside the package root once, and returns the cached module after that. */
export function load(): Promise<WebAssembly.Module> {
  const scope = globalThis as { [key]?: Promise<WebAssembly.Module> }

  // The path is relative to this file, so the module stays one folder below the package root.
  scope[key] ??= fs
    .readFile(new URL('../nanocode_wasm.wasm', import.meta.url))
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error) => {
      scope[key] = undefined
      throw error
    })

  return scope[key]
}

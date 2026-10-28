import { readFile } from 'node:fs/promises'

const MODULE = Symbol.for('nanocode-ts//vercel//module')

export function nanocodeModule(): Promise<WebAssembly.Module> {
  const scope = globalThis as { [MODULE]?: Promise<WebAssembly.Module> }
  scope[MODULE] ??= readFile(new URL('../nanocode_wasm.wasm', import.meta.url))
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error) => {
      scope[MODULE] = undefined
      throw error
    })
  return scope[MODULE]
}

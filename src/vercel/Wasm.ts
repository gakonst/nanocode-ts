import * as fs from 'node:fs/promises'

const key = Symbol.for('nanocode-ts//vercel//module')

export function load(): Promise<WebAssembly.Module> {
  const scope = globalThis as { [key]?: Promise<WebAssembly.Module> }

  scope[key] ??= fs
    .readFile(new URL('../nanocode_wasm.wasm', import.meta.url))
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error) => {
      scope[key] = undefined
      throw error
    })

  return scope[key]
}

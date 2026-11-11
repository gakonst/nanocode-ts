import * as fs from 'node:fs/promises'

const key = Symbol.for('nanocode-ts//vercel//module')

const pshKey = Symbol.for('nanocode-ts//vercel//psh')

export function load(): Promise<WebAssembly.Module> {
  return shared(key, '../nanocode_wasm.wasm')
}

export function psh(): Promise<WebAssembly.Module> {
  return shared(pshKey, '../psh.wasm')
}

function shared(slot: symbol, file: string): Promise<WebAssembly.Module> {
  const scope = globalThis as { [slot: symbol]: Promise<WebAssembly.Module> | undefined }

  scope[slot] ??= fs
    .readFile(new URL(file, import.meta.url))
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error) => {
      scope[slot] = undefined
      throw error
    })

  return scope[slot]
}

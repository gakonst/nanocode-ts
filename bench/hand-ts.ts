import { readFileSync } from 'node:fs'
import * as Hand from '../src/Hand.ts'
import * as Bash from '../src/bash/Bash.ts'
import * as MemoryFileSystem from '../src/bash/MemoryFileSystem.ts'

const module = await WebAssembly.compile(
  readFileSync(
    process.env.NANOCODE_WASM_PATH ?? new URL('../dist/nanocode_wasm.wasm', import.meta.url),
  ),
)
const shell = await Bash.create({ fs: MemoryFileSystem.create(), cwd: '/workspace' })
const hand = await Hand.connect(module, {
  url: process.env.URL!,
  token: process.env.TOKEN!,
  name: 'bench',
  workspace: shell.workspace(),
  cwd: shell.cwd,
})
await hand.closed

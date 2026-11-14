import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { root } from './wasm.mjs'

export const pin = JSON.parse(readFileSync(join(root, 'psh-revision.json'), 'utf8'))

const paths = [
  'Cargo.toml',
  'Cargo.lock',
  'crates/core/bytes',
  'crates/core/memchr',
  'crates/core/shell',
  'crates/core/sys',
  'crates/patches/psh',
]
const workspace = join('crates', 'patches', 'psh')

function run(command, cwd) {
  const result = spawnSync(command[0], command.slice(1), { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function source() {
  if (process.env.NANOCODE_PSH_SOURCE) return process.env.NANOCODE_PSH_SOURCE

  const directory = join(root, 'target', 'psh-source', pin.revision)
  if (existsSync(join(directory, workspace, 'Cargo.toml'))) return directory

  const sdk = join(root, '..', 'nanocodex')
  const held = spawnSync('git', ['cat-file', '-e', pin.revision + '^{commit}'], { cwd: sdk })
  if (held.status !== 0) run(['git', 'fetch', '--depth', '1', pin.repository, pin.revision], sdk)

  const partial = directory + '.partial'
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(partial, { recursive: true })
  run(
    [
      'sh',
      '-c',
      'revision=$1; shift; git archive "$revision" "$@" | tar -x -C "$0"',
      partial,
      pin.revision,
      ...paths,
    ],
    sdk,
  )
  renameSync(partial, directory)
  return directory
}

export function build() {
  const target = join(root, 'target', 'psh')
  run(
    [
      'cargo',
      'build',
      '--locked',
      '-p',
      'psh-wasm-core',
      '--target',
      'wasm32-unknown-unknown',
      '--profile',
      'wasm',
      '--target-dir',
      target,
    ],
    join(source(), workspace),
  )
  return join(target, 'wasm32-unknown-unknown', 'wasm', 'psh_wasm_core.wasm')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(build())

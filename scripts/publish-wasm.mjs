import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assetName,
  current,
  fingerprint,
  manifest,
  manifestName,
  outputs,
  repository,
  root,
  tag,
} from './wasm.mjs'

const args = process.argv.slice(2)
const upload = args.includes('--upload')
const from = args.find((argument) => !argument.startsWith('--'))
const print = fingerprint()
const scratch = mkdtempSync(join(tmpdir(), 'nanocode-wasm-'))
const run = (command, options = {}) => {
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  return result.status === 0
}

try {
  let directory = join(root, 'dist')
  if (from && statSync(from).isFile()) {
    if (!run(['tar', '-xzf', resolve(from), '-C', scratch])) process.exit(1)
    directory = join(scratch, 'package', 'dist')
  } else if (from) {
    directory = resolve(from)
  } else if (!current(directory, print)) {
    console.error(
      'dist/ does not hold the WASM build ' +
        print +
        ': run node scripts/build.mjs, or pass a build-<commit> tarball of a commit with the same Rust inputs',
    )
    process.exit(1)
  }
  const files = join(scratch, 'files')
  mkdirSync(files)
  for (const name of outputs) cpSync(join(directory, name), join(files, name))
  writeFileSync(join(files, manifestName), JSON.stringify(manifest(files, print), null, 2) + '\n')
  mkdirSync(join(root, 'output'), { recursive: true })
  const asset = join(root, 'output', assetName(print))
  if (
    !run(['tar', '-czf', asset, '-C', files, ...outputs, manifestName], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
  )
    process.exit(1)
  console.log(asset)
  if (upload) {
    const exists = () =>
      spawnSync('gh', ['release', 'view', tag(print), '--repo', repository], { stdio: 'ignore' })
        .status === 0
    if (exists()) {
      console.log(tag(print) + ' already exists')
    } else {
      const target = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).stdout.trim()
      const created = run([
        'gh',
        'release',
        'create',
        tag(print),
        asset,
        '--repo',
        repository,
        ...(target ? ['--target', target] : []),
        '--title',
        'nanocode-ts WASM ' + print,
        '--notes',
        'WASM build outputs (' +
          outputs.join(', ') +
          ') for Rust inputs with fingerprint ' +
          print +
          ". npm's prepare script downloads them when a host installs github:" +
          repository +
          '#<commit>.',
        '--latest=false',
      ])
      if (!created && !exists()) process.exit(1)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

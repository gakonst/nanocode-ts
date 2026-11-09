import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprint, repository, root, tag } from './wasm.mjs'

const run = (command) => {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const read = (command) =>
  spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8' }).stdout.trim()

if (spawnSync('git', ['diff', '--quiet', 'HEAD'], { cwd: root }).status !== 0) {
  console.error('the checkout has uncommitted changes: commit and push them, then release')
  process.exit(1)
}
const sha = read(['git', 'rev-parse', 'HEAD'])
const short = sha.slice(0, 7)
const print = fingerprint()
const sdk = JSON.parse(readFileSync(join(root, 'sdk-revision.json'), 'utf8')).revision
const scratch = mkdtempSync(join(tmpdir(), 'nanocode-ts-'))

try {
  rmSync(join(root, 'dist'), { recursive: true, force: true })
  run(['npm', 'ci', '--ignore-scripts'])
  if (spawnSync('gh', ['release', 'view', tag(print), '--repo', repository], { stdio: 'ignore' }).status !== 0) {
    run(['node', 'scripts/build.mjs'])
    run(['node', 'scripts/publish-wasm.mjs', '--upload'])
  }
  run(['npm', 'run', 'prepare'])
  run(['npm', 'run', 'check:types'])
  const tarball = join(scratch, 'nanocode-ts-' + short + '.tgz')
  renameSync(join(scratch, read(['npm', 'pack', '--ignore-scripts', '--silent', '--pack-destination', scratch]).split('\n').pop()), tarball)
  run([
    'gh',
    'release',
    'create',
    'build-' + short,
    tarball,
    '--repo',
    repository,
    '--target',
    sha,
    '--title',
    'nanocode-ts ' + short,
    '--notes',
    'Built from ' +
      sha +
      ' against SDK ' +
      sdk +
      ' with WASM build ' +
      print +
      '. Install with `npm install https://github.com/' +
      repository +
      '/releases/download/build-' +
      short +
      '/nanocode-ts-' +
      short +
      '.tgz` or `npm install github:' +
      repository +
      '#' +
      sha +
      '`.',
  ])
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

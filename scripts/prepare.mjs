import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assetUrl,
  current,
  fingerprint,
  manifestName,
  outputs,
  root,
  sha256,
  tag,
} from './wasm.mjs'

const print = fingerprint()
const dist = join(root, 'dist')

async function download(source) {
  if (!/^https?:/.test(source)) {
    const path = source.startsWith('file:') ? fileURLToPath(source) : source
    return existsSync(path) ? readFileSync(path) : undefined
  }
  const response = await fetch(source)
  if (response.status === 404) return undefined
  if (!response.ok)
    throw new Error(
      'nanocode-ts: GET ' + source + ' failed: ' + response.status + ' ' + response.statusText,
    )
  return Buffer.from(await response.arrayBuffer())
}

function unpack(bytes, source) {
  const scratch = mkdtempSync(join(tmpdir(), 'nanocode-wasm-'))
  try {
    writeFileSync(join(scratch, 'asset.tgz'), bytes)
    mkdirSync(join(scratch, 'files'))
    const extracted = spawnSync(
      'tar',
      ['-xzf', join(scratch, 'asset.tgz'), '-C', join(scratch, 'files')],
      { stdio: 'inherit' },
    )
    if (extracted.error) throw extracted.error
    if (extracted.status !== 0) throw new Error('nanocode-ts: could not unpack ' + source)
    if (!current(join(scratch, 'files'), print))
      throw new Error('nanocode-ts: ' + source + ' does not hold the WASM build ' + print)
    mkdirSync(dist, { recursive: true })
    for (const name of [...outputs, manifestName])
      cpSync(join(scratch, 'files', name), join(dist, name))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function buildable() {
  const cargo = spawnSync('cargo', ['--version'], { cwd: root, stdio: 'ignore' })
  return cargo.status === 0 && existsSync(join(root, '..', 'nanocodex', 'Cargo.toml'))
}

if (current(dist, print)) {
  console.log('nanocode-ts: WASM build ' + print + ' is current')
} else {
  const source = process.env.NANOCODE_TS_WASM_URL || assetUrl(print)
  const started = Date.now()
  const bytes = await download(source)
  if (bytes) {
    unpack(bytes, source)
    console.log(
      'nanocode-ts: WASM build ' +
        print +
        ' from ' +
        source +
        ' in ' +
        (Date.now() - started) +
        ' ms',
    )
  } else if (buildable()) {
    console.log('nanocode-ts: no release ' + tag(print) + ', building the WASM from source')
    const built = spawnSync(process.execPath, ['scripts/build.mjs'], {
      cwd: root,
      stdio: 'inherit',
    })
    if (built.error) throw built.error
    if (built.status !== 0) process.exit(built.status ?? 1)
  } else {
    console.error(
      'nanocode-ts: no prebuilt WASM for fingerprint ' +
        print +
        ' (' +
        source +
        ' not found) and no Rust toolchain with ../nanocodex to build it. The release workflow publishes ' +
        tag(print) +
        " when this commit's Rust inputs reach main; pin a commit whose release exists, or set NANOCODE_TS_WASM_URL to a nanocode-wasm tarball.",
    )
    process.exit(1)
  }
}

function typescript() {
  const paths = [
    'package.json',
    'package-lock.json',
    'scripts/zyzz.mjs',
    'scripts/pyodide.mjs',
    ...readdirSync(root).filter((name) => /^tsconfig.*\.json$/.test(name)),
  ]
  for (const entry of readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && !entry.name.endsWith('.rs'))
      paths.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
  }
  return sha256(
    [
      print,
      ...paths
        .filter((path) => existsSync(join(root, path)))
        .sort()
        .map((path) => path + ' ' + sha256(readFileSync(join(root, path)))),
    ].join('\n'),
  )
}

const stamp = join(root, 'output', 'typescript-build-fingerprint')
const inputs = typescript()
if (
  existsSync(join(dist, 'index.js')) &&
  existsSync(stamp) &&
  readFileSync(stamp, 'utf8') === inputs
) {
  console.log('nanocode-ts: TypeScript build is current')
} else {
  rmSync(stamp, { force: true })
  const built = spawnSync('npm run build:ts', { cwd: root, stdio: 'inherit', shell: true })
  if (built.error) throw built.error
  if (built.status !== 0) process.exit(built.status ?? 1)
  mkdirSync(join(root, 'output'), { recursive: true })
  writeFileSync(stamp, inputs)
}

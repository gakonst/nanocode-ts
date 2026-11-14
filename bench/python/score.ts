import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Bash, MemoryFileSystem } from '../../src/bash/index.ts'

const root = process.env.CAPI ?? join(process.env.HOME ?? '', 'rpw/capi')
const module = new WebAssembly.Module(readFileSync(process.argv[2] ?? 'dist/python.wasm'))
const psh = new WebAssembly.Module(readFileSync('dist/psh.wasm'))
const kept = new Set(['tokio', 'mio', 'socket2', 'futures-core', 'futures-sink', 'futures-task', 'futures-util', 'futures-channel', 'futures-io', 'futures-macro', 'tracing', 'tracing-core', 'slab', 'pin-project-lite', 'serde', 'serde_core', 'serde_derive', 'syn', 'quote', 'proc-macro2', 'unicode-ident'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

const packages = readdirSync(join(root, 'x')).sort()
const rows: { name: string; extensions: number; imported: number }[] = []
for (const name of packages) {
  const base = join(root, 'x', name)
  const files = walk(base).filter((path) => !path.includes('.dist-info') && !path.includes('.libs/'))
  const extensions = files.filter((path) => path.endsWith('.so')).map((path) => relative(base, path).split('.')[0]!.replaceAll('/', '.'))
  const fs = MemoryFileSystem.create()
  const bash = await Bash.create({ fs, cwd: '/workspace', psh, python: { module, stepsPerMs: 42000 }, limits: { timeoutMs: 60000 } })
  await bash.exec('mkdir -p /workspace /site')
  const sources = files.filter((path) => path.endsWith('.py'))
  const dirs = [...new Set(sources.map((path) => ('/site/' + relative(base, path)).replace(/\/[^/]*$/, '')))]
  if (dirs.length) await bash.exec('mkdir -p ' + dirs.join(' '))
  for (const path of sources) await fs.write('/site/' + relative(base, path), readFileSync(path))
  await fs.write('/workspace/probe.py', new TextEncoder().encode('import importlib, sys\nsys.path.insert(0, "/site")\nok = 0\nfor name in sys.argv[1:]:\n    try:\n        ok += not getattr(importlib.import_module(name), "__file__", "").endswith(".py")\n    except BaseException:\n        pass\nprint(ok)\n'))
  const result = await bash.exec('python3 probe.py ' + extensions.join(' '))
  rows.push({ name, extensions: extensions.length, imported: Number(result.stdout.trim()) || 0 })
}

const symbols = readFileSync(join(root, 'freq.txt'), 'utf8').trim().split('\n').length
const lock = readFileSync('python/Cargo.lock', 'utf8')
const external = [...lock.matchAll(/name = "([^"]+)"\nversion = "[^"]+"\nsource = "registry/g)].map((match) => match[1]!).filter((name) => !kept.has(name))
const limits = await (async () => {
  const fs = MemoryFileSystem.create()
  const bash = await Bash.create({ fs, python: { module, stepsPerMs: 42000 }, limits: { maxMemoryBytes: 48 << 20, timeoutMs: 2000 } })
  const checks: [string, number][] = [['python3 -c "print(1)"', 0], ['python3 -c "s=\'a \'*30000000; print(len(s.split()))"', 126], ['python3 -c "while True: pass"', 126], ['python3 -c "import json; json.loads(\'x\')"', 1]]
  let passed = 0
  for (const [script, status] of checks) if ((await bash.exec(script)).exitCode === status) passed++
  return passed + '/' + checks.length
})()
const imported = rows.reduce((sum, row) => sum + row.imported, 0)
const extensions = rows.reduce((sum, row) => sum + row.extensions, 0)
console.log(JSON.stringify({ imported, extensions, packages: rows.filter((row) => row.extensions && row.imported === row.extensions).length + '/' + rows.length, capi: '0/' + symbols, bytes: statSync(process.argv[2] ?? 'dist/python.wasm').size, external: external.length, externalCrates: external, limits, rows }))

import { spawnSync } from 'node:child_process'
import { cpSync, readdirSync, rmSync } from 'node:fs'

rmSync('output/zyzz-react', { force: true, recursive: true })
for (const file of readdirSync('dist/react'))
  if (file.startsWith('zyzz.') || /\.(css|css\.map|zyzz\.json)$/.test(file))
    rmSync('dist/react/' + file)
const result = spawnSync(
  'npx',
  [
    'zyzz',
    'build',
    'dist/react',
    '--out-dir',
    'output/zyzz-react',
    '--package-id',
    'nanocode-ts',
    '--minify',
    '--external',
    'react',
    '--external',
    'react/*',
    '--external',
    '../client.js',
    '--external',
    '../machines/index.js',
    '--external',
    '../machines/local.js',
  ],
  { stdio: 'inherit' },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
cpSync('output/zyzz-react', 'dist/react', { recursive: true })

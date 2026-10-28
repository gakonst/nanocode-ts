import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    ignorePatterns: [
      '**/*.md',
      '**/*.toml',
      'dist/**',
      'output/**',
      'scripts/build.mjs',
      'scripts/wasm.mjs',
      'src/wasm/**',
      'target/**',
    ],
    printWidth: 100,
    semi: false,
    singleQuote: true,
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns: [
      'dist/**',
      'output/**',
      'scripts/build.mjs',
      'scripts/wasm.mjs',
      'src/wasm/**',
      'target/**',
    ],
  },
})

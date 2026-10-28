/**
 * Vite+ configuration for formatting, linting, and the integration suites.
 *
 * @module
 */
import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    // The WebAssembly fingerprint hashes `src/wasm` and the two build scripts byte for byte.
    ignorePatterns: [
      '**/*.md',
      '**/*.toml',
      'bench/out/**',
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
      'bench/out/**',
      'dist/**',
      'output/**',
      'scripts/build.mjs',
      'scripts/wasm.mjs',
      'src/wasm/**',
      'target/**',
    ],
  },
  test: {
    hookTimeout: 60_000,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 60_000,
  },
})

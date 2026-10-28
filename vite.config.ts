/**
 * Vite+ configuration for formatting, linting, and the integration suites.
 *
 * @module
 */
import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    // QuickJS sources are embedded with `include_str!`, and Markdown inline code holds escapes.
    ignorePatterns: [
      '**/*.md',
      '**/*.toml',
      'bench/out/**',
      'dist/**',
      'output/**',
      'src/wasm/**',
      'target/**',
    ],
    printWidth: 100,
    semi: false,
    singleQuote: true,
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns: ['src/wasm/**', 'dist/**', 'output/**', 'target/**', 'bench/out/**'],
  },
  test: {
    hookTimeout: 60_000,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 60_000,
  },
})

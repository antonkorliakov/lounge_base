import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Insurance, not the fix: per-test DB setup now clones a cached, already-
    // migrated PGlite template (`src/db/__tests__/harness.ts`) instead of
    // booting PGlite and replaying every migration statement per test, so
    // steady-state cost is small. This only needs to cover the rare cold-start
    // case where the template itself has to be built (measured ~0.8s
    // uncontended, ~3.4s when several workers raced to build it at once on a
    // cold cache) under a loaded machine — comfortably above that, not a
    // number picked to make timeouts stop happening regardless of cause.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})

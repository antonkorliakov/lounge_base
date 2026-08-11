import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'npm run dev',
    // `url` (unlike `port`) requires a 2xx/3xx response to consider the
    // server "ready" — but this app has no root `page.tsx` (only `/f/
    // [token]` and the API route), so `/` always 404s and a `url`-based
    // check would spin for the full `timeout` every run. `port` only checks
    // that something is listening, which is all readiness means here.
    port: 3000,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})

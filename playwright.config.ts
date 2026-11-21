// Playwright settings for the browser smoke tests in e2e/ (npm run
// test:e2e).  The tests use the build in dist/, served by scripts/serve.mjs
// with the same headers as a hosted site, so run `npm run build` first.
// To test a site that's already up, such as a new deploy, set SUPERLENS_URL
// to its address, ending in a slash:
//
//   SUPERLENS_URL=https://example.com/ npm run test:e2e

import { existsSync } from "node:fs"
import { defineConfig, devices } from "@playwright/test"

// Not serve.mjs's default of 8080, so a dev server already running there
// doesn't keep the tests from starting their own.
const port = 8137
const site = process.env.SUPERLENS_URL

// Without a build, the server would answer "not found" and Playwright would
// wait a minute for it before failing.
if (!site && !existsSync(new URL("dist/index.html", import.meta.url))) {
  throw new Error("dist/index.html is missing: run `npm run build` first")
}

export default defineConfig({
  testDir: "e2e",
  // Each test's page loads its own copy of the engine, so run one at a time.
  workers: 1,
  // Loading the engine (about 90 MB) can take a while on a slow machine.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: site ?? `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: site
    ? undefined
    : {
        command: `node scripts/serve.mjs --port ${port}`,
        url: `http://localhost:${port}/`,
        // Always start a server for dist/, rather than testing whatever is
        // already on the port.
        reuseExistingServer: false,
      },
})

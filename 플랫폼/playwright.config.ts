import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const PORT = 7790;
// Cloud sandboxes ship a preinstalled Chromium here; on a Windows PC use the built-in Edge instead.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1366, height: 768 },
    // Never run `playwright install`.
    ...(existsSync(SANDBOX_CHROMIUM) ? { launchOptions: { executablePath: SANDBOX_CHROMIUM } } : { channel: 'msedge' }),
  },
  // A fresh ledger for every run (npm run e2e builds the pages first).
  webServer: {
    command: `node tests/e2e/serve.ts ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
  },
});

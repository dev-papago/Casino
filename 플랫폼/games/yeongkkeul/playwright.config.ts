import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const PORT = 5198;
// Cloud sandboxes ship a preinstalled Chromium here; on a Windows PC use the built-in Edge instead.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1366, height: 768 },
    // Never run `playwright install`.
    ...(existsSync(SANDBOX_CHROMIUM) ? { launchOptions: { executablePath: SANDBOX_CHROMIUM } } : { channel: 'msedge' }),
  },
  // The smoke test runs on the dev server.
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
  },
});

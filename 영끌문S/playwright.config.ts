import { defineConfig } from '@playwright/test';

const PORT = 5198;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1366, height: 768 },
    // Use the preinstalled browser; never run `playwright install`.
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
  // The smoke test runs on the dev server.
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
  },
});

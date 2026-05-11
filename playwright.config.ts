import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const localChromePath = '/usr/bin/google-chrome';
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (existsSync(localChromePath) ? localChromePath : undefined);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    colorScheme: 'light',
    launchOptions: chromiumExecutablePath
      ? { executablePath: chromiumExecutablePath }
      : undefined,
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    reuseExistingServer: !process.env.CI,
    url: 'http://127.0.0.1:5173',
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

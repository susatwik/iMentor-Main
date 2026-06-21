// @ts-check
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 90000,
  expect: { timeout: 30000 },
  use: {
    baseURL: 'http://localhost:3005',
    headless: true,
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15000,
  },
  webServer: {
    command: 'cd frontend && npm run dev',
    url: 'http://localhost:3005',
    timeout: 120000,
    reuseExistingServer: true,
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], channel: 'firefox' },
    },
  ],
});

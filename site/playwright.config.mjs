import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './browser', fullyParallel: true, forbidOnly: Boolean(process.env.CI), retries: 0,
  workers: process.env.CI ? 2 : undefined,
  use: { baseURL: 'http://127.0.0.1:4317', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'mobile-webkit', testMatch: ['**/visitor-journey.spec.mjs','**/staff-desk.spec.mjs'],
      grep: /phone viewport|viewport shrinks|staff member reviews/,
      use: { ...devices['iPhone 13'], launchOptions: { args: [] } } },
  ],
  webServer: { command: 'wrangler dev --local --ip 127.0.0.1 --port 4317', url: 'http://127.0.0.1:4317', reuseExistingServer: false, timeout: 30000 },
});

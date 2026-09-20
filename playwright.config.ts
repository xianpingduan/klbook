import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  workers: 1,
  retries: 0,
  use: { headless: true, actionTimeout: 10000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'edge', use: { browserName: 'chromium', channel: 'msedge' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } }
  ]
});

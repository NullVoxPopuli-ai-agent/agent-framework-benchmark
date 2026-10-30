import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: '../test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.BASE_URL ?? 'http://localhost:3100',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'pages', testIgnore: /writes\.spec/ },
    // Writes change the data other tests check, so they run after them.
    { name: 'writes', testMatch: /writes\.spec/, dependencies: ['pages'] },
  ],
});

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'preview.spec.ts',
  outputDir: 'test-results/preview',
  workers: 1,
  timeout: 30_000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/preview', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:5175/gomoku/', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL || undefined },
    },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'npm run build && npm run check:production && npm run preview -- --port 5175',
    env: { VITE_SITE_MODE: 'preview', VITE_API_ORIGIN: '', VITE_BASE_PATH: '/gomoku/' },
    url: 'http://127.0.0.1:5175/gomoku/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})

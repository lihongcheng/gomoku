import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'game.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL || undefined },
    },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: [
    {
      command: '../backend/.venv/bin/python -m gomoku',
      cwd: '../backend',
      url: 'http://127.0.0.1:8001/health',
      reuseExistingServer: false,
      env: {
        PORT: '8001',
        GOMOKU_FRONTEND_URL: 'http://127.0.0.1:5173/',
        GOMOKU_ALLOWED_ORIGINS: '["http://127.0.0.1:5173"]',
        GOMOKU_SOURCE_BURST: '10000',
        GOMOKU_COMMAND_BURST: '1000',
        GOMOKU_UNDO_COOLDOWN: '0.1',
        GOMOKU_UNDO_SECONDS: '3',
        GOMOKU_RECONNECT_SECONDS: '8',
      },
      timeout: 30_000,
    },
    {
      command:
        'VITE_SITE_MODE=live VITE_BASE_PATH=/ VITE_API_ORIGIN=http://127.0.0.1:8001 npm run build && npm run preview',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})

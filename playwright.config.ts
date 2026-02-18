import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './playwright',
  timeout: 30_000,
  reporter: 'list',
  workers: 1, // serialize — tests share a single Postgres database
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
  },
  webServer: {
    command: 'NODE_ENV=test tsx server/index.ts',
    port: 3000,
    reuseExistingServer: !process.env.CI,
  },
})

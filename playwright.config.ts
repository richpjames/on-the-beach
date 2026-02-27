import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright",
  timeout: 30_000,
  reporter: "list",
  workers: 1, // serialize — tests share a single SQLite database
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
  },
  webServer: {
    command:
      "PORT=4173 NODE_ENV=test DATABASE_PATH=/tmp/on_the_beach.playwright.db bun server/db/seed.ts && PORT=4173 NODE_ENV=test DATABASE_PATH=/tmp/on_the_beach.playwright.db bun server/index.ts",
    port: 4173,
    reuseExistingServer: false,
  },
});

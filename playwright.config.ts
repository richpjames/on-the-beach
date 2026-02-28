import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright",
  timeout: 30_000,
  reporter: "list",
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  use: {
    headless: true,
  },
});

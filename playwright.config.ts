import { defineConfig, devices } from "@playwright/test";
import os from "node:os";

function resolveWorkers(): number {
  const fromEnv = Number(process.env.PLAYWRIGHT_WORKERS);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }

  // Keep CI deterministic and conservative; use more local workers by default.
  if (process.env.CI) {
    return 4;
  }

  return Math.min(6, Math.max(2, os.availableParallelism() - 1));
}

export default defineConfig({
  testDir: "./playwright",
  timeout: 30_000,
  reporter: "list",
  fullyParallel: true,
  workers: resolveWorkers(),
  use: {
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /ui-percy\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--no-sandbox"] },
      },
    },
    {
      name: "ui-chrome-desktop",
      testMatch: /ui-percy\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--no-sandbox"] },
      },
    },
    {
      name: "ui-chrome-mobile",
      testMatch: /ui-percy\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        launchOptions: { args: ["--no-sandbox"] },
      },
    },
    {
      name: "ui-safari-desktop",
      testMatch: /ui-percy\.spec\.ts/,
      use: {
        ...devices["Desktop Safari"],
      },
    },
    {
      name: "ui-safari-mobile",
      testMatch: /ui-percy\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
      },
    },
  ],
});

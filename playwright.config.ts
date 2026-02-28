import { defineConfig } from "@playwright/test";
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
});

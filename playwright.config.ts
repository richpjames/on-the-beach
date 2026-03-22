import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

// Resolve the locally-cached Chromium binary. CI may not have network access
// to download the revision expected by the installed playwright-core version,
// so we fall back to whatever headless-shell revision is already present.
function resolveChromeExecutable(): string | undefined {
  const cacheRoot = path.join(os.homedir(), ".cache", "ms-playwright");
  const candidates = [
    // headless shell variants (newest first preference)
    path.join(
      cacheRoot,
      "chromium_headless_shell-1208",
      "chrome-headless-shell-linux64",
      "chrome-headless-shell",
    ),
    path.join(cacheRoot, "chromium_headless_shell-1194", "chrome-linux", "headless_shell"),
    // full chromium fallback
    path.join(cacheRoot, "chromium-1194", "chrome-linux", "chrome"),
  ];
  return candidates.find(existsSync);
}

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
  reporter: [
    ["list"],
    // HTML report is used by the visual-regression workflow to publish diffs to
    // GitHub Pages. The report is written to playwright-report/ by default.
    ["html", { open: "never" }],
  ],
  fullyParallel: true,
  workers: resolveWorkers(),
  // Remove the platform suffix from snapshot filenames — we always run on Linux
  // in CI, so the suffix adds noise without useful disambiguation.
  snapshotPathTemplate: "{testDir}/{testFileDir}/{testFileName}-snapshots/{arg}-{projectName}{ext}",
  use: {
    headless: true,
  },
  projects: [
    // -----------------------------------------------------------------
    // Smoke E2E tests — Chromium only, all playwright/*.spec.ts files.
    // -----------------------------------------------------------------
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--no-sandbox"],
          executablePath: resolveChromeExecutable(),
        },
      },
    },

    // -----------------------------------------------------------------
    // Visual regression tests — Chromium, desktop and mobile viewports.
    //
    // The previous Percy setup also ran Safari (Desktop Safari + iPhone 13).
    // WebKit is intentionally omitted here to avoid the extra CI cost and
    // cross-platform rendering noise; Chromium coverage catches most visual
    // regressions in practice.
    //
    // TODO: re-add WebKit projects below if cross-browser visual coverage
    // becomes a requirement:
    //   { name: "visual-safari-desktop", testDir: "./tests/visual",
    //     use: { ...devices["Desktop Safari"] } }
    //   { name: "visual-safari-mobile", testDir: "./tests/visual",
    //     use: { ...devices["iPhone 13"] } }
    // -----------------------------------------------------------------
    {
      name: "visual-desktop",
      testDir: "./tests/visual",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          args: ["--no-sandbox"],
          executablePath: resolveChromeExecutable(),
        },
      },
    },
    {
      name: "visual-mobile",
      testDir: "./tests/visual",
      use: {
        ...devices["Pixel 7"],
        launchOptions: {
          args: ["--no-sandbox"],
          executablePath: resolveChromeExecutable(),
        },
      },
    },
  ],
});

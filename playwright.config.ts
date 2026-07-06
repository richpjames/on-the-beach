import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";

// Resolve the locally-cached Chromium binary. CI may not have network access
// to download the revision expected by the installed playwright-core version,
// so we fall back to whatever chromium/headless-shell revision is already
// present in the browsers cache (honouring PLAYWRIGHT_BROWSERS_PATH).
function resolveChromeExecutable(): string | undefined {
  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter((root): root is string => Boolean(root));

  for (const cacheRoot of cacheRoots) {
    if (!existsSync(cacheRoot)) continue;
    // Newest revision first, headless shell preferred.
    const entries = readdirSync(cacheRoot).sort().reverse();
    for (const prefix of ["chromium_headless_shell-", "chromium-"]) {
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue;
        const candidates = [
          path.join(cacheRoot, entry, "chrome-headless-shell-linux64", "chrome-headless-shell"),
          path.join(cacheRoot, entry, "chrome-linux", "headless_shell"),
          path.join(cacheRoot, entry, "chrome-linux", "chrome"),
        ];
        const found = candidates.find(existsSync);
        if (found) return found;
      }
    }
  }
  return undefined;
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
  // Build the SvelteKit app once; workers boot servers from build/index.js.
  globalSetup: "./playwright/global-setup.ts",
  reporter: [
    ["list"],
    // HTML report is used by the visual-regression workflow to publish diffs to
    // GitHub Pages. The report is written to playwright-report/ by default.
    ["html", { open: "never" }],
  ],
  fullyParallel: true,
  workers: resolveWorkers(),
  // Retry transient CI timing flakes (e.g. animated drag/reorder under CPU
  // contention) without masking real failures locally, where a fail should
  // fail immediately.
  retries: process.env.CI ? 2 : 0,
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

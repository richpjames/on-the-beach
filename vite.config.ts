import { readFileSync } from "node:fs";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import pkg from "./package.json";

// The Deploy workflow tags each deployed commit (v1.0.N) — branch protection
// rules out a bump commit to main. The Docker build writes that tag into
// .app-version; dev and test builds have no such file and use package.json.
function appVersion(): string {
  try {
    const tagged = readFileSync(".app-version", "utf8").trim();
    if (tagged) return tagged;
  } catch {
    // No .app-version — not a tagged Docker build.
  }
  return pkg.version;
}

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 3000,
  },
  ssr: {
    // The database layer uses Bun's built-in SQLite driver; the server runs
    // under Bun in every environment (dev, tests, Docker).
    external: ["bun:sqlite"],
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
});

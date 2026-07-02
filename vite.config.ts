import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import pkg from "./package.json";

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
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});

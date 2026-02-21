import { defineConfig } from "vite";
import pkg from "./package.json";

export default defineConfig({
  build: {
    outDir: "dist",
    target: "esnext",
    sourcemap: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});

import { readFile } from "node:fs/promises";
import path from "node:path";

interface PageAssets {
  cssHref: string;
  scriptSrc: string;
}

let assetsCache: PageAssets | null = null;

export async function getPageAssets(): Promise<PageAssets> {
  if (process.env.NODE_ENV !== "production") {
    return {
      cssHref: "/src/styles/main.css",
      scriptSrc: "/src/main.ts",
    };
  }

  if (assetsCache) return assetsCache;

  try {
    const html = await readFile(path.resolve("dist/index.html"), "utf-8");
    const cssMatch = html.match(/href="(\/assets\/[^"]+\.css)"/);
    const jsMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
    assetsCache = {
      cssHref: cssMatch?.[1] ?? "/assets/index.css",
      scriptSrc: jsMatch?.[1] ?? "/assets/index.js",
    };
  } catch {
    assetsCache = {
      cssHref: "/assets/index.css",
      scriptSrc: "/assets/index.js",
    };
  }

  return assetsCache;
}

import { Hono } from "hono";
import { musicItemRoutes } from "./routes/music-items";
import { stackRoutes } from "./routes/stacks";
import { ingestRoutes } from "./routes/ingest";
import { releaseRoutes } from "./routes/release";
import { settingsRoutes } from "./routes/settings";
import { rssRoutes } from "./routes/rss";

/**
 * The REST API and RSS feeds are served by Hono route modules, mounted into
 * SvelteKit through the catch-all endpoints in `src/routes/api` and
 * `src/routes/feed`. Pages (/, /s/:id/:name, /r/:id) are SvelteKit routes.
 */
export const apiApp = new Hono();

apiApp.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path} error:`, err);
  return c.json({ error: "Internal server error" }, 500);
});

apiApp.route("/api/music-items", musicItemRoutes);
apiApp.route("/api/stacks", stackRoutes);
apiApp.route("/api/ingest", ingestRoutes);
apiApp.route("/api/release", releaseRoutes);
apiApp.route("/api/settings", settingsRoutes);
apiApp.route("/feed", rssRoutes);

// Test-only routes, enabled when the server runs under NODE_ENV=test
// (e.g. the Playwright worker servers).
if (process.env["NODE_ENV"] === "test") {
  const { testRoutes } = await import("./routes/test");
  apiApp.route("/api/__test__", testRoutes);
}

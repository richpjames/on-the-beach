import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { musicItemRoutes } from "./routes/music-items";
import { stackRoutes } from "./routes/stacks";
import { ingestRoutes } from "./routes/ingest";

const app = new Hono();

// ---------- API routes ----------
app.route("/api/music-items", musicItemRoutes);
app.route("/api/stacks", stackRoutes);
app.route("/api/ingest", ingestRoutes);

// ---------- Test-only routes ----------
if (process.env.NODE_ENV === "test") {
  const { testRoutes } = await import("./routes/test");
  app.route("/api/__test__", testRoutes);
}

// ---------- Environment ----------
const isDev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 3000;

if (isDev) {
  // ---- Development: Vite dev server as middleware ----
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
    },
    appType: "spa",
  });

  // Proxy non-API requests to Vite's middleware via a Node compat server
  const { createServer: createHttpServer } = await import("node:http");
  const { getRequestListener } = await import("@hono/node-server");

  const honoListener = getRequestListener(app.fetch);

  const server = createHttpServer((req, res) => {
    if (req.url?.startsWith("/api/")) {
      honoListener(req, res);
      return;
    }
    vite.middlewares.handle(req, res);
  });

  server.listen(port, () => {
    console.log(`Dev server running on http://localhost:${port}`);
  });
} else {
  // ---- Production: serve built static files ----
  app.use("*", serveStatic({ root: "./dist" }));
  // SPA fallback — serve index.html for any non-API, non-static route
  app.use("*", serveStatic({ root: "./dist", path: "index.html" }));

  Bun.serve({
    port,
    fetch: app.fetch,
  });
  console.log(`Server running on http://localhost:${port}`);
}

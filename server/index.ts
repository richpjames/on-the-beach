import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { musicItemRoutes } from "./routes/music-items";
import { stackRoutes } from "./routes/stacks";
import { ingestRoutes } from "./routes/ingest";
import { releaseRoutes } from "./routes/release";
import { releasePageRoutes } from "./routes/release-page";
import { rssRoutes } from "./routes/rss";
import { getUploadsDir, rewriteUploadsRequestPath } from "./uploads";

const app = new Hono();
const uploadsDir = getUploadsDir();

// ---------- Request logging ----------
app.use("*", logger());

app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path} error:`, err);
  return c.json({ error: "Internal server error" }, 500);
});

// ---------- API routes ----------
app.route("/api/music-items", musicItemRoutes);
app.route("/api/stacks", stackRoutes);
app.route("/api/ingest", ingestRoutes);
app.route("/api/release", releaseRoutes);
app.route("/r", releasePageRoutes);
app.route("/feed", rssRoutes);
app.use(
  "/uploads/*",
  serveStatic({
    root: uploadsDir,
    rewriteRequestPath: rewriteUploadsRequestPath,
  }),
);

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
  const { createServer: createHttpServer } = await import("node:http");
  const { getRequestListener } = await import("@hono/node-server");
  const { createServer: createViteServer } = await import("vite");

  const honoListener = getRequestListener(app.fetch);

  // Create the HTTP server first so it can be passed to Vite for HMR WebSocket attachment,
  // avoiding the "Port undefined" error that occurs when Vite tries to derive the port itself.
  let viteHandle: ((req: unknown, res: unknown) => void) | null = null;
  const server = createHttpServer((req, res) => {
    if (
      req.url?.startsWith("/api/") ||
      req.url?.startsWith("/uploads/") ||
      req.url === "/r" ||
      req.url?.startsWith("/r/")
    ) {
      honoListener(req, res);
      return;
    }
    viteHandle!(req, res);
  });

  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: { server },
    },
    appType: "spa",
  });
  viteHandle = vite.middlewares.handle.bind(vite.middlewares);

  server.listen(port, () => {
    console.log(`Dev server running on http://localhost:${port}`);
    console.log(`Uploads dir: ${uploadsDir}`);
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
  console.log(`Uploads dir: ${uploadsDir}`);
}

// ---------- SMTP ingest (opt-in via SMTP_ENABLED=true) ----------
if (process.env.SMTP_ENABLED === "true") {
  const { startSmtpIngest } = await import("./smtp-ingest");
  startSmtpIngest();
}

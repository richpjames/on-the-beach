import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { musicItemRoutes } from "./routes/music-items";
import { stackRoutes } from "./routes/stacks";
import { ingestRoutes } from "./routes/ingest";
import { releaseRoutes } from "./routes/release";
import { releasePageRoutes } from "./routes/release-page";
import { mainPageRoutes } from "./routes/main-page";
import { rssRoutes } from "./routes/rss";
import { getUploadsDir, rewriteUploadsRequestPath } from "./uploads";
import { processReminders } from "./reminders";

const app = new Hono();
const uploadsDir = getUploadsDir();

// ---------- Request logging ----------
app.use("*", logger());

app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path} error:`, err);
  return c.json({ error: "Internal server error" }, 500);
});

// ---------- Main page (SSR) ----------
app.route("/", mainPageRoutes);

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

// ---------- Reminder cron ----------
// Run reminder processing on startup and then every hour
processReminders().catch((err) => console.error("[reminders] startup run failed:", err));
setInterval(
  () => processReminders().catch((err) => console.error("[reminders] interval run failed:", err)),
  60 * 60 * 1000,
);

// ---------- Test-only routes ----------
if (process.env.NODE_ENV === "test") {
  const { testRoutes } = await import("./routes/test");
  app.route("/api/__test__", testRoutes);
}

// ---------- Environment ----------
const isDev = process.env.NODE_ENV !== "production";
const preferredPort = Number(process.env.PORT) || 3000;

async function findAvailablePort(startPort: number): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(findAvailablePort(startPort + 1)));
    probe.once("listening", () => probe.close(() => resolve(startPort)));
    probe.listen(startPort);
  });
}

const port = await findAvailablePort(preferredPort);
if (port !== preferredPort) {
  console.log(`Port ${preferredPort} in use, using ${port} instead`);
}

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
      req.url === "/" ||
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

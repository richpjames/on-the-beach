import { createServer as createHttpServer } from 'node:http'
import { Hono } from 'hono'
import { getRequestListener } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { musicItemRoutes } from './routes/music-items'
import { stackRoutes } from './routes/stacks'

const app = new Hono()

// ---------- API routes ----------
app.route('/api/music-items', musicItemRoutes)
app.route('/api/stacks', stackRoutes)

// ---------- Test-only routes ----------
if (process.env.NODE_ENV === 'test') {
  const { testRoutes } = await import('./routes/test')
  app.route('/api/__test__', testRoutes)
}

// ---------- Environment ----------
const isDev = process.env.NODE_ENV !== 'production'
const port = Number(process.env.PORT) || 3000

if (isDev) {
  // ---- Development: Vite dev server as middleware ----
  //
  // Strategy:
  //   1. Create a plain Node HTTP server.
  //   2. Pass it to Vite via `server.hmr.server` so that HMR WebSocket
  //      upgrades are handled on the same port (no separate WS server).
  //   3. Route incoming requests: /api/* -> Hono, everything else -> Vite
  //      (HTML, JS, CSS, HMR, etc.)

  const honoListener = getRequestListener(app.fetch)

  const server = createHttpServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      honoListener(req, res)
      return
    }
    // Vite middleware is attached after createViteServer resolves (below).
    // By the time any request arrives the middleware is ready.
    viteMiddleware(req, res)
  })

  // Placeholder until Vite is ready — should never be hit because
  // createViteServer resolves before the server starts listening.
  let viteMiddleware: (...args: any[]) => void = (_req: any, res: any) => {
    res.statusCode = 503
    res.end('Vite is starting...')
  }

  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: { server },
    },
    appType: 'spa',
  })

  viteMiddleware = vite.middlewares.handle.bind(vite.middlewares)

  server.listen(port, () => {
    console.log(`Dev server running on http://localhost:${port}`)
  })
} else {
  // ---- Production: serve built static files ----
  app.use('*', serveStatic({ root: './dist' }))
  // SPA fallback — serve index.html for any non-API, non-static route
  app.use('*', serveStatic({ root: './dist', path: 'index.html' }))

  const server = createHttpServer(getRequestListener(app.fetch))
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`)
  })
}

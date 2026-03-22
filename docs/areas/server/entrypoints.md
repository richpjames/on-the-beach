# Server Entry Points

## Runtime shape

- `server/index.ts` is the main Bun entrypoint.
- It mounts Hono route groups for `/`, `/api/*`, `/r/*`, `/feed`, and `/uploads/*`.
- In development it creates a Node HTTP server and attaches Vite middleware for HMR.
- In production it serves `dist/` and falls back to `index.html` for SPA routes.

## Special cases

- Request logging is enabled globally with `hono/logger`.
- Errors are normalized to a JSON `500` response inside `app.onError`.
- Test-only helpers are mounted at `/api/__test__` when `NODE_ENV === "test"`.

## Why this matters

The repo is a single deployable service. The backend serves API traffic, SSR for the first page load, static frontend assets, uploaded artwork, and optional email ingest from one process.

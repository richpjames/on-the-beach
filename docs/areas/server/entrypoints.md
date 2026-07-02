# Server Entry Points

## Runtime shape

- The app is a SvelteKit application built with `@sveltejs/adapter-node`; `bun build/index.js` is the production entrypoint (the server always runs under Bun — the database layer uses `bun:sqlite`).
- `src/hooks.server.ts` runs once per server process: it starts the hourly reminder cron and injects the per-route `<body>` class used by the release page chrome.
- Pages (`/`, `/s/:id/:name`, `/r/:id`) are SvelteKit routes under `src/routes/` with `+page.server.ts` load functions.
- The REST API and RSS feeds are Hono route groups (see `server/app.ts`), mounted into SvelteKit through catch-all endpoints:
  - `src/routes/api/[...path]/+server.ts` → `/api/*`
  - `src/routes/feed/[...path]/+server.ts` → `/feed/*`
- Uploaded artwork is served by `src/routes/uploads/[...path]/+server.ts` from `UPLOADS_DIR`.
- In development, `bun run dev` (`bunx --bun vite dev`) serves everything — pages, API, uploads — with HMR.

## Special cases

- Errors inside Hono handlers are normalized to a JSON `500` response in `server/app.ts` (`apiApp.onError`).
- Test-only helpers are mounted at `/api/__test__` when `NODE_ENV === "test"` (the Playwright worker servers run this way).
- SvelteKit's CSRF origin check is disabled (`svelte.config.js`): the app has no cookie auth, and the email ingest webhook receives cross-origin multipart POSTs authenticated by bearer token.

## Why this matters

The repo is a single deployable service. SvelteKit serves SSR pages and static assets from one process, while the battle-tested Hono API layer continues to own `/api/*` and `/feed/*` unchanged — external integrations (ingest webhooks, RSS readers) see identical URLs and behavior.

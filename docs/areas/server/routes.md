# Server Routes

## Main groups

- `server/app.ts` assembles the Hono app that SvelteKit mounts under `/api/*` and `/feed/*`.
- `server/routes/music-items.ts` owns listing, create/update/delete, filtering, sorting, stack-aware queries, and saved ordering.
- `server/routes/stacks.ts` owns stack CRUD, item membership, and parent/child stack hierarchy rules.
- `server/routes/release.ts` owns image upload, cover scanning, MusicBrainz lookup, and Apple Music enrichment.
- `server/routes/ingest.ts` owns authenticated email and single-link ingestion endpoints.
- `server/routes/rss.ts` exposes the feed surfaces.

## Page data (SvelteKit)

- `server/queries/main-page-data.ts` provides `fetchInitialItems`/`fetchInitialStacks` for the main and stack pages' `+page.server.ts` load functions.
- `src/routes/r/[id]/+page.server.ts` loads a release via `fetchFullItem` and precomputes listen embeds (Bandcamp/YouTube/Apple Music/Mixcloud) server-side.

## Shared patterns

- Routes validate IDs and payloads directly in the handler layer.
- Drizzle queries are used directly from route modules instead of adding a separate service abstraction for simple flows.
- JSON errors are explicit and usually return `400`, `401`, `404`, `422`, or `503` depending on failure mode.

## State passed to the frontend

The main page load preloads the default `to-listen` list and stack bar so the first render works without waiting for a client fetch. On stack URLs it preloads the stack's items with the `all` filter, mirroring what the app machine forces client-side. The page components seed the app machine from this data and take over interactive updates.

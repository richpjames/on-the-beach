# Server Routes

## Main groups

- `server/routes/main-page.ts` renders the initial HTML shell and injects stack state for SSR-first startup.
- `server/routes/music-items.ts` owns listing, create/update/delete, filtering, sorting, stack-aware queries, and saved ordering.
- `server/routes/stacks.ts` owns stack CRUD, item membership, and parent/child stack hierarchy rules.
- `server/routes/release.ts` owns image upload, cover scanning, MusicBrainz lookup, and Apple Music enrichment.
- `server/routes/ingest.ts` owns authenticated email and single-link ingestion endpoints.
- `server/routes/release-page.ts` and `server/routes/rss.ts` expose sharing and feed surfaces.

## Shared patterns

- Routes validate IDs and payloads directly in the handler layer.
- Drizzle queries are used directly from route modules instead of adding a separate service abstraction for simple flows.
- JSON errors are explicit and usually return `400`, `401`, `404`, `422`, or `503` depending on failure mode.

## State passed to the frontend

`main-page.ts` preloads the default `to-listen` list and stack bar so the first render works without waiting for a client fetch. The frontend then hydrates and takes over interactive updates.

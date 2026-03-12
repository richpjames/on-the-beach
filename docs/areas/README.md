# Repo Areas

This section is a compact map of the implemented codebase. It complements the design docs in `docs/plans` by pointing at the current runtime structure.

## Areas

- `server/` covers the Bun + Hono entrypoints, route groups, and server-side orchestration.
- `frontend/` covers the SPA shell, XState-driven UI flows, and retro presentation rules.
- `data/` covers the SQLite schema, Drizzle migrations, and persisted ordering rules.
- `integrations/` covers email ingest, metadata scraping, image scanning, and MusicBrainz lookups.
- `quality/` covers unit tests, Playwright coverage, and the vision evaluation harness.

## Reading order

1. Start with `server/entrypoints.md` for the request flow.
2. Read `frontend/app-shell.md` and `frontend/state-and-rendering.md` for UI behavior.
3. Use `data/schema.md` for the persistence model.
4. Use `integrations/*.md` for ingestion and enrichment paths.
5. Use `quality/*.md` for verification tooling.

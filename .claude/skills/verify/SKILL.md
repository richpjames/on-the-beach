---
name: verify
description: Build, launch, and drive this app locally to observe a change working end-to-end.
---

# Verifying changes in On The Beach

SvelteKit + Bun app with a SQLite DB. The production e2e fixtures
(`playwright/fixtures/parallel-test.ts`) are the reference for how to boot it.

## Build + launch

```bash
bun run build                       # outputs build/index.js (adapter-node)

# Seed an isolated DB in a temp dir, then boot the built server:
export DATABASE_PATH=/path/to/tmp/verify.db NODE_ENV=test OTB_DISABLE_EXTERNAL_LOOKUPS=1
bun server/db/seed.ts
PORT=4173 ORIGIN=http://127.0.0.1:4173 bun build/index.js
```

- `ORIGIN` must be set to the real http origin or the CSRF check rejects POSTs.
- `OTB_DISABLE_EXTERNAL_LOOKUPS=1` blocks iTunes/Discogs/etc. lookups (same as e2e).
- Ready when `GET /api/music-items` returns 200. Use `curl --noproxy 127.0.0.1`.

## Seeding data / test hooks

- `POST /api/__test__/reset` clears all items/stacks (test env only).
- Create items directly: `POST /api/music-items` with JSON like
  `{"artistName":"Burial","title":"Untrue","itemType":"album"}`.
- API POSTs need an `origin: http://127.0.0.1:<port>` header (CSRF).

## Driving the UI

Chromium is preinstalled at `/opt/pw-browsers/chromium`; drive with a
`playwright-core` script run under `bun`, launching with
`{ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] }`.

Useful selectors: add bar = `getByPlaceholder("search or paste a link")`;
list cards = `.music-card`; list container = `#music-list` (note: `.music-list`
class also sits on a wrapper — use the id); browse search input =
`#browse-search`; its clear button = `#search-clear-btn`.

## Gotchas

- Default filter on `/` is **To Listen**, so freshly created items are visible
  but `listened` ones are not.
- With external lookups disabled, submitting free text via the Add button
  completes without a link picker or any visible result — don't read that as
  a regression.

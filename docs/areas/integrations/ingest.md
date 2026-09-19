# Ingest Paths

## HTTP ingest

- `server/routes/ingest.ts` exposes authenticated endpoints under `/api/ingest`.
- `POST /api/ingest/email` accepts provider-shaped email payloads, extracts music URLs, and creates items.
- `POST /api/ingest/link` creates items from one explicit URL.
- `GET /api/ingest/link-preview` reads a link's release date without adding anything, so a client can fill its own date control in before the user commits (see `docs/areas/server/routes.md`).

## Release dates

- A page that names a release date dates the item it creates, and a date still to come schedules it: `remind_at` is set to release day, so a Bandcamp pre-order lands in Scheduled and arrives in To Listen when it's out, rather than sitting in To Listen with nothing to play.
- Gated on the same "Schedule unreleased records to arrive in To Listen on release day" setting as an accepted release alert, and computed with the same `remindAtForReleaseDate` (`domain/release-dates.ts`), so a record reaching the library by either route is scheduled for the same day.
- An explicit `remindAt` in the request is applied after creation and so overrides the scraped date — the user's own choice wins.

## URL extraction

- `app/email-parser.ts` pulls links from HTML first, then falls back to plain text.
- Extracted URLs are normalized through `parseUrl()` so duplicate links collapse before creation.
- Unknown sources can still be passed through when ingest opts into `includeUnknown`.

## Provenance notes

- A page that names several releases (a round-up, chart, or label page) stamps every item created from it with `From <page title> (<url>)`, appended to any note the request supplied with the same ` — ` separator the photo ingest uses.
- The note is skipped when the page named a single release, and when one candidate is auto-picked as the page's own subject — in both cases the item's link already says where it came from.

## Result shape

Both ingest paths return or log created-versus-skipped counts. Duplicate links are treated as skips instead of hard failures.

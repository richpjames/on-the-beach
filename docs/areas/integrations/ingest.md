# Ingest Paths

## HTTP ingest

- `server/routes/ingest.ts` exposes authenticated endpoints under `/api/ingest`.
- `POST /api/ingest/email` accepts provider-shaped email payloads, extracts music URLs, and creates items.
- `POST /api/ingest/link` creates items from one explicit URL.

## URL extraction

- `server/email-parser.ts` pulls links from HTML first, then falls back to plain text.
- Extracted URLs are normalized through `parseUrl()` so duplicate links collapse before creation.
- Unknown sources can still be passed through when ingest opts into `includeUnknown`.

## Provenance notes

- A page that names several releases (a round-up, chart, or label page) stamps every item created from it with `From <page title> (<url>)`, appended to any note the request supplied with the same ` — ` separator the photo ingest uses.
- The note is skipped when the page named a single release, and when one candidate is auto-picked as the page's own subject — in both cases the item's link already says where it came from.

## Result shape

Both ingest paths return or log created-versus-skipped counts. Duplicate links are treated as skips instead of hard failures.

# Ingest Paths

## HTTP ingest

- `server/routes/ingest.ts` exposes authenticated endpoints under `/api/ingest`.
- `POST /api/ingest/email` accepts provider-shaped email payloads, extracts music URLs, and creates items.
- `POST /api/ingest/link` creates items from one explicit URL.

## URL extraction

- `server/email-parser.ts` pulls links from HTML first, then falls back to plain text.
- Extracted URLs are normalized through `parseUrl()` so duplicate links collapse before creation.
- Unknown sources can still be passed through when ingest opts into `includeUnknown`.

## Result shape

Both ingest paths return or log created-versus-skipped counts. Duplicate links are treated as skips instead of hard failures.

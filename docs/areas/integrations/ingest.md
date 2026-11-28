# Ingest Paths

## HTTP ingest

- `server/routes/ingest.ts` exposes authenticated endpoints under `/api/ingest`.
- `POST /api/ingest/email` accepts provider-shaped email payloads, extracts music URLs, and creates items.
- `POST /api/ingest/link` creates items from one explicit URL. An optional `pageTitle` (trimmed, length-capped) carries the listing title the share client captured while the page was loaded in the user's browser — evidence for a marketplace link, ignored by every other source.
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

## Marketplace listings

- eBay and Wallapop block server fetches of their pages (IP-level 403s), so a marketplace link is never fetched: the item is resolved from the `pageTitle` the share client captured, through the same extractor unknown pages use (`app/music-item-creator.ts`, the marketplace branch). The user's own `title` override still wins — `pageTitle` is evidence, not a correction.
- A usable raw title the extractor can't parse becomes a single album-shaped candidate (a listing *is* one copy of one release for sale). A URL-only or bare-site-name title is rejected; Wallapop's URL slug words are the fallback evidence, and with none the answer is "This site blocks server requests — paste the listing title" — the web add form's title field is the recovery.
- Duplicate shares dedupe on `<source>:<listing id>` (`musicLinks.listingKey`), since listing ids are global across a marketplace's country sites — ebay.es and ebay.com carry the same listing. The TLD-bearing URL stays stored: it sets the currency and the eBay enricher's marketplace header.
- Where an official API exists it enriches, never required: `adapters/ebay/` reads the listing through the Browse API when `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` are set (canonical title, image, price, item aspects). The captured client title remains the fallback when the API is unconfigured or fails. See `docs/plans/2026-11-25-marketplace-support-design.md`.

## Result shape

Both ingest paths return or log created-versus-skipped counts. Duplicate links are treated as skips instead of hard failures.

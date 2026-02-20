# Email Ingest Feature Design

## Summary

Receive emails (e.g. Bandcamp new-release notifications) via a webhook and automatically create music items from any music platform URLs found in the email body. Items are created without stack assignment — the user triages them later.

## How It Works

```
Email arrives
  → Email provider (Cloudflare Email Routing, SendGrid, etc.)
    → HTTP POST to /api/ingest/email
      → Parse email body for music URLs
        → For each URL: create a music item (reuses existing scraper + URL parser)
```

Single-user app, so no user/account mapping is needed.

## Webhook Endpoint

```
POST /api/ingest/email
Authorization: Bearer <INGEST_API_KEY>
Content-Type: application/json
```

### Request Body (generic envelope)

```json
{
  "from": "noreply@bandcamp.com",
  "to": "music@enlaplaya.example.com",
  "subject": "New release from Seekers International",
  "html": "<html>...album link in here...</html>",
  "text": "Plain text fallback with https://artist.bandcamp.com/album/slug"
}
```

Different email webhook providers use different payload shapes. We normalise them into this internal envelope via per-provider adapters.

### Provider Adapters

Start with two:

1. **Generic** — accepts the envelope shape above directly (useful for custom integrations and testing)
2. **SendGrid Inbound Parse** — maps SendGrid's multipart POST into the envelope

The provider is selected via a query param: `POST /api/ingest/email?provider=sendgrid`. Default is `generic`.

### Response

```json
// 200 — processed successfully
{
  "received": true,
  "items_created": 2,
  "items_skipped": 1,
  "items": [
    { "id": 42, "title": "Album Name", "url": "https://artist.bandcamp.com/album/slug" }
  ],
  "skipped": [
    { "url": "https://artist.bandcamp.com/album/already-exists", "reason": "duplicate" }
  ]
}

// 401 — missing or invalid API key
{ "error": "Unauthorized" }
```

## Email Parsing

Extract all URLs from the email, then filter to only music platform URLs that the app already knows how to handle.

### Step 1: Extract URLs

From the HTML body (preferred, richer content):
- Parse all `<a href="...">` tags
- Also extract bare URLs from text nodes (fallback)

From the plain text body (fallback if no HTML):
- Regex match URLs

### Step 2: Filter to Music URLs

Run each extracted URL through the existing `parseUrl()` from `server/utils.ts`. Keep only URLs where the source is not `"unknown"` — i.e. the URL matches a known music platform pattern (Bandcamp, Spotify, SoundCloud, etc.).

Deduplicate by normalised URL.

### Step 3: Check for Duplicates

For each music URL, check if it already exists in the `music_links` table. Skip if it does.

### Step 4: Create Music Items

For each new URL, reuse the same creation logic as `POST /api/music-items`:
- Parse URL → extract source, potential artist/title
- Scrape OG metadata
- Get or create artist
- Insert music item + primary link

Items are created with:
- `listen_status`: `"to-listen"`
- `purchase_intent`: `"no"`
- `notes`: `"Via email from <sender>"`
- No stack assignment

## Authentication

Single shared secret stored as an environment variable:

```
INGEST_API_KEY=some-random-secret-here
```

The webhook endpoint checks `Authorization: Bearer <token>` against this value. If it doesn't match, return 401.

This is simple and sufficient for a single-user app. The key is configured once in the email provider's webhook settings and in the app's environment.

## New Files and Changes

### New Files

| File | Purpose |
|------|---------|
| `server/routes/ingest.ts` | Webhook endpoint + provider adapters |
| `server/email-parser.ts` | URL extraction from email HTML/text |
| `server/music-item-creator.ts` | Extracted shared creation logic (from music-items.ts POST handler) |
| `tests/unit/email-parser.test.ts` | Unit tests for email URL extraction |
| `tests/unit/ingest.test.ts` | Unit tests for provider adapters |

### Modified Files

| File | Change |
|------|--------|
| `server/index.ts` | Mount `/api/ingest` routes |
| `server/routes/music-items.ts` | Refactor POST handler to use shared `createMusicItem()` |

## Configuration

Two new environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `INGEST_API_KEY` | Yes (for ingest) | Shared secret for webhook auth |
| `INGEST_ENABLED` | No | Set to `"false"` to disable the endpoint entirely. Defaults to `"true"`. |

## Future Considerations (Not In Scope)

- **More providers**: Cloudflare Email Workers, Mailgun, Postmark — add adapters as needed
- **Filtering rules**: Only process emails from specific senders (e.g. `*@bandcamp.com`)
- **Auto-stack assignment**: Map senders → stacks (e.g. Bandcamp emails → "New Releases")
- **Processing log**: Store raw emails for debugging/replay
- **Rate limiting**: Protect against abuse (unlikely for single-user but good hygiene)

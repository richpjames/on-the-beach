# MusicBrainz Scan Enrichment — Design

**Date:** 2026-03-01

## Problem

The cover scan feature calls the Mistral API and returns only `{ artist, title }`. The add form also accepts `year`, `label`, `country`, `genre`, and `catalogueNumber`, but these are never auto-populated — the user must fill them in manually. MusicBrainz exposes a free, no-auth-required search API that can return this metadata given an artist and title.

## Goal

After Mistral returns a scan result, query MusicBrainz and return an enriched `ScanResult` to the client — all in a single round-trip, transparently, with silent fallback if MusicBrainz is unavailable or returns no match.

## Decisions

| Question | Decision |
|---|---|
| Multiple MB matches | Return best/first match only |
| Where does enrichment happen | Server-side, before the response is sent |
| MB failure / no match | Silent fallback to Mistral-only result |

## Architecture

Four changes, two new files:

```
server/musicbrainz.ts     ← new: MusicBrainz API client
server/scan-enricher.ts   ← new: composes Mistral + MusicBrainz
server/routes/release.ts  ← changed: delegates to scan-enricher
src/types/index.ts        ← changed: ScanResult gains optional fields
```

## Data Flow

```
POST /api/release/scan
  │
  ▼
scan-enricher.ts: enrichScanResult(base64Image)
  │
  ├─ 1. extractAlbumInfo(base64Image)  → { artist, title } | null
  │       [if null, return null immediately — route returns 503]
  │
  ├─ 2. musicbrainz.ts: lookupRelease(artist, title)
  │       → { year, label, country, genre, catalogueNumber } | null
  │       [if null or any error, silently skip enrichment]
  │
  └─ 3. merge and return { artist, title, ...mbFields }
```

## Type Change

```ts
// src/types/index.ts
export interface ScanResult {
  artist: string | null;
  title: string | null;
  // New optional fields populated by MusicBrainz enrichment:
  year?: number | null;
  label?: string | null;
  country?: string | null;
  genre?: string | null;
  catalogueNumber?: string | null;
}
```

The fields are optional so the existing Mistral-only path remains valid without any client changes.

## MusicBrainz API

Endpoint: `GET https://musicbrainz.org/ws/2/release`

```
?query=artist:{artist} AND release:{title}
&limit=1
&fmt=json
User-Agent: on-the-beach/1.0 (contact@example.com)
```

- Free, no API key required
- `User-Agent` header is mandatory — requests without it are blocked
- Rate limit: 1 request/second for anonymous requests
- The base search response (no `inc=` parameters needed) includes: `date` → `year`, `country`, `label-info[0].label.name` → `label`, `label-info[0].catalog-number` → `catalogueNumber`
- Genre is not in the release search response directly; omit for now or derive from release-group tags in a follow-on

## Error Handling

All failures are silent to the client — the enricher always returns at least the Mistral result:

| Scenario | Behaviour |
|---|---|
| Mistral returns `null` | Enricher returns `null`; route returns 503 (unchanged) |
| MB fetch throws | Log error, return Mistral-only result |
| MB returns non-200 | Log warning, return Mistral-only result |
| MB returns zero results | Return Mistral-only result |
| MB rate-limited (429) | Log warning, return Mistral-only result |

## Testing Plan

**`server/musicbrainz.ts`**
- Parse a well-formed MB response into the enrichment fields
- Return `null` for empty results array
- Return `null` for non-200 status (mock `fetch`)

**`server/scan-enricher.ts`**
- Happy path: merged artist+title+MB fields returned
- MB returns null: Mistral-only result returned
- MB throws: Mistral-only result returned
- Mistral returns null: enricher returns null

**`server/routes/release.ts`**
- Update the existing injectable `scanReleaseCover` parameter to accept the enricher signature
- Existing route tests continue to pass with a stubbed enricher

## Out of Scope

- Client-side changes to populate the newly enriched fields into the form (small follow-on)
- Genre enrichment (requires a second MB lookup via release-group tags)
- Caching MB responses

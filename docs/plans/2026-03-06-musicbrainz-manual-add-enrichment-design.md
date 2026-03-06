# Design: MusicBrainz Enrichment on Manual Add

## Overview

When a user manually adds a release via the add form, automatically look up MusicBrainz to fill in missing metadata fields (year, label, country, catalogue number) and store the MB release and artist IDs.

## Decisions

- Lookup triggers on form submit (not on blur, not via a separate button)
- MB data only fills **empty** form fields — user-entered values are never overwritten
- If the lookup fails or returns no results, the item is saved silently with whatever the user typed
- MusicBrainz release UUID and artist UUID are stored on the item for future use

## Architecture

### New API endpoint: `POST /api/release/lookup`

Lives in `server/routes/release.ts` alongside the existing `/scan` and `/image` routes.

Request body:
```json
{ "artist": "string", "title": "string", "year": "string (optional)" }
```

Response (on match):
```json
{
  "year": 2019,
  "label": "Warp",
  "country": "GB",
  "catalogueNumber": "WARPCD100",
  "musicbrainzReleaseId": "b84ee12a-...",
  "musicbrainzArtistId": "f59c5520-..."
}
```

Response (on miss or failure): `{}`

Validation: returns 400 if `artist` or `title` is missing/empty.

### `server/musicbrainz.ts`

- `MusicBrainzFields` gains two new fields:
  ```ts
  musicbrainzReleaseId: string | null;
  musicbrainzArtistId: string | null;
  ```
- `lookupRelease` gains an optional `year` hint parameter:
  ```ts
  lookupRelease(artist: string, title: string, year?: string): Promise<MusicBrainzFields | null>
  ```
- Lucene query extended: `artist:X AND release:Y [AND date:Z]`
- Response parsing extracts `release.id` and `release.artist-credit[0].artist.id`

### Database schema (`server/db/schema.ts`)

Two new nullable text columns added to `music_items`:
- `musicbrainz_release_id text`
- `musicbrainz_artist_id text`

New Drizzle migration in `drizzle/`.

### `src/types/index.ts`

- `MusicItem` gains:
  ```ts
  musicbrainz_release_id: string | null;
  musicbrainz_artist_id: string | null;
  ```
- `CreateMusicItemInput` and `UpdateMusicItemInput` gain optional:
  ```ts
  musicbrainzReleaseId?: string;
  musicbrainzArtistId?: string;
  ```

### `src/services/api-client.ts`

New method:
```ts
async lookupRelease(artist: string, title: string, year?: string): Promise<Partial<MusicBrainzFields>>
```

Returns `{}` on any non-ok response rather than throwing.

### Client submit flow (`src/app.ts`)

On form submit:
1. Read form values as today
2. If `artist` and `title` are both non-empty, call `api.lookupRelease(artist, title, year?)`
3. Merge response into form values: only apply each returned field if the corresponding form field is currently empty
4. Call `createMusicItem` with merged values (including MB IDs)
5. On lookup error, skip to step 4 silently

## Files Changed

| File | Change |
|---|---|
| `server/musicbrainz.ts` | Extend `MusicBrainzFields`, add `year` hint to query, parse MB IDs |
| `server/routes/release.ts` | Add `POST /api/release/lookup` handler |
| `server/db/schema.ts` | Add `musicbrainz_release_id`, `musicbrainz_artist_id` columns |
| `drizzle/NNNN_*.sql` | New migration |
| `src/types/index.ts` | Add MB ID fields to `MusicItem`, `CreateMusicItemInput`, `UpdateMusicItemInput` |
| `src/services/api-client.ts` | Add `lookupRelease` method |
| `src/app.ts` | Call lookup on submit, merge results before save |

## Out of Scope

- Genre enrichment (requires a separate MB release-group lookup)
- Enriching existing items retroactively
- Showing enriched fields to the user before save
- Rate limiting / caching MB responses

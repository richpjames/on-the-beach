# Design: MusicBrainz Enrichment on Manual Add

## Overview

When a user manually adds a release via the add form, automatically look up MusicBrainz to fill in missing metadata fields (year, label, country, catalogue number), fetch and store cover artwork from the Cover Art Archive, and store the MB release and artist IDs.

## Decisions

- Lookup triggers on form submit (not on blur, not via a separate button)
- MB data only fills **empty** form fields — user-entered values are never overwritten
- If the lookup fails or returns no results, the item is saved silently with whatever the user typed
- MusicBrainz release UUID and artist UUID are stored on the item for future use
- If a MB release ID is found and the form has no artwork, the server fetches the cover from the Cover Art Archive and saves it to `/uploads/`, returning the path as `artworkUrl`

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
  "musicbrainzArtistId": "f59c5520-...",
  "artworkUrl": "/uploads/uuid.jpg"
}
```

The `artworkUrl` field is only present if artwork was successfully fetched and saved. The client applies it with the same empty-field-only merge as all other fields.

Response (on miss or failure): `{}`

Validation: returns 400 if `artist` or `title` is missing/empty.

### Cover Art Archive (`server/cover-art-archive.ts`, new file)

A new module responsible for fetching cover art:

```ts
fetchAndSaveCoverArt(releaseId: string): Promise<string | null>
```

- Fetches `https://coverartarchive.org/release/{releaseId}/front-500`
- On success (200), saves the image bytes to `/uploads/{uuid}.jpg` using the same `saveReleaseImage` pattern as the scan flow
- Returns the public path (e.g. `/uploads/uuid.jpg`), or `null` on any failure

The lookup endpoint calls this after a successful MB match, only if the response status is a redirect/200 and content-type is an image.

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
| `server/cover-art-archive.ts` | New module: fetch CAA image and save to `/uploads/` |
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

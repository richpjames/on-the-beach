# Bandcamp Player Embed — Design

**Date:** 2026-03-08
**Issue:** [#56](https://github.com/richpjames/on-the-beach/issues/56)

## Summary

Embed a Bandcamp player iframe on release pages for items whose primary link is a Bandcamp URL. The embed requires a numeric album/track ID that is not present in the URL — it must be scraped from the Bandcamp page HTML and persisted alongside the link.

## Key Decision: metadata column on `music_links`

Rather than a single `embed_id` column (which would not scale to other providers), we add a `metadata TEXT` (JSON) column to `music_links`. This stores source-specific key/value data without additional tables or per-source columns. It is flexible enough to hold Bandcamp IDs today and other provider IDs (Discogs, Apple Music, etc.) in future without further migrations.

Example value for a Bandcamp link:
```json
{"album_id": "1536701931", "item_type": "album"}
```

## Changes

### 1. DB migration
- New Drizzle migration: add `metadata TEXT` (nullable) to `music_links`
- Update `server/db/schema.ts`: add `metadata: text("metadata")` to `musicLinks`

### 2. Extraction — `server/scraper.ts`
- Add `embedMetadata?: Record<string, string>` to `ScrapedMetadata`
- Add `extractBandcampEmbedMetadata(html: string)` that parses the numeric ID from:
  1. `<meta name="bc-page-properties" content='{"item_id":...}'>` (primary)
  2. `TralbumData = { ... id: ... }` JS block (fallback)
- Call this inside the Bandcamp branch of `scrapeUrl()`, populate `embedMetadata`

### 3. Saving — `server/music-item-creator.ts`
- `insertMusicItemWithLink()` receives `embedMetadata` from scraped result
- Serialises it as JSON into `music_links.metadata` on insert

### 4. Querying — `server/music-item-creator.ts` (`fullItemSelect`)
- Include `musicLinks.metadata` in the select
- Expose as `primary_link_metadata: string | null` on the query result

### 5. Types — `src/types/index.ts`
- Add `primary_link_metadata: string | null` to `MusicItemFull`

### 6. Rendering — `server/routes/release-page.ts`
- In `renderReleasePage()`, parse `primary_link_metadata` JSON when `primary_source === 'bandcamp'`
- Derive embed type (`album` or `track`) from the stored URL path (`/album/` vs `/track/`)
- If `album_id` is present, render an iframe in `view-mode` below the source link:
  ```
  https://bandcamp.com/EmbeddedPlayer/{type}={id}/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/transparent=true/
  ```

## Out of scope
- Embeds on the music list / card view
- Embed IDs for providers whose ID is already in the URL (Discogs, Apple Music)
- Editing or overriding the embed ID via the UI

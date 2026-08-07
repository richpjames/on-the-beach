# Scanning And Enrichment

## Link metadata

- `server/scraper.ts` parses OG tags, detects whether unknown pages are music-related, and extracts source-specific metadata.
- Known sources such as Bandcamp can expose extra embed metadata.
- Unsupported pages can still be processed through text extraction when Mistral-backed release extraction is available.

## Cover scanning

- `server/vision.ts` sends cover images to Mistral.
- OCR models use the OCR API path; other models use chat completions with an image input.
- `server/scan-parser.ts` normalizes the JSON returned by the model.

## Release enrichment

- `server/routes/release.ts` validates base64 uploads, writes cover images, and returns public upload URLs.
- MusicBrainz lookups fill fields such as year, label, country, and catalogue number.
- Cover Art Archive fetches can save richer artwork when a MusicBrainz release ID is found.
- Apple Music links can be backfilled for playable releases.

## Apple Music backfill

- `server/apple-music-backfill.ts` holds the shared backfill logic. `backfillAppleMusicLink` looks up a release on the iTunes Search API and saves a confident match as a secondary Apple Music link. It is idempotent: it skips releases whose primary link is already Apple Music and leaves any existing Apple Music link untouched.
- When a non-Apple-Music item is added (via the API, email/link ingest, or photo ingest) `scheduleAppleMusicBackfill` runs the lookup in the background, so a playable Apple Music link is usually ready before the release page is opened.
- `POST /api/release/apple-music-lookup/:id` exposes the same logic on demand and is still used as a lazy fallback from the release page for older items.

## YouTube fallback

- Plenty of releases (small labels, out-of-print records) simply aren't on Apple Music or Spotify. When the active service's search comes up empty, `server/secondary-link-enrichment.ts` runs a second lookup through `searchYouTube` (`server/youtube-search.ts`) and saves a hit as a secondary `youtube` link.
- The fallback only fires on a miss, is skipped for items that are already a YouTube link or already have one, and never contributes artwork — a video thumbnail isn't a cover.
- YouTube search always returns *something*, so a candidate is only accepted when `judgeYouTubeCandidate` is confident: the release title must appear whole-word in the video title, the artist must own the channel (`<Artist> - Topic`, or a channel named after them) or be named in the video title, and the leftover words must not advertise a cover, live take, remix, karaoke, reaction or similar. Anything short of that yields no link at all.
- Requires `YOUTUBE_API_KEY` (YouTube Data API v3). Without it the fallback cleanly no-ops, as does everything else under `OTB_DISABLE_EXTERNAL_LOOKUPS`.

## Frontend tie-in

`src/ui/state/add-form-machine.ts` runs upload and scan in parallel, then uses MusicBrainz lookup as a non-fatal enrichment step before final item creation.

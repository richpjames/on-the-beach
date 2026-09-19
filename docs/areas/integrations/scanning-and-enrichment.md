# Scanning And Enrichment

## Link metadata

- `app/scrape.ts + adapters/registry.ts` fetches the page, detects whether unknown pages are music-related, and dispatches to the parser for the link's source.
- `adapters/web/html-metadata.ts` holds the source-agnostic reading of a page — OG tags, JSON-LD, HTML entities — so a per-source module never has to import the scraper that calls it.
- `adapters/mixcloud.ts` holds everything Mixcloud: oEmbed, JSON-LD and OG parsing, thumbnail squaring, the widget URL the release page embeds, and the show URL lifted from an embedded widget on someone else's page. Other sources with more than a parser have their own modules too (`adapters/discogs.ts`, `adapters/apple-music-catalog.ts`, `adapters/youtube.ts`).
- Known sources such as Bandcamp can expose extra embed metadata.
- `adapters/soundcloud.ts` holds the SoundCloud playback knowledge: the resource urn (`soundcloud:tracks:123`) lifted from the hydra state in a page's body, and the widget URL built from it. SoundCloud's widget refuses permalinks and only plays api.soundcloud.com resources, so the urn is stored on the link at scrape time, like Bandcamp's `album_id`.
- Bandcamp states a release date in the credits under the tracklist — "released 14 March 2024" for a record that's out, "releases 14 March 2026" for a pre-order. `parseBandcampReleaseDate` reads it (falling back to `TralbumData`'s GMT timestamp for layouts that don't render the credits) and it lands on `ScrapedMetadata.releaseDate`, which dates the item and — when the day is still to come — schedules it. `sourceNamesReleaseDate` says which sources are worth fetching for a date alone.
- Unsupported pages can still be processed through text extraction when Mistral-backed release extraction is available.
- A page naming several releases is a listing (a Mixcloud profile, a label catalogue, a round-up), and links to each of them. `matchReleaseUrls` (`adapters/web/link-extractor.ts`) pairs each extracted release with the page's own link to it, matching on the anchor's text and the link's slug, so an item picked off the listing links to its own release page and is filed under that page's source. A release the page links no page for keeps the listing URL.

## Cover scanning

- `adapters/mistral.ts` sends cover images to Mistral.
- OCR models use the OCR API path; other models use chat completions with an image input.
- `domain/scan-parser.ts` normalizes the JSON returned by the model.

## Release enrichment

- `server/routes/release.ts` validates base64 uploads, writes cover images, and returns public upload URLs.
- MusicBrainz lookups fill fields such as year, label, country, and catalogue number.
- Cover Art Archive fetches can save richer artwork when a MusicBrainz release ID is found.
- Apple Music links can be backfilled for playable releases.
- SoundCloud links saved before the urn scrape existed stay plain links until rescraped — `scripts/backfill-soundcloud-urns.ts` walks them once (`--dry-run` lists, the default writes, and re-runs only retry links that came up empty).

## Apple Music backfill

- `app/apple-music-backfill.ts` holds the shared backfill logic. `backfillAppleMusicLink` looks up a release on the iTunes Search API and saves a confident match as a secondary Apple Music link. It is idempotent: it skips releases whose primary link is already Apple Music and leaves any existing Apple Music link untouched.
- When a non-Apple-Music item is added (via the API, email/link ingest, or photo ingest) `scheduleAppleMusicBackfill` runs the lookup in the background, so a playable Apple Music link is usually ready before the release page is opened.
- `POST /api/release/apple-music-lookup/:id` exposes the same logic on demand and is still used as a lazy fallback from the release page for older items.

## YouTube fallback

- Plenty of releases (small labels, out-of-print records) simply aren't on Apple Music or Spotify. When the active service's search comes up empty, `app/secondary-link-enrichment.ts` runs a second lookup through `searchYouTube` (`adapters/youtube.ts`) and saves a hit as a secondary `youtube` link.
- The fallback only fires on a miss, is skipped for items that are already a YouTube link or already have one, and never contributes artwork — a video thumbnail isn't a cover.
- YouTube search always returns *something*, so a candidate is only accepted when `judgeYouTubeCandidate` is confident: the release title must appear whole-word in the video title, the artist must own the channel (`<Artist> - Topic`, or a channel named after them) or be named in the video title, and the leftover words must not advertise a cover, live take, remix, karaoke, reaction or similar. Anything short of that yields no link at all.
- Requires `YOUTUBE_API_KEY` (YouTube Data API v3). Without it the fallback cleanly no-ops, as does everything else under `OTB_DISABLE_EXTERNAL_LOOKUPS`.

## Frontend tie-in

`src/ui/state/add-form-machine.ts` runs upload and scan in parallel, then uses MusicBrainz lookup as a non-fatal enrichment step before final item creation.

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

## Frontend tie-in

`src/ui/state/add-form-machine.ts` runs upload and scan in parallel, then uses MusicBrainz lookup as a non-fatal enrichment step before final item creation.

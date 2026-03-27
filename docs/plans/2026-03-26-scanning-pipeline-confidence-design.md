# Scanning Pipeline: Confidence Score + Reverse Image Search

## Goal

Improve scan accuracy by having Mistral self-report confidence and falling back to Google Vision web detection when confidence is low.

## Threshold

- `confidence >= 0.8` → return result directly (+ MusicBrainz enrichment)
- `confidence < 0.8` → perform reverse image search, then re-ask Mistral

## Changes

### 1. `server/vision.ts`

Add `confidence: number` to the Mistral JSON schema and prompt.

```ts
// Updated ScanResult type
type ScanResult = {
  artist: string | null
  title: string | null
  confidence: number
}
```

Update the prompt to instruct Mistral to include a 0–1 confidence score reflecting certainty of the extracted artist/title.

Add a second function `extractReleaseInfoFromWebContext(image: string, webContext: string)` that sends both the image and a text summary of web detection results to Mistral, using the same schema.

### 2. `server/google-vision.ts` (new)

Calls Google Vision API `ANNOTATE_IMAGE` with `WEB_DETECTION` feature.

- Input: base64 JPEG
- Extracts: `bestGuessLabels`, `webEntities`, `pagesWithMatchingImages`
- Returns: plain text summary of signals
- Config: `GOOGLE_VISION_API_KEY` env var

### 3. `server/scan-enricher.ts`

Updated pipeline flow:

```
extractReleaseInfo(image)
  → confidence >= 0.8
      → lookupRelease (MusicBrainz)
      → return enriched result

  → confidence < 0.8
      → getWebContext(image)                          // Google Vision
      → extractReleaseInfoFromWebContext(image, ctx)  // Mistral second pass
      → lookupRelease (MusicBrainz)
      → return enriched result
```

The second Mistral pass result is used regardless of its confidence — it represents best effort.

## Environment Variables

| Variable | Purpose |
|---|---|
| `GOOGLE_VISION_API_KEY` | Google Cloud Vision API key |

## Out of Scope

- Retrying if the second pass also has low confidence
- Exposing confidence to the client UI
- Caching Google Vision results

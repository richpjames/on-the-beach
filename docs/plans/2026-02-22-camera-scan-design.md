# Camera Scan: Album Cover Recognition

## Problem

When browsing records in a shop, manually entering artist and title is slow. A camera-based scan would let users snap a cover photo and have the form prefilled instantly.

## Approach

Use Mistral's vision API (server-side) to analyse album cover photos. The LLM can reason about layout, font size, and context to distinguish artist from title — something pure OCR cannot do. The image is also saved as artwork for the item.

## User Flow

1. Tap camera button next to the URL input
2. Phone's rear camera opens via native file input
3. Snap photo of album cover
4. Loading indicator: "Scanning cover..."
5. Backend sends image to Mistral vision API, saves image to `/uploads/`
6. Response prefills artist and title fields (auto-expands "More options")
7. User reviews, edits if needed, submits normally

Optimised for quick capture at a record shop — minimal taps, fast feedback.

## Architecture

```
Browser (mobile)
  <input type="file" accept="image/*" capture="environment">
  → Read file as base64, resize to max 1024px
  → POST /api/release/scan { image: "base64..." }

Hono backend
  POST /api/release/scan
  → Decode base64, save to /uploads/<uuid>.jpg
  → Call Mistral vision API (mistral-small-latest)
  → Parse structured JSON response
  → Return { artist, title, artworkPath }

Browser
  → Expand "More options" details
  → Prefill artist + title fields
  → Include artworkPath when form is submitted
```

### Key decisions

- **New route file:** `server/routes/release.ts` mounted at `/api/release`
- **Mistral model:** `mistral-small-latest` — cheapest vision model, sufficient for text extraction from covers
- **Image storage:** Saved to `/uploads/<uuid>.jpg`. The existing `artworkUrl` column stores the local path.
- **No database changes.** Existing schema handles this.
- **Client-side resize:** Cap longest edge at 1024px before upload. Keeps transfer fast on mobile data.

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| No/garbage data from Mistral | Toast: "Couldn't read the cover". Fields left empty. |
| API down / network error | Toast: "Scan unavailable". Manual entry still works. |
| Blurry/unreadable photo | Prefill whatever partial data we got. |
| Image too large | Client-side resize before upload. |
| Non-album image | Same as no data — toast + empty fields. |

No retry logic. Fail gracefully to manual entry.

## Scope

### New files

- `server/routes/release.ts` — POST /api/release/scan endpoint
- `server/vision.ts` — Mistral API client for vision analysis

### Modified files

- `server/index.ts` — Mount release route, serve /uploads/ static
- `index.html` — Camera button on form
- `src/app.ts` — Camera capture handler, scan request, form prefill
- `src/styles/main.css` — Camera button + loading state styles

### Environment

- `MISTRAL_API_KEY` — new env var

### Dependencies

- `@mistralai/mistralai` — official Mistral SDK

### Testing

- E2E: Playwright test with mocked Mistral API response, verify form prefill
- Unit: Vision prompt/parsing logic

## Fields extracted

Artist and title only. Other fields (label, year, genre, etc.) are entered manually. This keeps the prompt simple and the results reliable.

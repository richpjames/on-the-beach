# Camera Scan MVP Implementation Plan

**Date:** 2026-02-22  
**Status:** Ready for implementation  
**Goal:** Add a camera/file scan flow that prefills `artist` and `title` in the add form without blocking manual entry.

## Scope

### In scope

- Scan button in add form (mobile camera + desktop file picker).
- Client-side resize/compress + base64 upload.
- New endpoint: `POST /api/release/scan`.
- Server-side Mistral vision call.
- Prefill `artist` and `title`; auto-open add form details.
- Unit tests for vision parsing and route validation.
- One Playwright flow test for visible prefill behavior.

### Out of scope (defer)

- Persisting image files under `/uploads`.
- Serving uploaded image files.
- Writing `artworkUrl` from scan.
- OCR fallback or multi-provider retries.
- Background queues/batching.

## Architecture (MVP)

1. User taps scan control in the add form.
2. Browser captures/selects an image and resizes it to a max edge of 1024px.
3. Browser sends `{ imageBase64 }` to `POST /api/release/scan`.
4. Backend validates payload and calls Mistral vision.
5. Backend returns `{ artist, title }` (nullable fields).
6. Frontend expands details and prefills any extracted values.
7. User edits if needed and submits normal create flow.

## API Contract

### `POST /api/release/scan`

Request:

```json
{
  "imageBase64": "<base64 string without data-url prefix>"
}
```

Success response (`200`):

```json
{
  "artist": "Radiohead",
  "title": "OK Computer"
}
```

Uncertain response (`200`):

```json
{
  "artist": null,
  "title": null
}
```

Error responses:

- `400`: invalid payload (missing/invalid `imageBase64`).
- `503`: provider unavailable/failure.

## Implementation Plan

### Phase 0: Preflight

- [ ] Confirm this remains MVP (no upload storage or `artworkUrl` writes).
- [ ] Add env var to local `.env`: `MISTRAL_API_KEY=...`.
- [ ] Install dependency: `bun add @mistralai/mistralai`.

Files:

- Modify: `package.json`
- Modify: `bun.lock`

Acceptance:

- Dependency appears in manifest and lockfile.

### Phase 1: Shared types and client contract

- [ ] Add shared type for scan response.
- [ ] Add typed API client method for scan endpoint.

Files:

- Modify: `src/types/index.ts`
- Modify: `src/services/api-client.ts`

Details:

- Add `ScanResult`:
  - `artist: string | null`
  - `title: string | null`
- Add `ApiClient.scanCover(imageBase64: string): Promise<ScanResult>`.

Acceptance:

- Frontend can call one typed method for scan.
- No raw `fetch('/api/release/scan')` added outside `ApiClient`.

### Phase 2: Vision extraction module

- [ ] Add `server/vision.ts` for provider call + response parsing.
- [ ] Keep extraction logic isolated and unit-testable.

Files:

- Create: `server/vision.ts`
- Create: `tests/unit/vision.test.ts`

Design constraints:

- Export `extractAlbumInfo(base64Image: string): Promise<ScanResult | null>`.
- Return `null` on provider/parse failure.
- Prompt enforces strict JSON object with `artist` and `title`.
- Parse defensively:
  - strip code fences if present,
  - reject non-object payloads,
  - coerce absent fields to `null`.

Unit tests:

- [ ] Valid JSON object returns expected fields.
- [ ] Nullable JSON returns nullable fields.
- [ ] Non-JSON assistant output returns `null`.
- [ ] Provider/network failure returns `null`.

Acceptance:

- Vision module handles malformed model output safely.

### Phase 3: Scan route and registration

- [ ] Add route module for `POST /api/release/scan`.
- [ ] Validate request shape early.
- [ ] Register route in server entrypoint.

Files:

- Create: `server/routes/release.ts`
- Modify: `server/index.ts`
- Create: `tests/unit/release-route.test.ts`

Route behavior:

- Parse JSON body safely.
- Validate:
  - `imageBase64` is a non-empty string,
  - size cap guard (for example `<= 2_000_000` chars).
- Call `extractAlbumInfo`.
- Return:
  - `200` with `{ artist, title }` (nullable),
  - `503` with `{ error: "Scan unavailable" }` when extraction fails,
  - `400` with `{ error: string }` for invalid payload.

Mounting:

- `app.route("/api/release", releaseRoutes);`

Unit tests:

- [ ] `400` for missing payload.
- [ ] `400` for invalid payload.
- [ ] `200` with parsed fields.
- [ ] `503` when vision returns `null`.

Acceptance:

- Endpoint is reachable under `/api/release/scan`.
- Errors are structured and consistent.

### Phase 4: Frontend UI and flow integration

- [ ] Add scan control near existing add-form URL input.
- [ ] Add hidden file input for capture/picker.
- [ ] Add client image processing helpers.
- [ ] Prefill details fields and keep manual fallback intact.

Files:

- Modify: `index.html`
- Modify: `src/app.ts`
- Modify: `src/styles/main.css`

UI behavior:

- Scan button triggers hidden file input (`accept="image/*"`, `capture="environment"`).
- While scan is in-flight:
  - disable button,
  - show loading state text/style.
- On success:
  - open `.add-form__details`,
  - prefill `artist` and `title` only when returned.
- On failure:
  - non-blocking message:
    - "Couldn't read the cover. Enter details manually."
    - "Scan unavailable. Enter details manually."

Accessibility:

- Provide label/`aria-label` for scan button and hidden input association.

Acceptance:

- Existing add-item submit behavior remains unchanged.
- Scan is additive; manual entry always works.

### Phase 5: E2E coverage

- [ ] Add Playwright spec for scan prefill flow.
- [ ] Include spec in `test:e2e` script.

Files:

- Create: `playwright/scan-cover.spec.ts`
- Modify: `package.json`

Test flow:

1. Reset DB via `POST /api/__test__/reset`.
2. Mock `/api/release/scan` response.
3. Trigger scan file upload in UI.
4. Assert details open and fields are prefilled.

Acceptance:

- New spec passes without a real provider key.

## Quality Gates

Run after implementation:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
bun run test:e2e
```

If any gate is skipped, record exactly which command and why.

## Rollout and Operations

- Local/dev manual verification requires `MISTRAL_API_KEY`.
- Missing key should produce `503` from scan endpoint.
- Frontend must continue to allow full manual entry on any scan failure.

## Risks and Mitigations

- Provider output drift: keep strict parser and nullable fallback.
- Large image payloads: enforce client resize + server size guard.
- Mobile UX regressions: keep capture optional and preserve existing add flow.

## Definition of Done

- [ ] User can scan an image and commonly get `artist`/`title` prefilled.
- [ ] Scan failure never blocks manual item creation.
- [ ] API validates bad payloads with `400` and structured error JSON.
- [ ] Unit tests cover vision parsing and route behavior.
- [ ] Playwright confirms visible prefill behavior.

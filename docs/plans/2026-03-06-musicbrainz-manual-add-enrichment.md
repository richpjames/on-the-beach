# MusicBrainz Manual Add Enrichment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a release is manually added via the add form, automatically call MusicBrainz to fill in empty metadata fields (year, label, country, catalogue number, artwork) and persist the MB release + artist UUIDs.

**Architecture:** A new `POST /api/release/lookup` endpoint accepts artist/title/year hints, calls the existing `lookupRelease` function (extended to return MB IDs and accept a year hint), fetches cover art from the Cover Art Archive if found, and returns all enrichment fields. The client calls this on form submit, merges results into empty fields only, then saves as usual.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle ORM (SQLite), bun:test

---

### Task 1: Add MB ID columns to DB schema and generate migration

**Files:**
- Modify: `server/db/schema.ts`

**Step 1: Add two nullable text columns to `musicItems` table in `server/db/schema.ts`**

In the `musicItems` table definition, after the `catalogueNumber` field, add:

```ts
musicbrainzReleaseId: text("musicbrainz_release_id"),
musicbrainzArtistId: text("musicbrainz_artist_id"),
```

**Step 2: Generate and apply the migration**

```bash
bun run db:generate
bun run db:migrate
```

Expected: a new file appears in `drizzle/` containing two `ALTER TABLE` statements adding the columns.

**Step 3: Commit**

```bash
git add server/db/schema.ts drizzle/
git commit -m "feat: add musicbrainz_release_id and musicbrainz_artist_id columns"
```

---

### Task 2: Extend `MusicBrainzFields` and update `lookupRelease`

**Files:**
- Modify: `server/musicbrainz.ts`
- Modify: `tests/unit/musicbrainz.test.ts`

**Step 1: Write failing tests for the new behaviour**

Add to `tests/unit/musicbrainz.test.ts`:

```ts
test("returns release ID and artist ID from response", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(
    makeMbResponse([
      {
        id: "release-uuid-123",
        date: "2001",
        country: "DE",
        "artist-credit": [{ artist: { id: "artist-uuid-456" } }],
        "label-info": [],
      },
    ]),
  );

  const result = await lookupRelease("Artist", "Title");
  expect(result?.musicbrainzReleaseId).toBe("release-uuid-123");
  expect(result?.musicbrainzArtistId).toBe("artist-uuid-456");
});

test("accepts year hint and includes it in the query", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(makeMbResponse([]));

  await lookupRelease("Radiohead", "OK Computer", "1997");
  const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("date%3A1997");
});

test("returns null musicbrainzReleaseId when release has no id field", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(
    makeMbResponse([{ date: "2001", country: "US", "label-info": [] }]),
  );

  const result = await lookupRelease("Artist", "Title");
  expect(result?.musicbrainzReleaseId).toBeNull();
  expect(result?.musicbrainzArtistId).toBeNull();
});
```

**Step 2: Run tests to confirm they fail**

```bash
bun test tests/unit/musicbrainz.test.ts
```

Expected: FAIL on the three new tests.

**Step 3: Update `MusicBrainzFields` interface and `lookupRelease` in `server/musicbrainz.ts`**

Add two fields to `MusicBrainzFields`:
```ts
export interface MusicBrainzFields {
  year: number | null;
  label: string | null;
  country: string | null;
  catalogueNumber: string | null;
  musicbrainzReleaseId: string | null;
  musicbrainzArtistId: string | null;
}
```

Update the `MbRelease` interface to include `id` and `artist-credit`:
```ts
interface MbArtistCredit {
  artist?: { id?: unknown };
}

interface MbRelease {
  id?: unknown;
  date?: unknown;
  country?: unknown;
  "label-info"?: unknown;
  "artist-credit"?: unknown;
}
```

Update `lookupRelease` signature to accept optional `year`:
```ts
export async function lookupRelease(
  artist: string,
  title: string,
  year?: string,
): Promise<MusicBrainzFields | null>
```

Update the query building:
```ts
const queryParts = [`artist:${artist}`, `AND release:${title}`];
if (year) {
  queryParts.push(`AND date:${year}`);
}
const query = queryParts.join(" ");
```

Update the return statement to parse MB IDs:
```ts
const artistCredit = Array.isArray(release["artist-credit"]) ? release["artist-credit"] : [];
const firstCredit = artistCredit[0] as MbArtistCredit | undefined;

return {
  year: parseYear(release.date),
  label,
  country,
  catalogueNumber,
  musicbrainzReleaseId: typeof release.id === "string" ? release.id : null,
  musicbrainzArtistId:
    firstCredit?.artist && typeof firstCredit.artist.id === "string"
      ? firstCredit.artist.id
      : null,
};
```

**Step 4: Update existing test assertions**

The existing test `"returns parsed fields from the first matching release"` now needs MB ID fields in its expected output. Update its `expect(result).toEqual(...)` to include:
```ts
musicbrainzReleaseId: null,
musicbrainzArtistId: null,
```

Do the same for `"handles missing label-info gracefully"` and `"returns null when fetch throws"` (those return null, unchanged) and `"returns null when releases array is empty"` (unchanged).

**Step 5: Run all musicbrainz tests**

```bash
bun test tests/unit/musicbrainz.test.ts
```

Expected: All PASS.

**Step 6: Commit**

```bash
git add server/musicbrainz.ts tests/unit/musicbrainz.test.ts
git commit -m "feat: extend lookupRelease with year hint and MB IDs"
```

---

### Task 3: Create Cover Art Archive module

**Files:**
- Create: `server/cover-art-archive.ts`
- Create: `tests/unit/cover-art-archive.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/cover-art-archive.test.ts`:

```ts
import { afterEach, describe, expect, spyOn, test, mock } from "bun:test";
import { fetchAndSaveCoverArt } from "../../server/cover-art-archive";

describe("fetchAndSaveCoverArt", () => {
  afterEach(() => {
    mock.restore();
  });

  test("fetches from CAA and returns saved path", async () => {
    const imageBytes = new Uint8Array([1, 2, 3]);
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(imageBytes, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    const mockSave = mock().mockResolvedValueOnce("/uploads/abc.jpg");

    const result = await fetchAndSaveCoverArt("release-uuid-123", mockSave);

    expect(result).toBe("/uploads/abc.jpg");
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  test("fetches from the correct CAA URL", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    const mockSave = mock().mockResolvedValueOnce("/uploads/abc.jpg");

    await fetchAndSaveCoverArt("release-uuid-123", mockSave);

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("https://coverartarchive.org/release/release-uuid-123/front-500");
  });

  test("returns null on non-200 response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    const mockSave = mock();

    const result = await fetchAndSaveCoverArt("bad-id", mockSave);

    expect(result).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
  });

  test("returns null when fetch throws", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));
    const mockSave = mock();

    const result = await fetchAndSaveCoverArt("release-uuid-123", mockSave);

    expect(result).toBeNull();
  });

  test("returns null when content-type is not an image", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const mockSave = mock();

    const result = await fetchAndSaveCoverArt("release-uuid-123", mockSave);

    expect(result).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
bun test tests/unit/cover-art-archive.test.ts
```

Expected: FAIL (module not found).

**Step 3: Implement `server/cover-art-archive.ts`**

```ts
const CAA_BASE = "https://coverartarchive.org/release";

type SaveImageFn = (base64Image: string) => Promise<string>;

export async function fetchAndSaveCoverArt(
  releaseId: string,
  saveImage: SaveImageFn,
): Promise<string | null> {
  const url = `${CAA_BASE}/${releaseId}/front-500`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      return null;
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return await saveImage(base64);
  } catch {
    return null;
  }
}
```

**Step 4: Run tests to confirm they pass**

```bash
bun test tests/unit/cover-art-archive.test.ts
```

Expected: All PASS.

**Step 5: Commit**

```bash
git add server/cover-art-archive.ts tests/unit/cover-art-archive.test.ts
git commit -m "feat: add Cover Art Archive module"
```

---

### Task 4: Extend shared types for MB IDs

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add MB ID fields to `MusicItem`**

In `src/types/index.ts`, add to the `MusicItem` interface after `catalogue_number`:

```ts
musicbrainz_release_id: string | null;
musicbrainz_artist_id: string | null;
```

**Step 2: Add MB ID fields to `CreateMusicItemInput`**

```ts
musicbrainzReleaseId?: string;
musicbrainzArtistId?: string;
```

**Step 3: Add MB ID fields to `UpdateMusicItemInput`**

```ts
musicbrainzReleaseId?: string | null;
musicbrainzArtistId?: string | null;
```

**Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: errors about `musicbrainzReleaseId`/`musicbrainzArtistId` not yet used in creator — that's fine. Fix any unexpected errors.

**Step 5: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add musicbrainz ID fields to shared types"
```

---

### Task 5: Persist MB IDs in `music-item-creator.ts`

**Files:**
- Modify: `server/music-item-creator.ts`

**Step 1: Update `createMusicItemDirect` insert to include MB ID fields**

In the `.values({...})` call in `createMusicItemDirect`, add:

```ts
musicbrainzReleaseId: overrides.musicbrainzReleaseId ?? null,
musicbrainzArtistId: overrides.musicbrainzArtistId ?? null,
```

**Step 2: Update `createMusicItemFromUrl` insert to include MB ID fields**

In the `.values({...})` call in `createMusicItemFromUrl`, add:

```ts
musicbrainzReleaseId: overrides?.musicbrainzReleaseId ?? null,
musicbrainzArtistId: overrides?.musicbrainzArtistId ?? null,
```

**Step 3: Update `fullItemSelect` to include MB ID fields**

Find `fullItemSelect` (around line 25-50) and add:

```ts
musicbrainz_release_id: musicItems.musicbrainzReleaseId,
musicbrainz_artist_id: musicItems.musicbrainzArtistId,
```

**Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS (no errors).

**Step 5: Commit**

```bash
git add server/music-item-creator.ts
git commit -m "feat: persist musicbrainz IDs when creating music items"
```

---

### Task 6: Add `POST /api/release/lookup` endpoint

**Files:**
- Modify: `server/routes/release.ts`
- Modify: `tests/unit/release-route.test.ts`

**Step 1: Write failing tests**

Add a new `describe` block to `tests/unit/release-route.test.ts`:

```ts
import type { MusicBrainzFields } from "../../server/musicbrainz";

// Add mockLookupRelease and mockFetchCoverArt to the top of the test file,
// alongside the existing mocks:
const mockLookupRelease = mock();
const mockFetchCoverArt = mock();

// Update makeApp() to pass these to createReleaseRoutes:
function makeApp(): Hono {
  const app = new Hono();
  app.route(
    "/api/release",
    createReleaseRoutes(mockExtractReleaseInfo, mockSaveImage, mockLookupRelease, mockFetchCoverArt),
  );
  return app;
}

describe("POST /api/release/lookup", () => {
  beforeEach(() => {
    mockLookupRelease.mockReset();
    mockFetchCoverArt.mockReset();
    mockFetchCoverArt.mockResolvedValue(null);
  });

  test("returns 400 when artist is missing", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "OK Computer" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when title is missing", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Radiohead" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns empty object when lookup returns null", async () => {
    mockLookupRelease.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Unknown", title: "Unknown" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test("returns enriched fields on successful lookup", async () => {
    const mbFields: MusicBrainzFields = {
      year: 1997,
      label: "Parlophone",
      country: "GB",
      catalogueNumber: "CDPUSH45",
      musicbrainzReleaseId: "release-uuid",
      musicbrainzArtistId: "artist-uuid",
    };
    mockLookupRelease.mockResolvedValueOnce(mbFields);
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Radiohead", title: "OK Computer" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.year).toBe(1997);
    expect(body.label).toBe("Parlophone");
    expect(body.musicbrainzReleaseId).toBe("release-uuid");
  });

  test("includes artworkUrl when cover art is found", async () => {
    mockLookupRelease.mockResolvedValueOnce({
      year: 2001, label: null, country: null, catalogueNumber: null,
      musicbrainzReleaseId: "release-uuid", musicbrainzArtistId: null,
    });
    mockFetchCoverArt.mockResolvedValueOnce("/uploads/cover.jpg");
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Some Artist", title: "Some Title" }),
    });
    const body = await res.json();
    expect(body.artworkUrl).toBe("/uploads/cover.jpg");
  });

  test("passes year hint to lookupRelease when provided", async () => {
    mockLookupRelease.mockResolvedValueOnce(null);
    const app = makeApp();
    await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Radiohead", title: "OK Computer", year: "1997" }),
    });
    expect(mockLookupRelease).toHaveBeenCalledWith("Radiohead", "OK Computer", "1997");
  });

  test("returns empty object when lookup throws", async () => {
    mockLookupRelease.mockRejectedValueOnce(new Error("timeout"));
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Radiohead", title: "OK Computer" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
bun test tests/unit/release-route.test.ts
```

Expected: FAIL on all new tests (route not found, and `createReleaseRoutes` signature mismatch).

**Step 3: Update `server/routes/release.ts`**

Add new type imports and extend `createReleaseRoutes`:

```ts
import { lookupRelease } from "../musicbrainz";
import { fetchAndSaveCoverArt } from "../cover-art-archive";
import type { MusicBrainzFields } from "../musicbrainz";

export type LookupReleaseFn = (
  artist: string,
  title: string,
  year?: string,
) => Promise<MusicBrainzFields | null>;

export type FetchCoverArtFn = (
  releaseId: string,
  saveImage: SaveReleaseImageFn,
) => Promise<string | null>;
```

Add the two new parameters to `createReleaseRoutes` with defaults:

```ts
export function createReleaseRoutes(
  scanReleaseCover: ExtractAlbumInfoFn = createScanEnricher(extractAlbumInfo, lookupRelease),
  saveImage: SaveReleaseImageFn = saveReleaseImage,
  lookupReleaseFn: LookupReleaseFn = lookupRelease,
  fetchCoverArtFn: FetchCoverArtFn = fetchAndSaveCoverArt,
): Hono {
```

Add the new route inside `createReleaseRoutes`, before `return routes`:

```ts
routes.post("/lookup", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  const { artist, title, year } = body as Record<string, unknown>;

  if (typeof artist !== "string" || !artist.trim()) {
    return c.json({ error: "artist is required" }, 400);
  }

  if (typeof title !== "string" || !title.trim()) {
    return c.json({ error: "title is required" }, 400);
  }

  const yearHint = typeof year === "string" && year.trim() ? year.trim() : undefined;

  try {
    const mbFields = await lookupReleaseFn(artist.trim(), title.trim(), yearHint);
    if (!mbFields) {
      return c.json({}, 200);
    }

    const result: Record<string, unknown> = { ...mbFields };

    if (mbFields.musicbrainzReleaseId) {
      const artworkUrl = await fetchCoverArtFn(mbFields.musicbrainzReleaseId, saveImage);
      if (artworkUrl) {
        result.artworkUrl = artworkUrl;
      }
    }

    return c.json(result, 200);
  } catch {
    return c.json({}, 200);
  }
});
```

**Step 4: Run all release route tests**

```bash
bun test tests/unit/release-route.test.ts
```

Expected: All PASS (including existing scan and image tests — they use the first two args only so defaults are unchanged).

**Step 5: Commit**

```bash
git add server/routes/release.ts tests/unit/release-route.test.ts
git commit -m "feat: add POST /api/release/lookup endpoint"
```

---

### Task 7: Add `ApiClient.lookupRelease` method

**Files:**
- Modify: `src/services/api-client.ts`
- Modify: `src/types/index.ts`

**Step 1: Add `LookupReleaseResult` type to `src/types/index.ts`**

```ts
export interface LookupReleaseResult {
  year?: number | null;
  label?: string | null;
  country?: string | null;
  catalogueNumber?: string | null;
  musicbrainzReleaseId?: string | null;
  musicbrainzArtistId?: string | null;
  artworkUrl?: string;
}
```

**Step 2: Add `lookupRelease` to `ApiClient` in `src/services/api-client.ts`**

Import `LookupReleaseResult` at the top, then add the method in the `// ── Release Scan ──` section:

```ts
async lookupRelease(
  artist: string,
  title: string,
  year?: string,
): Promise<LookupReleaseResult> {
  const body: Record<string, string> = { artist, title };
  if (year) body.year = year;

  try {
    return await this.requestJson<LookupReleaseResult>(
      "/api/release/lookup",
      "lookupRelease",
      this.jsonRequest("POST", body),
    );
  } catch {
    return {};
  }
}
```

Note: errors are swallowed here — the client treats a failed lookup as no enrichment.

**Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/services/api-client.ts src/types/index.ts
git commit -m "feat: add ApiClient.lookupRelease method"
```

---

### Task 8: Enrich form values on submit in `src/app.ts`

**Files:**
- Modify: `src/app.ts`

**Step 1: Locate the form submit handler**

In `src/app.ts`, find the `form.addEventListener("submit", ...)` handler around line 180. The relevant section is:

```ts
const formData = new FormData(form);
const values = this.readAddFormValues(formData);

try {
  const item = await this.api.createMusicItem({
    ...buildCreateMusicItemInputFromValues(values),
    listenStatus: "to-listen",
  });
```

**Step 2: Add enrichment between reading values and creating the item**

Replace the above with:

```ts
const formData = new FormData(form);
const values = this.readAddFormValues(formData);

if (values.artist.trim() && values.title.trim()) {
  try {
    const enrichment = await this.api.lookupRelease(
      values.artist.trim(),
      values.title.trim(),
      values.year.trim() || undefined,
    );

    if (enrichment.year != null && !values.year.trim()) {
      values.year = String(enrichment.year);
    }
    if (enrichment.label && !values.label.trim()) {
      values.label = enrichment.label;
    }
    if (enrichment.country && !values.country.trim()) {
      values.country = enrichment.country;
    }
    if (enrichment.catalogueNumber && !values.catalogueNumber.trim()) {
      values.catalogueNumber = enrichment.catalogueNumber;
    }
    if (enrichment.artworkUrl && !values.artworkUrl.trim()) {
      values.artworkUrl = enrichment.artworkUrl;
    }
  } catch {
    // Enrichment failure is non-fatal — continue with user-entered values
  }
}

try {
  const item = await this.api.createMusicItem({
    ...buildCreateMusicItemInputFromValues(values),
    listenStatus: "to-listen",
    musicbrainzReleaseId: enrichmentResult?.musicbrainzReleaseId ?? undefined,
    musicbrainzArtistId: enrichmentResult?.musicbrainzArtistId ?? undefined,
  });
```

Wait — the MB IDs need to be preserved outside the try/catch block. Refactor slightly:

```ts
const formData = new FormData(form);
const values = this.readAddFormValues(formData);
let mbReleaseId: string | undefined;
let mbArtistId: string | undefined;

if (values.artist.trim() && values.title.trim()) {
  try {
    const enrichment = await this.api.lookupRelease(
      values.artist.trim(),
      values.title.trim(),
      values.year.trim() || undefined,
    );

    if (enrichment.year != null && !values.year.trim()) {
      values.year = String(enrichment.year);
    }
    if (enrichment.label && !values.label.trim()) {
      values.label = enrichment.label;
    }
    if (enrichment.country && !values.country.trim()) {
      values.country = enrichment.country;
    }
    if (enrichment.catalogueNumber && !values.catalogueNumber.trim()) {
      values.catalogueNumber = enrichment.catalogueNumber;
    }
    if (enrichment.artworkUrl && !values.artworkUrl.trim()) {
      values.artworkUrl = enrichment.artworkUrl;
    }
    if (enrichment.musicbrainzReleaseId) {
      mbReleaseId = enrichment.musicbrainzReleaseId;
    }
    if (enrichment.musicbrainzArtistId) {
      mbArtistId = enrichment.musicbrainzArtistId;
    }
  } catch {
    // non-fatal
  }
}

try {
  const item = await this.api.createMusicItem({
    ...buildCreateMusicItemInputFromValues(values),
    listenStatus: "to-listen",
    musicbrainzReleaseId: mbReleaseId,
    musicbrainzArtistId: mbArtistId,
  });
```

**Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

**Step 4: Run all unit tests**

```bash
bun test tests/unit
```

Expected: All PASS.

**Step 5: Commit**

```bash
git add src/app.ts
git commit -m "feat: enrich manual add with MusicBrainz lookup on submit"
```

---

### Task 9: Update music-items update route for MB IDs (optional but complete)

**Files:**
- Modify: `server/routes/music-items.ts`

**Step 1: Add MB ID fields to `DIRECT_UPDATE_FIELDS`**

In `server/routes/music-items.ts`, find `DIRECT_UPDATE_FIELDS` (around line 33) and add:

```ts
| "musicbrainzReleaseId"
| "musicbrainzArtistId"
```

to the union type, and add the string values to the array:

```ts
"musicbrainzReleaseId",
"musicbrainzArtistId",
```

**Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

**Step 3: Run all unit tests**

```bash
bun test tests/unit
```

Expected: All PASS.

**Step 4: Commit**

```bash
git add server/routes/music-items.ts
git commit -m "feat: allow updating musicbrainz IDs on existing items"
```

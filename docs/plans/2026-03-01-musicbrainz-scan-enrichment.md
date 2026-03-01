# MusicBrainz Scan Enrichment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After Mistral returns `{ artist, title }` from a cover scan, query MusicBrainz for the best-matching release and return an enriched `ScanResult` with `year`, `label`, `country`, and `catalogueNumber` — silently falling back to the Mistral-only result if MusicBrainz is unavailable or finds nothing.

**Architecture:** A new `server/musicbrainz.ts` module wraps the MusicBrainz search API. A new `server/scan-enricher.ts` composes Mistral + MusicBrainz into a single pipeline. The existing `/api/release/scan` route's injectable function is updated to accept the enricher (same signature, no client changes).

**Tech Stack:** Bun, Hono, TypeScript. Tests use `bun:test` with `spyOn(globalThis, "fetch")` for HTTP mocking. No new dependencies.

---

### Task 1: Expand `ScanResult` with optional enrichment fields

**Files:**
- Modify: `src/types/index.ts` (around line 127)

**Step 1: Update the type**

Replace:
```ts
export interface ScanResult {
  artist: string | null;
  title: string | null;
}
```
With:
```ts
export interface ScanResult {
  artist: string | null;
  title: string | null;
  year?: number | null;
  label?: string | null;
  country?: string | null;
  catalogueNumber?: string | null;
}
```

**Step 2: Run typecheck to confirm no regressions**

```bash
bun run typecheck
```
Expected: no errors (the new fields are optional, so all existing usages remain valid).

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add optional enrichment fields to ScanResult"
```

---

### Task 2: Create `server/musicbrainz.ts` — MusicBrainz API client

**Files:**
- Create: `server/musicbrainz.ts`
- Create: `tests/unit/musicbrainz.test.ts`

**Step 1: Write the failing tests first**

Create `tests/unit/musicbrainz.test.ts`:

```ts
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { lookupRelease } from "../../server/musicbrainz";

function makeMbResponse(releases: unknown[]): Response {
  return new Response(JSON.stringify({ releases }), {
    headers: { "content-type": "application/json" },
  });
}

describe("lookupRelease", () => {
  afterEach(() => {
    // restore any spies
  });

  test("returns parsed fields from the first matching release", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbResponse([
        {
          title: "OK Computer",
          date: "1997-05-21",
          country: "GB",
          "label-info": [
            {
              "catalog-number": "CDPUSH45",
              label: { name: "Parlophone" },
            },
          ],
        },
      ]),
    );

    const result = await lookupRelease("Radiohead", "OK Computer");
    expect(result).toEqual({
      year: 1997,
      label: "Parlophone",
      country: "GB",
      catalogueNumber: "CDPUSH45",
    });
  });

  test("returns null when releases array is empty", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(makeMbResponse([]));

    const result = await lookupRelease("Unknown", "Unknown");
    expect(result).toBeNull();
  });

  test("returns null on non-200 response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 }),
    );

    const result = await lookupRelease("Radiohead", "OK Computer");
    expect(result).toBeNull();
  });

  test("returns null when fetch throws", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));

    const result = await lookupRelease("Radiohead", "OK Computer");
    expect(result).toBeNull();
  });

  test("handles missing label-info gracefully", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbResponse([
        {
          title: "Some Album",
          date: "2010",
          country: "US",
        },
      ]),
    );

    const result = await lookupRelease("Some Artist", "Some Album");
    expect(result).toEqual({
      year: 2010,
      label: null,
      country: "US",
      catalogueNumber: null,
    });
  });

  test("sends a valid User-Agent header", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbResponse([]),
    );

    await lookupRelease("Artist", "Title");
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("User-Agent")).toContain("on-the-beach");
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
bun run test:unit --testPathPattern musicbrainz
```
Expected: FAIL — `Cannot find module '../../server/musicbrainz'`

**Step 3: Implement `server/musicbrainz.ts`**

Create `server/musicbrainz.ts`:

```ts
const MB_API_BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "on-the-beach/1.0 (https://github.com/your-repo)";

export interface MusicBrainzFields {
  year: number | null;
  label: string | null;
  country: string | null;
  catalogueNumber: string | null;
}

interface MbLabelInfo {
  "catalog-number"?: unknown;
  label?: { name?: unknown };
}

interface MbRelease {
  date?: unknown;
  country?: unknown;
  "label-info"?: unknown;
}

interface MbSearchResponse {
  releases?: unknown[];
}

function parseYear(date: unknown): number | null {
  if (typeof date !== "string" || date.length < 4) return null;
  const year = parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function parseLabelInfo(
  labelInfo: unknown,
): { label: string | null; catalogueNumber: string | null } {
  if (!Array.isArray(labelInfo) || labelInfo.length === 0) {
    return { label: null, catalogueNumber: null };
  }

  const first = labelInfo[0] as MbLabelInfo;
  const label =
    first.label && typeof first.label.name === "string" ? first.label.name : null;
  const catalogueNumber =
    typeof first["catalog-number"] === "string" ? first["catalog-number"] : null;

  return { label, catalogueNumber };
}

export async function lookupRelease(
  artist: string,
  title: string,
): Promise<MusicBrainzFields | null> {
  const query = `artist:${encodeURIComponent(artist)} AND release:${encodeURIComponent(title)}`;
  const url = `${MB_API_BASE}/release?query=${query}&limit=1&fmt=json`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.warn(`[musicbrainz] Search returned ${response.status}`);
      return null;
    }

    const data = (await response.json()) as MbSearchResponse;

    if (!Array.isArray(data.releases) || data.releases.length === 0) {
      return null;
    }

    const release = data.releases[0] as MbRelease;
    const { label, catalogueNumber } = parseLabelInfo(release["label-info"]);
    const country = typeof release.country === "string" ? release.country : null;

    return {
      year: parseYear(release.date),
      label,
      country,
      catalogueNumber,
    };
  } catch (err) {
    console.error("[musicbrainz] Lookup failed:", err);
    return null;
  }
}
```

**Step 4: Run tests and confirm they pass**

```bash
bun run test:unit --testPathPattern musicbrainz
```
Expected: all 6 tests PASS.

**Step 5: Commit**

```bash
git add server/musicbrainz.ts tests/unit/musicbrainz.test.ts
git commit -m "feat: add MusicBrainz release lookup client"
```

---

### Task 3: Create `server/scan-enricher.ts` — compose Mistral + MusicBrainz

**Files:**
- Create: `server/scan-enricher.ts`
- Create: `tests/unit/scan-enricher.test.ts`

**Step 1: Write the failing tests first**

Create `tests/unit/scan-enricher.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { createScanEnricher } from "../../server/scan-enricher";
import type { ScanResult } from "../../src/types";
import type { MusicBrainzFields } from "../../server/musicbrainz";

describe("createScanEnricher", () => {
  const mistralResult: ScanResult = { artist: "Radiohead", title: "OK Computer" };
  const mbFields: MusicBrainzFields = {
    year: 1997,
    label: "Parlophone",
    country: "GB",
    catalogueNumber: "CDPUSH45",
  };

  test("returns merged result when both Mistral and MusicBrainz succeed", async () => {
    const mockExtract = mock().mockResolvedValueOnce(mistralResult);
    const mockLookup = mock().mockResolvedValueOnce(mbFields);
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toEqual({
      artist: "Radiohead",
      title: "OK Computer",
      year: 1997,
      label: "Parlophone",
      country: "GB",
      catalogueNumber: "CDPUSH45",
    });
    expect(mockLookup).toHaveBeenCalledWith("Radiohead", "OK Computer");
  });

  test("returns Mistral-only result when MusicBrainz returns null", async () => {
    const mockExtract = mock().mockResolvedValueOnce(mistralResult);
    const mockLookup = mock().mockResolvedValueOnce(null);
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toEqual(mistralResult);
  });

  test("returns Mistral-only result when MusicBrainz throws", async () => {
    const mockExtract = mock().mockResolvedValueOnce(mistralResult);
    const mockLookup = mock().mockRejectedValueOnce(new Error("timeout"));
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toEqual(mistralResult);
  });

  test("returns null when Mistral returns null (does not call MusicBrainz)", async () => {
    const mockExtract = mock().mockResolvedValueOnce(null);
    const mockLookup = mock();
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toBeNull();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test("skips MusicBrainz lookup when artist is null", async () => {
    const mockExtract = mock().mockResolvedValueOnce({ artist: null, title: "Unknown" });
    const mockLookup = mock();
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toEqual({ artist: null, title: "Unknown" });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test("skips MusicBrainz lookup when title is null", async () => {
    const mockExtract = mock().mockResolvedValueOnce({ artist: "Someone", title: null });
    const mockLookup = mock();
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toEqual({ artist: "Someone", title: null });
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
bun run test:unit --testPathPattern scan-enricher
```
Expected: FAIL — `Cannot find module '../../server/scan-enricher'`

**Step 3: Implement `server/scan-enricher.ts`**

Create `server/scan-enricher.ts`:

```ts
import type { ScanResult } from "../src/types";
import type { MusicBrainzFields } from "./musicbrainz";

type ExtractFn = (base64Image: string) => Promise<ScanResult | null>;
type LookupFn = (artist: string, title: string) => Promise<MusicBrainzFields | null>;

export function createScanEnricher(
  extract: ExtractFn,
  lookup: LookupFn,
): (base64Image: string) => Promise<ScanResult | null> {
  return async (base64Image: string): Promise<ScanResult | null> => {
    const mistralResult = await extract(base64Image);
    if (!mistralResult) return null;

    if (!mistralResult.artist || !mistralResult.title) {
      return mistralResult;
    }

    try {
      const mbFields = await lookup(mistralResult.artist, mistralResult.title);
      if (!mbFields) return mistralResult;
      return { ...mistralResult, ...mbFields };
    } catch {
      return mistralResult;
    }
  };
}
```

**Step 4: Run tests and confirm they pass**

```bash
bun run test:unit --testPathPattern scan-enricher
```
Expected: all 6 tests PASS.

**Step 5: Commit**

```bash
git add server/scan-enricher.ts tests/unit/scan-enricher.test.ts
git commit -m "feat: add scan enricher composing Mistral and MusicBrainz"
```

---

### Task 4: Wire the enricher into the release route

**Files:**
- Modify: `server/routes/release.ts`
- Modify: `server/index.ts` (wherever `releaseRoutes` is created)
- Modify: `tests/unit/release-route.test.ts`

**Step 1: Check which file instantiates `releaseRoutes`**

Open `server/index.ts` and find the line that imports/uses `releaseRoutes`. It will look like:
```ts
import { releaseRoutes } from "./routes/release";
```
The named export `releaseRoutes` at the bottom of `release.ts` is `createReleaseRoutes()` with default arguments. We'll update that default to use the enricher.

**Step 2: Update `server/routes/release.ts`**

At the top, add the enricher import and swap the default for `scanReleaseCover`:

```ts
// Add these imports at the top:
import { extractAlbumInfo } from "../vision";
import { lookupRelease } from "../musicbrainz";
import { createScanEnricher } from "../scan-enricher";
```

Replace the existing default export line at the bottom:
```ts
// Before:
export const releaseRoutes = createReleaseRoutes();

// After:
export const releaseRoutes = createReleaseRoutes(
  createScanEnricher(extractAlbumInfo, lookupRelease),
);
```

The `createReleaseRoutes` signature and route logic stays unchanged — the enricher has the same `(base64Image: string) => Promise<ScanResult | null>` signature.

**Step 3: Run the existing release-route tests**

```bash
bun run test:unit --testPathPattern release-route
```
Expected: all tests still PASS — the mock injected in tests already satisfies the same function signature.

**Step 4: Add one integration-style test to `release-route.test.ts` confirming enriched fields pass through**

In the `POST /api/release/scan` describe block, add:

```ts
test("returns enriched fields when scan function returns them", async () => {
  mockExtractAlbumInfo.mockResolvedValueOnce({
    artist: "Radiohead",
    title: "OK Computer",
    year: 1997,
    label: "Parlophone",
    country: "GB",
    catalogueNumber: "CDPUSH45",
  });

  const app = makeApp();

  const res = await app.request("http://localhost/api/release/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64: "YWJjZA==" }),
  });

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
    artist: "Radiohead",
    title: "OK Computer",
    year: 1997,
    label: "Parlophone",
    country: "GB",
    catalogueNumber: "CDPUSH45",
  });
});
```

**Step 5: Run all unit tests to confirm nothing is broken**

```bash
bun run test:unit
```
Expected: all tests PASS.

**Step 6: Commit**

```bash
git add server/routes/release.ts tests/unit/release-route.test.ts
git commit -m "feat: wire MusicBrainz enricher into release scan route"
```

---

### Task 5: Final verification

**Step 1: Run full test suite**

```bash
bun run test:unit
```
Expected: all tests PASS.

**Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: no errors.

**Step 3: Verify the app starts**

```bash
bun run dev
```
Expected: server starts on port 3000 with no errors.

**Step 4: Final commit (if any loose files)**

```bash
git status
```
If clean: nothing to do. If there are any straggler changes, stage and commit them.

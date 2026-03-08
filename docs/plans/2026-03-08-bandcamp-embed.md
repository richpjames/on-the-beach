# Bandcamp Embed Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Embed a Bandcamp player iframe on the release page for items whose primary link is a Bandcamp URL.

**Architecture:** Add a `metadata TEXT` (JSON) column to `music_links` to store source-specific IDs. When scraping a Bandcamp URL, extract the numeric album/track ID from the page HTML and persist it in `metadata`. On the release page, if a Bandcamp `album_id` is present in `metadata`, render the embed iframe.

**Tech Stack:** Bun, Hono, Drizzle ORM (SQLite), TypeScript. Tests use `bun:test`. Run tests with `bun test tests/unit`. E2E tests use Playwright (`bun test:e2e`).

**Design doc:** `docs/plans/2026-03-08-bandcamp-embed-design.md`

---

### Task 1: DB migration — add `metadata` column to `music_links`

**Files:**
- Create: `drizzle/0005_bandcamp_embed_metadata.sql`
- Modify: `server/db/schema.ts`

**Step 1: Write the migration SQL**

Create `drizzle/0005_bandcamp_embed_metadata.sql`:
```sql
ALTER TABLE `music_links` ADD `metadata` text;
```

**Step 2: Update the Drizzle schema**

In `server/db/schema.ts`, add `metadata` to the `musicLinks` table definition (after the `isPrimary` field):
```ts
metadata: text("metadata"),
```

**Step 3: Apply the migration**

```bash
bun run db:migrate 2>/dev/null || bun server/db/migrate.ts
```

If neither works, check `package.json` for the migrate script name and run it. The migration adds a nullable `metadata` column — existing rows are unaffected.

**Step 4: Commit**

```bash
git add drizzle/0005_bandcamp_embed_metadata.sql server/db/schema.ts
git commit -m "feat: add metadata column to music_links"
```

---

### Task 2: Extract Bandcamp embed metadata in the scraper

**Files:**
- Modify: `server/scraper.ts`
- Test: `tests/unit/scraper.test.ts`

**Context:** `ScrapedMetadata` is defined at the top of `server/scraper.ts`. `parseBandcampOg` is the existing Bandcamp parser. `scrapeUrl` is the main entry point — it calls `parseBandcampOg` for the `bandcamp` source at line ~874.

The Bandcamp page HTML contains the numeric ID in one of two places:
1. `<meta name="bc-page-properties" content='{"item_type":"album","item_id":1234567}'>`
2. A JS block: `TralbumData = {` ... `"id" : 1234567`

**Step 1: Write failing tests**

In `tests/unit/scraper.test.ts`, add a new `describe` block:

```ts
describe("extractBandcampEmbedMetadata", () => {
  test("extracts album_id from bc-page-properties meta tag", () => {
    const html = `<meta name="bc-page-properties" content='{"item_type":"album","item_id":1536701931}'>`;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "1536701931",
      item_type: "album",
    });
  });

  test("extracts album_id from TralbumData JS block as fallback", () => {
    const html = `<script>TralbumData = {"id" : 9876543, "item_type" : "track"}</script>`;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "9876543",
      item_type: "track",
    });
  });

  test("returns null when no ID found", () => {
    expect(extractBandcampEmbedMetadata("<html><body>no id here</body></html>")).toBeNull();
  });

  test("prefers bc-page-properties over TralbumData", () => {
    const html = `
      <meta name="bc-page-properties" content='{"item_type":"album","item_id":111}'>
      <script>TralbumData = {"id" : 999}</script>
    `;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "111",
      item_type: "album",
    });
  });
});
```

Also add a test that `scrapeUrl` for bandcamp populates `embedMetadata` (using a mocked fetch):

```ts
describe("scrapeUrl bandcamp embedMetadata", () => {
  test("populates embedMetadata when bc-page-properties is present", async () => {
    const html = `
      <head>
        <meta property="og:title" content="My Album, by Artist" />
        <meta name="bc-page-properties" content='{"item_type":"album","item_id":1234567}'>
      </head>
    `;
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(html, { headers: { "content-type": "text/html" } }),
    );
    const result = await scrapeUrl("https://artist.bandcamp.com/album/my-album", "bandcamp");
    expect(result?.embedMetadata).toEqual({ album_id: "1234567", item_type: "album" });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test tests/unit/scraper.test.ts --test-name-pattern "extractBandcampEmbedMetadata|embedMetadata"
```

Expected: FAIL — `extractBandcampEmbedMetadata is not exported`

**Step 3: Implement `extractBandcampEmbedMetadata`**

Add to `server/scraper.ts`, after the `parseBandcampOg` function:

```ts
export function extractBandcampEmbedMetadata(
  html: string,
): Record<string, string> | null {
  // Primary: <meta name="bc-page-properties" content='{"item_type":"album","item_id":123}'>
  const metaMatch = html.match(
    /<meta\s+name=["']bc-page-properties["']\s+content=["']([^"']+)["']/i,
  );
  if (metaMatch) {
    try {
      const parsed = JSON.parse(metaMatch[1]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const id = obj.item_id;
        const type = obj.item_type;
        if (typeof id === "number" && Number.isFinite(id)) {
          return {
            album_id: String(id),
            ...(typeof type === "string" ? { item_type: type } : {}),
          };
        }
      }
    } catch {
      // fall through to TralbumData
    }
  }

  // Fallback: TralbumData = { "id" : 123, "item_type" : "album" }
  const tralbumIdMatch = html.match(/TralbumData\s*=\s*\{[^}]*"id"\s*:\s*(\d+)/);
  const tralbumTypeMatch = html.match(/TralbumData\s*=\s*\{[^}]*"item_type"\s*:\s*"([^"]+)"/);
  if (tralbumIdMatch) {
    return {
      album_id: tralbumIdMatch[1],
      ...(tralbumTypeMatch ? { item_type: tralbumTypeMatch[1] } : {}),
    };
  }

  return null;
}
```

**Step 4: Add `embedMetadata` to `ScrapedMetadata`**

In `server/scraper.ts`, update the `ScrapedMetadata` interface:

```ts
export interface ScrapedMetadata {
  potentialArtist?: string;
  potentialTitle?: string;
  itemType?: ItemType;
  imageUrl?: string;
  releases?: ExtractedReleaseCandidate[];
  embedMetadata?: Record<string, string>;  // add this line
}
```

**Step 5: Call it in `scrapeUrl`**

Inside `scrapeUrl`, in the `bandcamp` branch where `parser(og)` is called (around line ~874), the default parser path is used. We need to also call `extractBandcampEmbedMetadata` after reading the HTML.

Find the section near the end of `scrapeUrl` that falls through to:
```ts
const parser = SOURCE_PARSERS[source] || parseDefaultOg;
return parser(og);
```

Replace the `return parser(og)` call with:
```ts
const result = parser(og);
if (source === "bandcamp" && result) {
  result.embedMetadata = extractBandcampEmbedMetadata(html) ?? undefined;
}
return result;
```

**Step 6: Run tests to verify they pass**

```bash
bun test tests/unit/scraper.test.ts --test-name-pattern "extractBandcampEmbedMetadata|embedMetadata"
```

Expected: PASS

**Step 7: Run full unit test suite to check for regressions**

```bash
bun test tests/unit/scraper.test.ts
```

Expected: all pass

**Step 8: Commit**

```bash
git add server/scraper.ts tests/unit/scraper.test.ts
git commit -m "feat: extract Bandcamp embed metadata during scrape"
```

---

### Task 3: Persist `metadata` when saving a music link

**Files:**
- Modify: `server/music-item-creator.ts`
- Test: `tests/unit/` — no direct unit test for DB insertion; covered by integration. Add a focused unit test by checking the insert values.

**Context:** `insertMusicItemWithLink` in `server/music-item-creator.ts` (around line 191) does the `db.insert(musicLinks)` call. It receives a `candidate` (type `ReleaseCandidateInput`) and `overrides`. The scraped `embedMetadata` needs to flow from `scrapeUrl` → `resolveReleaseCandidates` → `insertMusicItemWithLink`.

**Step 1: Extend `ReleaseCandidateInput`**

In `server/music-item-creator.ts`, add `embedMetadata` to the `ReleaseCandidateInput` interface:

```ts
interface ReleaseCandidateInput {
  candidateId?: string;
  title: string;
  artistName?: string;
  itemType: ItemType;
  artworkUrl?: string | null;
  confidence?: number;
  evidence?: string;
  isPrimary?: boolean;
  embedMetadata?: Record<string, string>;  // add this line
}
```

**Step 2: Pass `embedMetadata` from scraped result in `resolveReleaseCandidates`**

In `resolveReleaseCandidates` (around line 251), the `candidates` array is built for known sources. In the `parsed.source !== "unknown"` branch, add `embedMetadata`:

```ts
candidates: [
  {
    title,
    artistName,
    itemType: overrides?.itemType ?? scraped?.itemType ?? "album",
    artworkUrl: overrides?.artworkUrl ?? scraped?.imageUrl ?? null,
    embedMetadata: scraped?.embedMetadata,  // add this line
  },
],
```

**Step 3: Write `metadata` JSON on insert**

In `insertMusicItemWithLink`, update the `db.insert(musicLinks).values(...)` call:

```ts
await db.insert(musicLinks).values({
  musicItemId: inserted.id,
  sourceId,
  url: normalizedUrl,
  isPrimary: true,
  metadata: candidate.embedMetadata ? JSON.stringify(candidate.embedMetadata) : null,  // add this line
});
```

**Step 4: Run unit tests to check nothing broke**

```bash
bun test tests/unit
```

Expected: all pass

**Step 5: Commit**

```bash
git add server/music-item-creator.ts
git commit -m "feat: persist embed metadata when saving music link"
```

---

### Task 4: Surface `primary_link_metadata` in queries and types

**Files:**
- Modify: `server/music-item-creator.ts` (the `fullItemSelect` function)
- Modify: `src/types/index.ts`
- Test: `tests/unit/release-page-route.test.ts`

**Step 1: Add `primary_link_metadata` to `MusicItemFull`**

In `src/types/index.ts`, add to the `MusicItemFull` interface:

```ts
export interface MusicItemFull extends MusicItem {
  artist_name: string | null;
  primary_url: string | null;
  primary_source: SourceName | null;
  primary_link_metadata: string | null;  // add this line
  stacks: Array<{ id: number; name: string }>;
}
```

**Step 2: Include `primary_link_metadata` in `fullItemSelect`**

In `server/music-item-creator.ts`, in the `fullItemSelect` function, add to the `db.select({...})` object:

```ts
primary_link_metadata: musicLinks.metadata,
```

**Step 3: Run unit tests**

```bash
bun test tests/unit
```

TypeScript may surface type errors in tests that construct mock `MusicItemFull` objects — they'll need `primary_link_metadata: null` added. Fix each one.

**Step 4: Fix mock objects in tests**

Search for all places that construct a `MusicItemFull`-shaped object in tests:

```bash
grep -r "primary_source" tests/unit/ -l
```

In each file found, add `primary_link_metadata: null` alongside the existing `primary_source: null` field.

**Step 5: Run unit tests again**

```bash
bun test tests/unit
```

Expected: all pass

**Step 6: Commit**

```bash
git add src/types/index.ts server/music-item-creator.ts tests/unit/
git commit -m "feat: surface primary_link_metadata on MusicItemFull"
```

---

### Task 5: Render the Bandcamp embed on the release page

**Files:**
- Modify: `server/routes/release-page.ts`
- Test: `tests/unit/release-page-route.test.ts`

**Context:** `renderReleasePage` builds the HTML string for `/r/:id`. The `item` is a `MusicItemFull` and now has `primary_link_metadata`. The Bandcamp embed iframe format is:
```
https://bandcamp.com/EmbeddedPlayer/{type}={id}/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/transparent=true/
```
Where `{type}` is `album` or `track` (from `metadata.item_type` or from the URL path), and `{id}` is `metadata.album_id`.

**Step 1: Write failing tests**

In `tests/unit/release-page-route.test.ts`, add:

```ts
describe("Bandcamp embed", () => {
  test("renders embed iframe when primary_source is bandcamp and metadata has album_id", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://artist.bandcamp.com/album/my-album",
      primary_source: "bandcamp" as const,
      primary_link_metadata: JSON.stringify({ album_id: "1536701931", item_type: "album" }),
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("bandcamp.com/EmbeddedPlayer/album=1536701931");
    expect(html).toContain("<iframe");
  });

  test("does not render embed when primary_source is not bandcamp", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://open.spotify.com/album/abc",
      primary_source: "spotify" as const,
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).not.toContain("bandcamp.com/EmbeddedPlayer");
  });

  test("does not render embed when metadata has no album_id", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://artist.bandcamp.com/album/my-album",
      primary_source: "bandcamp" as const,
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).not.toContain("bandcamp.com/EmbeddedPlayer");
  });

  test("falls back to album type when item_type not in metadata", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://artist.bandcamp.com/album/my-album",
      primary_source: "bandcamp" as const,
      primary_link_metadata: JSON.stringify({ album_id: "9999" }),
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("bandcamp.com/EmbeddedPlayer/album=9999");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test tests/unit/release-page-route.test.ts --test-name-pattern "Bandcamp embed"
```

Expected: FAIL — embed iframe not present in HTML

**Step 3: Add a helper to build the embed HTML**

Add this function to `server/routes/release-page.ts`, near the top with the other helpers:

```ts
function parseLinkMetadata(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore
  }
  return null;
}

function renderBandcampEmbed(item: MusicItemFull): string {
  const meta = parseLinkMetadata(item.primary_link_metadata);
  const albumId = meta?.album_id;
  if (!albumId) return "";

  const embedType = meta.item_type === "track" ? "track" : "album";
  const src = `https://bandcamp.com/EmbeddedPlayer/${embedType}=${escapeHtml(albumId)}/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/transparent=true/`;

  return `<iframe
    class="release-page__bandcamp-embed"
    src="${src}"
    seamless
    style="border:0;width:100%;height:472px;"
    title="Bandcamp player"
  ></iframe>`;
}
```

**Step 4: Call the embed renderer in `renderReleasePage`**

Inside `renderReleasePage`, in the `view-mode` div, add the embed after the source link line (around line 122):

```ts
${item.primary_source === "bandcamp" ? renderBandcampEmbed(item) : ""}
```

Place it after:
```ts
${item.primary_url ? `<a class="release-page__source-link" ...` : ""}
```

**Step 5: Run tests to verify they pass**

```bash
bun test tests/unit/release-page-route.test.ts --test-name-pattern "Bandcamp embed"
```

Expected: PASS

**Step 6: Run full unit suite**

```bash
bun test tests/unit
```

Expected: all pass

**Step 7: Commit**

```bash
git add server/routes/release-page.ts tests/unit/release-page-route.test.ts
git commit -m "feat: render Bandcamp embed iframe on release page"
```

---

### Task 6: Manual smoke test + optional E2E

**Step 1: Start the dev server**

```bash
bun run dev
```

**Step 2: Add a real Bandcamp link via the UI**

Open `http://localhost:3000`, paste a Bandcamp album URL (e.g. `https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue`), click Add.

**Step 3: View the release page**

Click through to the release page. Verify the Bandcamp embed player appears and is playable.

**Step 4: Check that non-Bandcamp items are unaffected**

Add a Spotify link, verify its release page has no embed iframe.

**Step 5: Run E2E tests to check for regressions**

```bash
bun test:e2e playwright/bandcamp-link.spec.ts
```

Expected: all pass (existing tests cover the add-link flow; the embed is additive).

**Step 6: Commit if any test fixes were needed**

```bash
git add .
git commit -m "test: verify Bandcamp embed smoke test passes"
```

# Suggest Next Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a user marks a release as 'listened', prompt them to add another release by the same artist — pre-fetched from MusicBrainz at add-time so the suggestion feels instant.

**Architecture:** On item creation (status `to-listen`), fire a background MusicBrainz lookup for the artist's other releases, pick the one closest in year to the item just added, and store it in a new `item_suggestions` table. When `PATCH /:id` sets status to `listened`, include any pending suggestion in the response. The client shows a dismissible banner with Accept / Dismiss actions.

**Tech Stack:** Bun, Hono, Drizzle ORM (SQLite), XState, vanilla TS frontend, MusicBrainz API, bun:test.

---

### Task 1: DB migration — `item_suggestions` table

**Files:**
- Create: `drizzle/0006_item_suggestions.sql`
- Modify: `server/db/schema.ts`

**Step 1: Write the migration SQL**

```sql
CREATE TABLE `item_suggestions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `source_item_id` integer NOT NULL REFERENCES `music_items`(`id`) ON DELETE CASCADE,
  `title` text NOT NULL,
  `artist_name` text NOT NULL,
  `item_type` text NOT NULL DEFAULT 'album',
  `year` integer,
  `musicbrainz_release_id` text,
  `status` text NOT NULL DEFAULT 'pending',
  `created_at` integer NOT NULL
);
CREATE INDEX `idx_item_suggestions_source_item_id` ON `item_suggestions` (`source_item_id`);
```

**Step 2: Add Drizzle table definition to `server/db/schema.ts`**

Add after the `stackParents` table definition:

```ts
export const itemSuggestions = sqliteTable(
  "item_suggestions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceItemId: integer("source_item_id")
      .notNull()
      .references(() => musicItems.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    artistName: text("artist_name").notNull(),
    itemType: text("item_type").notNull().default("album"),
    year: integer("year"),
    musicbrainzReleaseId: text("musicbrainz_release_id"),
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_item_suggestions_source_item_id").on(table.sourceItemId),
  ],
);
```

**Step 3: Apply the migration**

```bash
bun run drizzle-kit migrate
# or if using raw SQL: apply the migration file directly against the SQLite DB
```

**Step 4: Verify schema applied**

```bash
sqlite3 on_the_beach.db ".schema item_suggestions"
# Expected: CREATE TABLE `item_suggestions` ...
```

**Step 5: Commit**

```bash
git add drizzle/0006_item_suggestions.sql server/db/schema.ts
git commit -m "feat: add item_suggestions table"
```

---

### Task 2: MusicBrainz — `findSuggestedRelease`

**Files:**
- Modify: `server/musicbrainz.ts`
- Test: `tests/unit/musicbrainz.test.ts`

The function queries MusicBrainz for an artist's releases, filters out already-tracked titles, and returns the release whose year is closest to `sourceYear`. If `mbArtistId` is provided it uses it directly; otherwise it searches by name first.

**Step 1: Write failing tests**

Add to `tests/unit/musicbrainz.test.ts`:

```ts
import { findSuggestedRelease } from "../../server/musicbrainz";

function makeMbArtistSearchResponse(artists: unknown[]): Response {
  return new Response(JSON.stringify({ artists }), {
    headers: { "content-type": "application/json" },
  });
}

function makeMbArtistReleasesResponse(releases: unknown[]): Response {
  return new Response(JSON.stringify({ releases, "release-count": releases.length }), {
    headers: { "content-type": "application/json" },
  });
}

describe("findSuggestedRelease", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns the release closest in year to sourceYear", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Amber", date: "1994" },
        { id: "r2", title: "Tri Repetae", date: "1995" },
        { id: "r3", title: "Chiastic Slide", date: "1997" },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(["amber"]),
      sourceYear: 1996,
    });

    expect(result?.title).toBe("Tri Repetae");
  });

  test("excludes titles already in trackedTitles (normalised)", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Amber", date: "1994" },
        { id: "r2", title: "Tri Repetae", date: "1995" },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(["amber", "tri repetae"]),
      sourceYear: 1994,
    });

    expect(result).toBeNull();
  });

  test("falls back to artist name search when no mbArtistId", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeMbArtistSearchResponse([{ id: "found-artist-uuid", name: "Autechre" }]),
      )
      .mockResolvedValueOnce(
        makeMbArtistReleasesResponse([{ id: "r1", title: "Amber", date: "1994" }]),
      );

    const result = await findSuggestedRelease({
      mbArtistId: null,
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1994,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result?.title).toBe("Amber");
  });

  test("returns null when artist name search finds no artists", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistSearchResponse([]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: null,
      artistName: "Unknown Artist",
      trackedTitles: new Set(),
      sourceYear: 2000,
    });

    expect(result).toBeNull();
  });

  test("falls back to most recent release when sourceYear is null", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Amber", date: "1994" },
        { id: "r2", title: "Tri Repetae", date: "1995" },
        { id: "r3", title: "Chiastic Slide", date: "1997" },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: null,
    });

    expect(result?.title).toBe("Chiastic Slide");
  });

  test("returns null on fetch error", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1995,
    });

    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test tests/unit/musicbrainz.test.ts
# Expected: FAIL — findSuggestedRelease is not exported
```

**Step 3: Implement `findSuggestedRelease` in `server/musicbrainz.ts`**

Add these types and the function:

```ts
export interface SuggestedRelease {
  title: string;
  itemType: string;
  year: number | null;
  musicbrainzReleaseId: string | null;
}

interface MbArtistRelease {
  id?: unknown;
  title?: unknown;
  date?: unknown;
  "primary-type"?: unknown;
}

interface MbArtistReleasesResponse {
  releases?: unknown[];
}

interface MbArtistSearchResponse {
  artists?: Array<{ id?: unknown }>;
}

async function fetchArtistMbid(artistName: string): Promise<string | null> {
  const params = new URLSearchParams({ query: artistName, limit: "1", fmt: "json" });
  const url = `${MB_API_BASE}/artist?${params}`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as MbArtistSearchResponse;
    const first = data.artists?.[0];
    return typeof first?.id === "string" ? first.id : null;
  } catch {
    return null;
  }
}

async function fetchArtistReleases(mbid: string): Promise<MbArtistRelease[]> {
  const params = new URLSearchParams({ inc: "releases", fmt: "json" });
  const url = `${MB_API_BASE}/artist/${mbid}?${params}`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!response.ok) return [];
  const data = (await response.json()) as MbArtistReleasesResponse;
  return Array.isArray(data.releases) ? (data.releases as MbArtistRelease[]) : [];
}

export async function findSuggestedRelease(opts: {
  mbArtistId: string | null;
  artistName: string;
  trackedTitles: Set<string>;
  sourceYear: number | null;
}): Promise<SuggestedRelease | null> {
  const { mbArtistId, artistName, trackedTitles, sourceYear } = opts;

  try {
    const mbid = mbArtistId ?? (await fetchArtistMbid(artistName));
    if (!mbid) return null;

    const releases = await fetchArtistReleases(mbid);
    if (releases.length === 0) return null;

    const candidates = releases.filter((r) => {
      if (typeof r.title !== "string" || !r.title) return false;
      return !trackedTitles.has(r.title.toLowerCase().trim());
    });

    if (candidates.length === 0) return null;

    const withYear = candidates.map((r) => ({
      title: r.title as string,
      year: parseYear(r.date),
      musicbrainzReleaseId: typeof r.id === "string" ? r.id : null,
      itemType: typeof r["primary-type"] === "string" ? r["primary-type"].toLowerCase() : "album",
    }));

    if (sourceYear === null) {
      withYear.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      return withYear[0] ?? null;
    }

    withYear.sort(
      (a, b) => Math.abs((a.year ?? sourceYear) - sourceYear) - Math.abs((b.year ?? sourceYear) - sourceYear),
    );

    return withYear[0] ?? null;
  } catch {
    return null;
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
bun test tests/unit/musicbrainz.test.ts
# Expected: all findSuggestedRelease tests PASS
```

**Step 5: Commit**

```bash
git add server/musicbrainz.ts tests/unit/musicbrainz.test.ts
git commit -m "feat: add findSuggestedRelease to musicbrainz module"
```

---

### Task 3: Background suggestion fetch on item creation

**Files:**
- Create: `server/suggestions.ts`
- Modify: `server/routes/music-items.ts`
- Test: `tests/unit/suggestions.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/suggestions.test.ts`:

```ts
import { describe, expect, mock, spyOn, test, beforeEach, afterEach } from "bun:test";
import * as musicbrainz from "../../server/musicbrainz";
import * as db from "../../server/db/index";

// We test fetchAndStoreSuggestion by mocking its dependencies

describe("fetchAndStoreSuggestion", () => {
  afterEach(() => {
    mock.restore();
  });

  test("does nothing when item has no artist_name", async () => {
    const { fetchAndStoreSuggestion } = await import("../../server/suggestions");
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease");

    await fetchAndStoreSuggestion({ id: 1, artist_name: null, year: null, musicbrainz_artist_id: null });

    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("does nothing when findSuggestedRelease returns null", async () => {
    const { fetchAndStoreSuggestion } = await import("../../server/suggestions");
    spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValueOnce(null);

    // Should not throw
    await fetchAndStoreSuggestion({ id: 1, artist_name: "Autechre", year: 1994, musicbrainz_artist_id: null });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test tests/unit/suggestions.test.ts
# Expected: FAIL — cannot find module server/suggestions
```

**Step 3: Create `server/suggestions.ts`**

```ts
import { eq } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems, artists, itemSuggestions } from "./db/schema";
import { findSuggestedRelease } from "./musicbrainz";
import { normalize } from "./utils";

interface ItemSummary {
  id: number;
  artist_name: string | null;
  year: number | null;
  musicbrainz_artist_id: string | null;
}

export async function fetchAndStoreSuggestion(item: ItemSummary): Promise<void> {
  if (!item.artist_name) return;

  try {
    // Get all normalized titles by this artist to exclude already-tracked releases
    const artistRows = await db
      .select({ normalizedTitle: musicItems.normalizedTitle })
      .from(musicItems)
      .innerJoin(artists, eq(musicItems.artistId, artists.id))
      .where(eq(artists.normalizedName, normalize(item.artist_name)));

    const trackedTitles = new Set(artistRows.map((r) => r.normalizedTitle));

    const suggestion = await findSuggestedRelease({
      mbArtistId: item.musicbrainz_artist_id,
      artistName: item.artist_name,
      trackedTitles,
      sourceYear: item.year,
    });

    if (!suggestion) return;

    await db.insert(itemSuggestions).values({
      sourceItemId: item.id,
      title: suggestion.title,
      artistName: item.artist_name,
      itemType: suggestion.itemType,
      year: suggestion.year,
      musicbrainzReleaseId: suggestion.musicbrainzReleaseId,
      status: "pending",
    });
  } catch (err) {
    console.error("[suggestions] Failed to fetch/store suggestion for item", item.id, err);
  }
}
```

**Step 4: Wire into `POST /` in `server/routes/music-items.ts`**

Add import at top:
```ts
import { fetchAndStoreSuggestion } from "../suggestions";
```

After `return c.json(result.item, 201)`, add:
```ts
if (result.item.listen_status === "to-listen" && result.item.artist_name) {
  void fetchAndStoreSuggestion({
    id: result.item.id,
    artist_name: result.item.artist_name,
    year: result.item.year,
    musicbrainz_artist_id: result.item.musicbrainz_artist_id,
  });
}
```

**Step 5: Run tests**

```bash
bun test tests/unit/suggestions.test.ts
# Expected: PASS
```

**Step 6: Commit**

```bash
git add server/suggestions.ts server/routes/music-items.ts tests/unit/suggestions.test.ts
git commit -m "feat: trigger background suggestion fetch on item creation"
```

---

### Task 4: Include suggestion in PATCH response + accept/dismiss endpoints

**Files:**
- Modify: `server/routes/music-items.ts`
- Modify: `src/types/index.ts`
- Modify: `src/services/api-client.ts`
- Test: `tests/unit/music-items-route.test.ts` (if it exists, else reference relevant route test)

**Step 1: Add `ItemSuggestion` type to `src/types/index.ts`**

```ts
export interface ItemSuggestion {
  id: number;
  source_item_id: number;
  title: string;
  artist_name: string;
  item_type: string;
  year: number | null;
  musicbrainz_release_id: string | null;
  status: string;
  created_at: string;
}
```

**Step 2: Update `PATCH /:id` in `server/routes/music-items.ts`**

Replace the final `return c.json(item)` with:

```ts
const item = await fetchFullItem(id);
if (!item) {
  return c.json({ error: "Not found" }, 404);
}

// If transitioning to listened, include any pending suggestion
let suggestion = null;
if (input.listenStatus === "listened") {
  suggestion = await db
    .select()
    .from(itemSuggestions)
    .where(and(eq(itemSuggestions.sourceItemId, id), eq(itemSuggestions.status, "pending")))
    .get() ?? null;
}

return c.json({ item, suggestion });
```

Add import at top of file:
```ts
import { itemSuggestions } from "../db/schema";
```

**Step 3: Add accept/dismiss endpoints to `server/routes/music-items.ts`**

```ts
// POST /:id/suggestion/accept
musicItemRoutes.post("/:id/suggestion/accept", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const suggestion = await db
    .select()
    .from(itemSuggestions)
    .where(and(eq(itemSuggestions.sourceItemId, id), eq(itemSuggestions.status, "pending")))
    .get();

  if (!suggestion) return c.json({ error: "No pending suggestion" }, 404);

  const { createMusicItemDirect } = await import("../music-item-creator");
  const result = await createMusicItemDirect({
    title: suggestion.title,
    artistName: suggestion.artistName,
    itemType: suggestion.itemType as import("../../src/types").ItemType,
    listenStatus: "to-listen",
    year: suggestion.year ?? undefined,
    musicbrainzReleaseId: suggestion.musicbrainzReleaseId ?? undefined,
  });

  await db
    .update(itemSuggestions)
    .set({ status: "accepted" })
    .where(eq(itemSuggestions.id, suggestion.id));

  return c.json(result.item, 201);
});

// POST /:id/suggestion/dismiss
musicItemRoutes.post("/:id/suggestion/dismiss", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  await db
    .update(itemSuggestions)
    .set({ status: "dismissed" })
    .where(and(eq(itemSuggestions.sourceItemId, id), eq(itemSuggestions.status, "pending")));

  return c.json({ success: true });
});
```

**Step 4: Update `api-client.ts`**

Import the new type:
```ts
import type { ..., ItemSuggestion } from "../types";
```

Update `updateListenStatus` return type and add two new methods:

```ts
async updateListenStatus(
  id: number,
  status: ListenStatus,
): Promise<{ item: MusicItemFull; suggestion: ItemSuggestion | null } | null> {
  return this.requestJsonOrNull<{ item: MusicItemFull; suggestion: ItemSuggestion | null }>(
    `/api/music-items/${id}`,
    "updateListenStatus",
    this.jsonRequest("PATCH", { listenStatus: status }),
  );
}

async acceptSuggestion(sourceItemId: number): Promise<MusicItemFull> {
  return this.requestJson<MusicItemFull>(
    `/api/music-items/${sourceItemId}/suggestion/accept`,
    "acceptSuggestion",
    { method: "POST" },
  );
}

async dismissSuggestion(sourceItemId: number): Promise<void> {
  await this.request(
    `/api/music-items/${sourceItemId}/suggestion/dismiss`,
    "dismissSuggestion",
    { method: "POST" },
  );
}
```

Note: `updateMusicItem` (used for other field edits) keeps its existing signature and return type — only `updateListenStatus` changes.

**Step 5: Run type-check**

```bash
bun run typecheck
# Expected: no errors
```

**Step 6: Commit**

```bash
git add server/routes/music-items.ts src/types/index.ts src/services/api-client.ts
git commit -m "feat: include suggestion in listened status response, add accept/dismiss endpoints"
```

---

### Task 5: UI — suggestion banner

**Files:**
- Modify: `src/ui/view/templates.ts`
- Modify: `src/app.ts`

**Step 1: Add `renderSuggestionBanner` to `src/ui/view/templates.ts`**

```ts
export function renderSuggestionBanner(suggestion: import("../../types").ItemSuggestion, sourceItemId: number): string {
  const yearStr = suggestion.year ? ` (${suggestion.year})` : "";
  return `
    <div class="suggestion-banner" data-source-item-id="${sourceItemId}" data-suggestion-id="${suggestion.id}">
      <span class="suggestion-banner__text">
        Also by <strong>${escapeHtml(suggestion.artist_name)}</strong>:
        <em>${escapeHtml(suggestion.title)}</em>${escapeHtml(yearStr)}
      </span>
      <button type="button" class="btn btn--primary suggestion-banner__accept">Add to list</button>
      <button type="button" class="btn btn--ghost suggestion-banner__dismiss">Dismiss</button>
    </div>
  `;
}
```

**Step 2: Add suggestion banner styles to `src/styles/main.css`**

Find the end of the existing card styles and add:

```css
.suggestion-banner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--color-surface-raised, #f5f5f5);
  border-left: 3px solid var(--color-accent, #6c63ff);
  margin-bottom: 0.75rem;
  border-radius: 0 4px 4px 0;
  flex-wrap: wrap;
}

.suggestion-banner__text {
  flex: 1;
  font-size: 0.9rem;
}

.suggestion-banner__accept,
.suggestion-banner__dismiss {
  flex-shrink: 0;
  font-size: 0.85rem;
}
```

**Step 3: Wire up the banner in `src/app.ts`**

Find the status-select change handler (around line 1072). Replace:

```ts
await api.updateListenStatus(itemContext.itemId, target.value as ListenStatus);
await renderMusicListView();
```

With:

```ts
const result = await api.updateListenStatus(itemContext.itemId, target.value as ListenStatus);
await renderMusicListView();

if (target.value === "listened" && result?.suggestion) {
  showSuggestionBanner(result.suggestion, itemContext.itemId);
}
```

Add the `showSuggestionBanner` function and banner click handler. Place near the other setup functions:

```ts
let activeSuggestionBanner: HTMLElement | null = null;

function showSuggestionBanner(suggestion: import("./types").ItemSuggestion, sourceItemId: number): void {
  dismissSuggestionBanner();

  const musicList = document.getElementById("music-list");
  if (!musicList) return;

  const banner = document.createElement("div");
  banner.innerHTML = renderSuggestionBanner(suggestion, sourceItemId);
  const bannerEl = banner.firstElementChild as HTMLElement;

  musicList.insertAdjacentElement("beforebegin", bannerEl);
  activeSuggestionBanner = bannerEl;

  bannerEl.querySelector(".suggestion-banner__accept")?.addEventListener("click", async () => {
    dismissSuggestionBanner();
    await api.acceptSuggestion(sourceItemId);
    appActor.send({ type: "LIST_REFRESH" });
  });

  bannerEl.querySelector(".suggestion-banner__dismiss")?.addEventListener("click", async () => {
    dismissSuggestionBanner();
    await api.dismissSuggestion(sourceItemId);
  });
}

function dismissSuggestionBanner(): void {
  activeSuggestionBanner?.remove();
  activeSuggestionBanner = null;
}
```

**Step 4: Run type-check**

```bash
bun run typecheck
# Expected: no errors
```

**Step 5: Run unit tests**

```bash
bun run test
# Expected: all tests pass
```

**Step 6: Manual smoke test**

1. Start the app: `bun run dev`
2. Add a release by an artist with multiple albums (e.g. Autechre — Amber)
3. Wait a few seconds for background MB lookup
4. Change its status to 'Listened'
5. Expect: suggestion banner appears above the list
6. Click 'Add to list' — new item should appear in 'to-listen'
7. Add another release, change to listened, click Dismiss — banner disappears, no item added

**Step 7: Commit**

```bash
git add src/ui/view/templates.ts src/app.ts src/styles/main.css
git commit -m "feat: show suggestion banner when item marked as listened"
```

---

## Summary of files changed

| File | Change |
|------|--------|
| `drizzle/0006_item_suggestions.sql` | New migration |
| `server/db/schema.ts` | New `itemSuggestions` table |
| `server/musicbrainz.ts` | New `findSuggestedRelease` function |
| `server/suggestions.ts` | New — `fetchAndStoreSuggestion` |
| `server/routes/music-items.ts` | Fire suggestion on create; include in PATCH response; accept/dismiss endpoints |
| `src/types/index.ts` | New `ItemSuggestion` type |
| `src/services/api-client.ts` | Updated `updateListenStatus`; new `acceptSuggestion`, `dismissSuggestion` |
| `src/ui/view/templates.ts` | New `renderSuggestionBanner` |
| `src/app.ts` | Wire up banner on status change |
| `src/styles/main.css` | Banner styles |
| `tests/unit/musicbrainz.test.ts` | Tests for `findSuggestedRelease` |
| `tests/unit/suggestions.test.ts` | Tests for `fetchAndStoreSuggestion` |

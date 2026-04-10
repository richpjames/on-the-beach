# Sort Direction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the implicit "default" sort with explicit "Date added" / "Date listened" options, add a sort direction toggle (asc/desc) that applies to all sort fields.

**Architecture:** Types change first, then the data flows downstream: state machine → domain helper → API client → server route → HTML. Each step is small and self-contained. No migrations needed — `listenedAt` and `createdAt` columns already exist.

**Tech Stack:** TypeScript, XState v5, Hono, Drizzle ORM, SQLite

---

### Task 1: Update types

**Files:**
- Modify: `src/types/index.ts:6`
- Modify: `src/types/index.ts` (MusicItemFilters interface, line ~134)

**Step 1: Update MusicItemSort, add MusicItemSortDirection**

Replace line 6:
```ts
export type MusicItemSort = "date-added" | "date-listened" | "artist-name" | "release-name" | "star-rating";
export type MusicItemSortDirection = "asc" | "desc";
```

**Step 2: Add sortDirection to MusicItemFilters**

Find the `MusicItemFilters` interface and add:
```ts
sortDirection?: MusicItemSortDirection;
```

**Step 3: Verify TypeScript compiles**

Run: `npm run build 2>&1 | head -40`
Expected: errors only from downstream callers of the changed types (state machine, api-client etc) — not from types/index.ts itself.

**Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add date-added/date-listened sort options and sort direction type"
```

---

### Task 2: Update state machine

**Files:**
- Modify: `src/ui/state/app-machine.ts`

**Step 1: Add import and new fields**

Import `MusicItemSortDirection` alongside `MusicItemSort` (line 2):
```ts
import type { ListenStatus, MusicItemSort, MusicItemSortDirection, StackWithCount } from "../../types";
```

Add `currentSortDirection: MusicItemSortDirection;` to the `AppContext` interface.

Add `SORT_DIRECTION_UPDATED` event to `AppEvent`:
```ts
| { type: "SORT_DIRECTION_UPDATED"; direction: MusicItemSortDirection }
```

**Step 2: Update context defaults**

Change `currentSort: "default"` → `currentSort: "date-added"` (line 41).

Add `currentSortDirection: "desc"` alongside it.

**Step 3: Add SORT_DIRECTION_UPDATED handler**

After the `SORT_UPDATED` handler (line ~87), add:
```ts
SORT_DIRECTION_UPDATED: {
  actions: assign(({ context, event }) => ({
    currentSortDirection: event.direction,
    listVersion: context.listVersion + 1,
  })),
},
```

**Step 4: Verify build**

Run: `npm run build 2>&1 | head -40`
Expected: errors only in app.ts and domain helper, not in app-machine.ts.

**Step 5: Commit**

```bash
git add src/ui/state/app-machine.ts
git commit -m "feat: add sort direction to app state machine"
```

---

### Task 3: Update domain helper

**Files:**
- Modify: `src/ui/domain/music-list.ts`

**Step 1: Update import and signature**

Add `MusicItemSortDirection` to the import on line 1.

Add `currentSortDirection: MusicItemSortDirection = "desc"` as a 5th parameter to `buildMusicItemFilters`.

**Step 2: Pass direction into filters and remove the "default" guard**

Replace the current sort block:
```ts
// Old:
if (currentSort !== "default") {
  filters.sort = currentSort;
}

// New:
filters.sort = currentSort;
filters.sortDirection = currentSortDirection;
```

**Step 3: Verify build**

Run: `npm run build 2>&1 | head -40`
Expected: error only in app.ts call site.

**Step 4: Commit**

```bash
git add src/ui/domain/music-list.ts
git commit -m "feat: pass sort direction through music list filters"
```

---

### Task 4: Update API client

**Files:**
- Modify: `src/services/api-client.ts:148-150`

**Step 1: Send sort and sortDirection**

Replace the existing sort block (lines 148-150):
```ts
if (filters?.sort) {
  params.set("sort", filters.sort);
}
if (filters?.sortDirection) {
  params.set("sortDirection", filters.sortDirection);
}
```

(The `!== "default"` guard is removed because `"default"` no longer exists.)

**Step 2: Verify build**

Run: `npm run build 2>&1 | head -40`
Expected: errors only in server route.

**Step 3: Commit**

```bash
git add src/services/api-client.ts
git commit -m "feat: send sortDirection query param in API client"
```

---

### Task 5: Update server route

**Files:**
- Modify: `server/routes/music-items.ts:174-271`

**Step 1: Parse sortDirection**

In the GET `/` handler, destructure `sortDirection` alongside the other query params (line 175):
```ts
const { listenStatus, purchaseIntent, search, sort, sortDirection, stackId, hasReminder } = c.req.query();
```

Add a local helper just before the sort branches:
```ts
const dir = sortDirection === "asc" ? "asc" : "desc";
```

**Step 2: Update sort validation**

Replace the `requestedSort` assignment and validation block (lines 181-185):
```ts
const validSorts = ["date-added", "date-listened", "artist-name", "release-name", "star-rating"] as const;
type ValidSort = typeof validSorts[number];
const requestedSort: ValidSort =
  validSorts.includes(sort as ValidSort) ? (sort as ValidSort) : "date-added";
if (sort && !validSorts.includes(sort as ValidSort)) {
  return c.json({ error: "Invalid sort" }, 400);
}
```

**Step 3: Replace all sort branches**

Replace the entire if/else sort block (lines 240-271) with:
```ts
if (requestedSort === "artist-name") {
  query = query.orderBy(
    sql`CASE WHEN ${artists.normalizedName} IS NULL OR ${artists.normalizedName} = '' THEN 1 ELSE 0 END`,
    dir === "asc" ? asc(artists.normalizedName) : desc(artists.normalizedName),
    dir === "asc" ? asc(musicItems.normalizedTitle) : desc(musicItems.normalizedTitle),
    desc(musicItems.id),
  );
} else if (requestedSort === "release-name") {
  query = query.orderBy(
    dir === "asc" ? asc(musicItems.normalizedTitle) : desc(musicItems.normalizedTitle),
    sql`CASE WHEN ${artists.normalizedName} IS NULL OR ${artists.normalizedName} = '' THEN 1 ELSE 0 END`,
    dir === "asc" ? asc(artists.normalizedName) : desc(artists.normalizedName),
    desc(musicItems.id),
  );
} else if (requestedSort === "star-rating") {
  query = query.orderBy(
    sql`CASE WHEN ${musicItems.rating} IS NULL THEN 1 ELSE 0 END`,
    dir === "asc" ? asc(musicItems.rating) : desc(musicItems.rating),
    sql`CASE WHEN ${artists.normalizedName} IS NULL OR ${artists.normalizedName} = '' THEN 1 ELSE 0 END`,
    asc(artists.normalizedName),
    asc(musicItems.normalizedTitle),
    desc(musicItems.id),
  );
} else if (requestedSort === "date-listened") {
  query = query.orderBy(
    sql`CASE WHEN ${musicItems.listenedAt} IS NULL THEN 1 ELSE 0 END`,
    dir === "asc" ? asc(musicItems.listenedAt) : desc(musicItems.listenedAt),
    dir === "asc" ? asc(musicItems.id) : desc(musicItems.id),
  );
} else {
  // date-added (default)
  query = query.orderBy(
    dir === "asc" ? asc(musicItems.createdAt) : desc(musicItems.createdAt),
    dir === "asc" ? asc(musicItems.id) : desc(musicItems.id),
  );
}
```

**Step 4: Verify build**

Run: `npm run build 2>&1 | head -40`
Expected: clean build.

**Step 5: Commit**

```bash
git add server/routes/music-items.ts
git commit -m "feat: implement sort direction on all server sort branches"
```

---

### Task 6: Update HTML (sort panel)

**Files:**
- Modify: `server/routes/main-page.ts:379-389`

**Step 1: Replace sort panel contents**

Replace the sort panel div (lines 379-389):
```html
<div id="browse-sort-panel" class="browse-tools__panel browse-tools__panel--sort">
  <label class="browse-tools__sort" for="browse-sort">
    <span>Sort</span>
    <select id="browse-sort" class="input">
      <option value="date-added">Date added</option>
      <option value="date-listened" id="sort-option-date-listened" hidden>Date listened</option>
      <option value="artist-name">Artist A–Z</option>
      <option value="release-name">Release A–Z</option>
      <option value="star-rating">Star rating</option>
    </select>
  </label>
  <button
    type="button"
    id="sort-direction-btn"
    class="btn btn--ghost browse-tools__direction-btn"
    aria-label="Sort direction: newest first"
    data-direction="desc"
  >↓ Newest first</button>
</div>
```

**Step 2: Verify build**

Run: `npm run build 2>&1 | head -20`
Expected: clean.

**Step 3: Commit**

```bash
git add server/routes/main-page.ts
git commit -m "feat: update sort panel HTML with new options and direction button"
```

---

### Task 7: Wire up direction button and date-listened visibility in app.ts

**Files:**
- Modify: `src/app.ts:763-841`

**Step 1: Update setupBrowseControls to handle direction button**

In `setupBrowseControls()`, after the sort select listener (line ~806), add:

```ts
const sortDirectionBtn = document.getElementById("sort-direction-btn");
const sortOptionDateListened = document.getElementById("sort-option-date-listened");

if (sortDirectionBtn instanceof HTMLButtonElement) {
  sortDirectionBtn.addEventListener("click", () => {
    const next = appCtx().currentSortDirection === "desc" ? "asc" : "desc";
    appActor.send({ type: "SORT_DIRECTION_UPDATED", direction: next });
    updateSortDirectionBtn(sortDirectionBtn, appCtx().currentSort, next);
  });
}
```

**Step 2: Add updateSortDirectionBtn helper**

Add this function just before `setupBrowseControls`:
```ts
function updateSortDirectionBtn(
  btn: HTMLButtonElement,
  sort: MusicItemSort,
  direction: MusicItemSortDirection,
): void {
  const isDate = sort === "date-added" || sort === "date-listened";
  const isRating = sort === "star-rating";
  if (isDate) {
    btn.textContent = direction === "desc" ? "↓ Newest first" : "↑ Oldest first";
    btn.setAttribute("aria-label", direction === "desc" ? "Sort direction: newest first" : "Sort direction: oldest first");
  } else if (isRating) {
    btn.textContent = direction === "desc" ? "↓ Highest first" : "↑ Lowest first";
    btn.setAttribute("aria-label", direction === "desc" ? "Sort direction: highest first" : "Sort direction: lowest first");
  } else {
    btn.textContent = direction === "asc" ? "↑ A–Z" : "↓ Z–A";
    btn.setAttribute("aria-label", direction === "asc" ? "Sort direction: A to Z" : "Sort direction: Z to A");
  }
  btn.dataset.direction = direction;
}
```

**Step 3: Also update direction btn label when sort changes**

In the sort select change listener, after dispatching `SORT_UPDATED`:
```ts
sortSelect.addEventListener("change", () => {
  const newSort = sortSelect.value as MusicItemSort;
  appActor.send({ type: "SORT_UPDATED", sort: newSort });

  // Show/hide date-listened option
  if (sortOptionDateListened instanceof HTMLOptionElement) {
    sortOptionDateListened.hidden = newSort !== "date-listened";
  }

  // Update direction button label
  if (sortDirectionBtn instanceof HTMLButtonElement) {
    updateSortDirectionBtn(sortDirectionBtn, newSort, appCtx().currentSortDirection);
  }
});
```

**Step 4: Show/hide date-listened based on active filter**

Find the `FILTER_SELECTED` dispatch in `setupBrowseControls` or wherever filters are applied in app.ts. After a filter change, call:
```ts
function syncDateListenedOption(): void {
  const opt = document.getElementById("sort-option-date-listened");
  const sel = document.getElementById("browse-sort");
  if (!(opt instanceof HTMLOptionElement) || !(sel instanceof HTMLSelectElement)) return;
  const isListened = appCtx().currentFilter === "listened";
  opt.hidden = !isListened;
  // If date-listened is selected but filter changed away from listened, reset to date-added
  if (!isListened && sel.value === "date-listened") {
    sel.value = "date-added";
    appActor.send({ type: "SORT_UPDATED", sort: "date-added" });
  }
}
```

Call `syncDateListenedOption()` inside the `FILTER_SELECTED` dispatch handler (wherever `appActor.send({ type: "FILTER_SELECTED" ... })` is called in the UI).

**Step 5: Update isBrowseOrderLocked**

Change line 841:
```ts
// Old:
return getNormalizedSearchQuery().length > 0 || appCtx().currentSort !== "default";
// New:
return getNormalizedSearchQuery().length > 0 || appCtx().currentSort !== "date-added" || appCtx().currentSortDirection !== "desc";
```

**Step 6: Update buildMusicItemFilters call site**

In `renderMusicList` (line ~1780), pass `currentSortDirection`:
```ts
const filters = buildMusicItemFilters(
  appCtx().currentFilter,
  appCtx().currentStack,
  appCtx().searchQuery,
  appCtx().currentSort,
  appCtx().currentSortDirection,
);
```

**Step 7: Verify build**

Run: `npm run build 2>&1 | head -40`
Expected: clean build.

**Step 8: Commit**

```bash
git add src/app.ts
git commit -m "feat: wire direction button and date-listened visibility in UI"
```

---

### Task 8: Manual smoke test

Start the app: `npm run dev`

1. Open the app — sort panel shows "Date added" selected, "↓ Newest first" button
2. Click "↓ Newest first" → changes to "↑ Oldest first", list reverses
3. Switch to Listened filter → "Date listened" option appears in select
4. Select "Date listened" → list reorders by listened date
5. Click direction button → reverses listened date order
6. Switch back to To Listen → "Date listened" option disappears, sort resets to "Date added"
7. Select "Artist A–Z", click direction → becomes "↓ Z–A"
8. Select "Star rating", click direction → becomes "↑ Lowest first"

**Step 9: Final commit if any fixes needed**

```bash
git add -p
git commit -m "fix: sort direction smoke test fixes"
```

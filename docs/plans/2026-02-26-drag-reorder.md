# Drag-to-Reorder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users drag music cards to reorder them, with each filter+stack combination maintaining its own independently persisted order.

**Architecture:** A new `music_item_order` table stores a JSON array of item IDs per "context key" (derived from the current filter and stack). The GET list endpoint applies the saved order after filtering. A new PUT endpoint saves the order. The frontend uses the native HTML5 Drag and Drop API with event delegation on `#music-list`, calling the save endpoint on drop.

**Tech Stack:** Bun + Hono (server), Drizzle ORM + SQLite, vanilla TypeScript (client), native HTML5 Drag API

---

### Task 1: Add `musicItemOrder` to the Drizzle schema and run migration

**Files:**
- Modify: `server/db/schema.ts`

**Step 1: Add the table to the schema**

At the bottom of `server/db/schema.ts`, add:

```ts
export const musicItemOrder = sqliteTable("music_item_order", {
  contextKey: text("context_key").primaryKey(),
  itemIds: text("item_ids").notNull(), // JSON array of item IDs
});
```

**Step 2: Generate the migration**

```bash
bun run db:generate
```

Expected: A new SQL file appears in `drizzle/` containing `CREATE TABLE music_item_order`.

**Step 3: Apply the migration**

```bash
bun run db:migrate
```

Expected: Exits cleanly (the server also auto-applies migrations on startup, but running explicitly here confirms it works).

**Step 4: Commit**

```bash
git add server/db/schema.ts drizzle/
git commit -m "feat: add music_item_order table for drag reorder"
```

---

### Task 2: Add `buildContextKey` and `applyOrder` pure functions with tests

**Files:**
- Modify: `src/ui/domain/music-list.ts`
- Modify: `tests/unit/app-domain.test.ts`

**Step 1: Write the failing tests**

Add to the `describe("app domain helpers", ...)` block in `tests/unit/app-domain.test.ts`:

```ts
import { buildContextKey, applyOrder } from "../../src/ui/domain/music-list";

// (add inside the existing describe block)

it("builds context keys for all filter/stack combinations", () => {
  expect(buildContextKey("all", null)).toBe("all");
  expect(buildContextKey("to-listen", null)).toBe("filter:to-listen");
  expect(buildContextKey("all", 5)).toBe("stack:5");
  expect(buildContextKey("listened", 3)).toBe("filter:listened:stack:3");
});

it("sorts items by saved order and puts unordered items last", () => {
  const items = [{ id: 10 }, { id: 20 }, { id: 30 }];
  expect(applyOrder(items, [30, 10, 20])).toEqual([{ id: 30 }, { id: 10 }, { id: 20 }]);
  expect(applyOrder(items, [20])).toEqual([{ id: 20 }, { id: 10 }, { id: 30 }]);
  expect(applyOrder(items, [])).toEqual(items);
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test tests/unit/app-domain.test.ts
```

Expected: FAIL — `buildContextKey is not a function` (or similar)

**Step 3: Implement the functions in `src/ui/domain/music-list.ts`**

Add at the bottom of the file:

```ts
export function buildContextKey(
  currentFilter: FilterSelection,
  currentStack: number | null,
): string {
  if (currentFilter === "all" && currentStack === null) return "all";
  if (currentFilter === "all") return `stack:${currentStack}`;
  if (currentStack === null) return `filter:${currentFilter}`;
  return `filter:${currentFilter}:stack:${currentStack}`;
}

export function applyOrder<T extends { id: number }>(items: T[], orderedIds: number[]): T[] {
  if (orderedIds.length === 0) return items;
  const indexMap = new Map(orderedIds.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ai = indexMap.get(a.id) ?? Infinity;
    const bi = indexMap.get(b.id) ?? Infinity;
    return ai - bi;
  });
}
```

**Step 4: Run tests to verify they pass**

```bash
bun test tests/unit/app-domain.test.ts
```

Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/ui/domain/music-list.ts tests/unit/app-domain.test.ts
git commit -m "feat: add buildContextKey and applyOrder helpers"
```

---

### Task 3: Add `PUT /api/music-items/order` endpoint

**Files:**
- Modify: `server/routes/music-items.ts`

**Step 1: Import the new schema table**

At the top of `server/routes/music-items.ts`, update the schema import to include `musicItemOrder`:

```ts
import { musicItems, artists, musicItemStacks, stacks, musicItemOrder } from "../db/schema";
```

Also add `sql` to drizzle imports if not already present (it is already imported).

**Step 2: Add the `PUT /order` route**

Add this block BEFORE the `musicItemRoutes.get("/:id", ...)` handler (to avoid the wildcard route capturing "order" as an ID):

```ts
// ---------------------------------------------------------------------------
// PUT /order — save custom sort order for a context
// ---------------------------------------------------------------------------

musicItemRoutes.put("/order", async (c) => {
  const body = (await c.req.json()) as { contextKey?: string; itemIds?: number[] };

  if (!body.contextKey || !Array.isArray(body.itemIds)) {
    return c.json({ error: "contextKey and itemIds are required" }, 400);
  }

  await db
    .insert(musicItemOrder)
    .values({
      contextKey: body.contextKey,
      itemIds: JSON.stringify(body.itemIds),
    })
    .onConflictDoUpdate({
      target: musicItemOrder.contextKey,
      set: { itemIds: JSON.stringify(body.itemIds) },
    });

  return c.json({ success: true });
});
```

**Step 3: Run the full unit test suite to confirm nothing broke**

```bash
bun test tests/unit
```

Expected: All tests pass.

**Step 4: Commit**

```bash
git add server/routes/music-items.ts
git commit -m "feat: add PUT /api/music-items/order endpoint"
```

---

### Task 4: Apply saved order in `GET /api/music-items`

**Files:**
- Modify: `server/routes/music-items.ts`

The server needs to derive the same context key from query params and apply the saved order to results.

**Step 1: Add a server-side context key builder**

Add a small helper function near the top of `server/routes/music-items.ts` (after the imports):

```ts
function buildContextKey(listenStatus: string | undefined, stackId: string | undefined): string {
  const filter = listenStatus || "all";
  const stack = stackId ? Number(stackId) : null;
  if (filter === "all" && stack === null) return "all";
  if (filter === "all") return `stack:${stack}`;
  if (stack === null) return `filter:${filter}`;
  return `filter:${filter}:stack:${stack}`;
}
```

Note: The server version takes the raw query param strings, while the client version takes the typed app state. They produce the same keys for the same inputs.

**Step 2: Apply the order after fetching items**

In the `GET /` handler, after the `hydrateItemStacks` call, add:

```ts
// Apply custom sort order if one exists for this context
const contextKey = buildContextKey(listenStatus, stackId);
const orderRow = await db
  .select()
  .from(musicItemOrder)
  .where(eq(musicItemOrder.contextKey, contextKey))
  .get();

let finalItems: typeof enriched = enriched;
if (orderRow) {
  const orderedIds = JSON.parse(orderRow.itemIds) as number[];
  const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
  finalItems = [...enriched].sort((a, b) => {
    const ai = indexMap.get(a.id) ?? Infinity;
    const bi = indexMap.get(b.id) ?? Infinity;
    return ai - bi;
  });
}

return c.json({ items: finalItems, total: finalItems.length });
```

Replace the existing `return c.json({ items: enriched, total: enriched.length });` line.

Also add `musicItemOrder` to the schema import if not already there from Task 3.

**Step 3: Run unit tests**

```bash
bun test tests/unit
```

Expected: All tests pass.

**Step 4: Commit**

```bash
git add server/routes/music-items.ts
git commit -m "feat: apply saved sort order in GET /api/music-items"
```

---

### Task 5: Add `saveOrder` to `ApiClient`

**Files:**
- Modify: `src/services/api-client.ts`

**Step 1: Add the method**

In the "Music Items" section of `ApiClient`, add after `updateListenStatus`:

```ts
async saveOrder(contextKey: string, itemIds: number[]): Promise<void> {
  const res = await fetch(`${this.baseUrl}/api/music-items/order`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contextKey, itemIds }),
  });
  if (!res.ok) throw new Error(`saveOrder failed: ${res.status}`);
}
```

**Step 2: Run unit tests**

```bash
bun test tests/unit
```

Expected: All pass.

**Step 3: Commit**

```bash
git add src/services/api-client.ts
git commit -m "feat: add saveOrder to ApiClient"
```

---

### Task 6: Add drag handle and `draggable` attribute to card template

**Files:**
- Modify: `src/ui/view/templates.ts`

**Step 1: Add `draggable="true"` to the article element**

In `renderMusicCard`, change:

```ts
return `
    <article class="music-card" data-item-id="${item.id}">
```

to:

```ts
return `
    <article class="music-card" data-item-id="${item.id}" draggable="true">
```

**Step 2: Add a drag handle button in `music-card__actions`**

Add the handle as the first item in `music-card__actions` (before the existing open-link button):

```ts
<div class="music-card__actions">
  <button type="button" class="btn btn--ghost music-card__drag-handle" title="Drag to reorder" data-action="drag-handle">
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
      <circle cx="3" cy="3" r="1.5"/><circle cx="7" cy="3" r="1.5"/>
      <circle cx="3" cy="8" r="1.5"/><circle cx="7" cy="8" r="1.5"/>
      <circle cx="3" cy="13" r="1.5"/><circle cx="7" cy="13" r="1.5"/>
    </svg>
  </button>
  ${
    item.primary_url
      ? `...` // existing open-link button unchanged
```

**Step 3: Run unit tests**

```bash
bun test tests/unit
```

Expected: All pass.

**Step 4: Commit**

```bash
git add src/ui/view/templates.ts
git commit -m "feat: add draggable attribute and drag handle to music card"
```

---

### Task 7: Implement drag-and-drop in `App`

**Files:**
- Modify: `src/app.ts`

**Step 1: Add imports**

At the top of `src/app.ts`, update the `music-list` import to include the new helpers:

```ts
import { buildMusicItemFilters, buildContextKey } from "./ui/domain/music-list";
```

**Step 2: Add a drag state field to the class**

Inside the `App` class, add a private field for tracking the dragged element:

```ts
private dragState: { sourceCard: HTMLElement | null } = { sourceCard: null };
```

**Step 3: Add drag event listeners to `setupEventDelegation`**

Add these listeners at the end of `setupEventDelegation`, after the existing `list.addEventListener("click", ...)` blocks:

```ts
list.addEventListener("dragstart", (event) => {
  const card = (event.target as HTMLElement).closest(".music-card") as HTMLElement | null;
  if (!card) return;
  this.dragState.sourceCard = card;
  card.classList.add("is-dragging");
  event.dataTransfer?.setData("text/plain", card.dataset.itemId ?? "");
});

list.addEventListener("dragend", () => {
  this.dragState.sourceCard?.classList.remove("is-dragging");
  this.dragState.sourceCard = null;
  list.querySelectorAll(".drop-target-above, .drop-target-below").forEach((el) => {
    el.classList.remove("drop-target-above", "drop-target-below");
  });
});

list.addEventListener("dragover", (event) => {
  event.preventDefault();
  const target = (event.target as HTMLElement).closest(".music-card") as HTMLElement | null;
  if (!target || target === this.dragState.sourceCard) return;

  list.querySelectorAll(".drop-target-above, .drop-target-below").forEach((el) => {
    el.classList.remove("drop-target-above", "drop-target-below");
  });

  const rect = target.getBoundingClientRect();
  const midpoint = rect.top + rect.height / 2;
  if (event.clientY < midpoint) {
    target.classList.add("drop-target-above");
  } else {
    target.classList.add("drop-target-below");
  }
});

list.addEventListener("drop", async (event) => {
  event.preventDefault();
  const source = this.dragState.sourceCard;
  if (!source) return;

  const target = (event.target as HTMLElement).closest(".music-card") as HTMLElement | null;
  if (!target || target === source) return;

  const rect = target.getBoundingClientRect();
  const insertBefore = event.clientY < rect.top + rect.height / 2;

  if (insertBefore) {
    list.insertBefore(source, target);
  } else {
    target.after(source);
  }

  const contextKey = buildContextKey(this.appState.currentFilter, this.appState.currentStack);
  const itemIds = Array.from(list.querySelectorAll<HTMLElement>("[data-item-id]"))
    .map((el) => Number(el.dataset.itemId))
    .filter((id) => !Number.isNaN(id) && id > 0);

  await this.api.saveOrder(contextKey, itemIds);
});
```

**Step 4: Run unit tests**

```bash
bun test tests/unit
```

Expected: All pass.

**Step 5: Commit**

```bash
git add src/app.ts
git commit -m "feat: implement drag-and-drop reorder with order persistence"
```

---

### Task 8: Add CSS for drag interaction states

**Files:**
- Modify: `src/styles/main.css`

**Step 1: Add styles after the `.music-card__actions` block**

Find the `.music-card__actions` rule (around line 689) and add after it:

```css
.music-card__drag-handle {
  cursor: grab;
  opacity: 0.4;
}

.music-card__drag-handle:active {
  cursor: grabbing;
}

.music-card:hover .music-card__drag-handle {
  opacity: 1;
}

.music-card.is-dragging {
  opacity: 0.35;
}

.music-card.drop-target-above {
  border-top: 2px solid var(--win-blue);
}

.music-card.drop-target-below {
  border-bottom: 2px solid var(--win-blue);
}
```

**Step 2: Run unit tests**

```bash
bun test tests/unit
```

Expected: All pass.

**Step 3: Commit**

```bash
git add src/styles/main.css
git commit -m "feat: add CSS for drag-and-drop reorder visual states"
```

---

## Manual Verification

Start the dev server and verify:

```bash
bun run dev
```

1. Open the app — drag a card up or down and drop it. The card should move to the new position.
2. Refresh the page — the custom order should be preserved.
3. Switch to a different filter (e.g. "listened") — reorder there, then switch back. Each list maintains its own independent order.
4. Newly added items (after a custom order is saved) should appear at the end of the list.

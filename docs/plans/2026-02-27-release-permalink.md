# Release Permalink Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add server-rendered HTML pages at `/r/:id` for each music item, with view/edit modes, status update, and delete action.

**Architecture:** A new Hono route at `/r/:id` fetches the item from the DB using the existing `fetchFullItem` function and renders a full HTML page. The page uses inline JS (no build step) to call the existing `/api/music-items/:id` endpoints for edit, delete, and status updates. The dev server routing is updated to send `/r/*` to Hono instead of Vite. A permalink icon is added to each music card in the list view.

**Tech Stack:** Hono (server routing + HTML response), Bun test (unit tests), existing Drizzle/SQLite DB layer, vanilla inline JS for page interactions.

---

### Task 1: Write failing tests for the release page route

**Files:**
- Create: `tests/unit/release-page-route.test.ts`

**Context:** Tests follow the same pattern as `tests/unit/release-route.test.ts`. Use `bun:test`, mock `fetchFullItem` via dependency injection, build a Hono app with `createReleasePageRoutes(mockFetchItem)`.

**Step 1: Create the test file**

```typescript
// tests/unit/release-page-route.test.ts
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createReleasePageRoutes } from "../../server/routes/release-page";

const mockFetchItem = mock();

function makeApp(): Hono {
  const app = new Hono();
  app.route("/r", createReleasePageRoutes(mockFetchItem));
  return app;
}

const baseItem = {
  id: 42,
  title: "Blue Lines",
  normalized_title: "blue lines",
  item_type: "album" as const,
  artist_id: 1,
  artist_name: "Massive Attack",
  listen_status: "to-listen" as const,
  purchase_intent: "no" as const,
  price_cents: null,
  currency: "USD",
  notes: null,
  rating: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  listened_at: null,
  artwork_url: "/uploads/test.jpg",
  is_physical: 0,
  physical_format: null,
  label: "Wild Bunch",
  year: 1991,
  country: "UK",
  genre: "Trip-hop",
  catalogue_number: "WBRX 1",
  primary_url: null,
  primary_source: null,
  stacks: [{ id: 1, name: "favourites" }],
};

describe("GET /r/:id", () => {
  beforeEach(() => {
    mockFetchItem.mockReset();
  });

  test("returns 400 for non-numeric id", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/r/abc");
    expect(res.status).toBe(400);
  });

  test("returns 404 when item not found", async () => {
    mockFetchItem.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request("http://localhost/r/999");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Not found");
    expect(html).toContain("back to list");
  });

  test("returns 200 HTML for a valid item", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type");
    expect(ct).toContain("text/html");
  });

  test("HTML contains the item title and artist", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("Blue Lines");
    expect(html).toContain("Massive Attack");
  });

  test("HTML contains metadata fields", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("1991");
    expect(html).toContain("Wild Bunch");
    expect(html).toContain("Trip-hop");
    expect(html).toContain("WBRX 1");
  });

  test("HTML contains stack chips", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("favourites");
  });

  test("HTML contains status select with correct value selected", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain('value="to-listen"');
    expect(html).toContain('selected');
  });

  test("escapes HTML special characters in title", async () => {
    mockFetchItem.mockResolvedValue({
      ...baseItem,
      title: '<script>alert("xss")</script>',
      artist_name: null,
    });
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("calls fetchItem with the numeric id", async () => {
    mockFetchItem.mockResolvedValue(null);
    const app = makeApp();
    await app.request("http://localhost/r/7");
    expect(mockFetchItem).toHaveBeenCalledWith(7);
  });

  test("HTML includes item id for inline JS", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("const ITEM_ID = 42");
  });
});
```

**Step 2: Run tests to confirm they all fail**

```bash
bun test tests/unit/release-page-route.test.ts
```

Expected: All tests FAIL with "Cannot find module '../../server/routes/release-page'".

---

### Task 2: Implement the release page route

**Files:**
- Create: `server/routes/release-page.ts`

**Context:** The route uses dependency injection (same pattern as `server/routes/release.ts` — `createReleaseRoutes(mockFn)`). `fetchFullItem` is already exported from `server/music-item-creator.ts`. The `escapeHtml` helper must be defined locally (it's not exported from anywhere else). CSS href: in non-production use `/src/styles/main.css`; in production read `dist/index.html` at startup and cache the result.

**Step 1: Create the route file**

```typescript
// server/routes/release-page.ts
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchFullItem } from "../music-item-creator";
import type { MusicItemFull } from "../../src/types";

export type FetchItemFn = (id: number) => Promise<MusicItemFull | null>;

let cssHrefCache: string | null = null;

async function getCssHref(): Promise<string> {
  if (process.env.NODE_ENV !== "production") {
    return "/src/styles/main.css";
  }
  if (cssHrefCache) return cssHrefCache;
  try {
    const html = await readFile(path.resolve("dist/index.html"), "utf-8");
    const match = html.match(/href="(\/assets\/[^"]+\.css)"/);
    cssHrefCache = match?.[1] ?? "/assets/index.css";
  } catch {
    cssHrefCache = "/assets/index.css";
  }
  return cssHrefCache;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderNotFoundPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Not Found — On The Beach</title>
  </head>
  <body>
    <div id="app">
      <header class="header">
        <h1>On The Beach</h1>
        <p class="header__subtitle">Music Tracking</p>
      </header>
      <main class="main">
        <div class="release-page">
          <p>Not found — this release doesn't exist.</p>
          <a href="/" class="btn btn--ghost">← back to list</a>
        </div>
      </main>
    </div>
  </body>
</html>`;
}

function renderReleasePage(item: MusicItemFull, cssHref: string): string {
  const statusOptions = [
    { value: "to-listen", label: "To Listen" },
    { value: "listening", label: "Listening" },
    { value: "listened", label: "Listened" },
    { value: "done", label: "Done" },
  ]
    .map(
      ({ value, label }) =>
        `<option value="${value}"${item.listen_status === value ? " selected" : ""}>${label}</option>`,
    )
    .join("");

  const metaFields = [
    item.year ? String(item.year) : null,
    item.label,
    item.country,
    item.genre,
  ]
    .filter(Boolean)
    .map((s) => escapeHtml(s!))
    .join(" · ");

  const stackChips = item.stacks
    .map((s) => `<span class="music-card__stack-chip">${escapeHtml(s.name)}</span>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(item.title)} — On The Beach</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=VT323&family=Share+Tech+Mono&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="${escapeHtml(cssHref)}" />
  </head>
  <body>
    <div id="app">
      <header class="header">
        <h1>On The Beach</h1>
        <p class="header__subtitle">Music Tracking</p>
      </header>
      <main class="main">
        <div class="release-page">

          <div class="release-page__nav">
            <a href="/" class="btn btn--ghost">← back to list</a>
            <button type="button" class="btn" id="edit-btn">Edit</button>
          </div>

          ${item.artwork_url ? `<img class="release-page__artwork" src="${escapeHtml(item.artwork_url)}" alt="Artwork for ${escapeHtml(item.title)}" />` : ""}

          <div id="view-mode">
            <h2 class="release-page__title">${escapeHtml(item.title)}</h2>
            ${item.artist_name ? `<p class="release-page__artist">${escapeHtml(item.artist_name)}</p>` : ""}
            ${metaFields ? `<p class="release-page__meta">${metaFields}</p>` : ""}
            ${item.catalogue_number ? `<p class="release-page__catalogue">${escapeHtml(item.catalogue_number)}</p>` : ""}
            ${item.notes ? `<p class="release-page__notes">${escapeHtml(item.notes)}</p>` : ""}
          </div>

          <div id="edit-mode" hidden>
            <input class="input" type="text" id="edit-title" value="${escapeHtml(item.title)}" placeholder="Title" />
            <input class="input" type="text" id="edit-artist" value="${escapeHtml(item.artist_name ?? "")}" placeholder="Artist" />
            <div class="release-page__edit-row">
              <input class="input" type="number" id="edit-year" value="${item.year ?? ""}" placeholder="Year" min="1900" max="2099" />
              <input class="input" type="text" id="edit-label" value="${escapeHtml(item.label ?? "")}" placeholder="Label" />
              <input class="input" type="text" id="edit-country" value="${escapeHtml(item.country ?? "")}" placeholder="Country" />
            </div>
            <input class="input" type="text" id="edit-genre" value="${escapeHtml(item.genre ?? "")}" placeholder="Genre" />
            <input class="input" type="text" id="edit-catalogue" value="${escapeHtml(item.catalogue_number ?? "")}" placeholder="Catalogue number" />
            <textarea class="input" id="edit-notes" placeholder="Notes">${escapeHtml(item.notes ?? "")}</textarea>
            <div class="release-page__edit-actions">
              <button type="button" class="btn btn--primary" id="save-btn">Save changes</button>
              <button type="button" class="btn btn--ghost" id="cancel-btn">Cancel</button>
            </div>
          </div>

          <div class="release-page__status">
            <label for="status-select">Status</label>
            <select id="status-select" class="status-select">${statusOptions}</select>
          </div>

          ${stackChips ? `<div class="release-page__stacks">${stackChips}</div>` : ""}

          <div class="release-page__footer">
            <button type="button" class="btn btn--ghost btn--danger" id="delete-btn">Delete</button>
          </div>

        </div>
      </main>
    </div>
    <script>
      const ITEM_ID = ${item.id};

      document.getElementById('edit-btn').addEventListener('click', () => {
        document.getElementById('view-mode').hidden = true;
        document.getElementById('edit-mode').hidden = false;
        document.getElementById('edit-btn').hidden = true;
      });

      document.getElementById('cancel-btn').addEventListener('click', () => {
        document.getElementById('edit-mode').hidden = true;
        document.getElementById('view-mode').hidden = false;
        document.getElementById('edit-btn').hidden = false;
      });

      document.getElementById('save-btn').addEventListener('click', async () => {
        const yearVal = document.getElementById('edit-year').value;
        const body = {
          title: document.getElementById('edit-title').value.trim() || undefined,
          artistName: document.getElementById('edit-artist').value.trim() || undefined,
          year: yearVal ? Number(yearVal) : null,
          label: document.getElementById('edit-label').value.trim() || null,
          country: document.getElementById('edit-country').value.trim() || null,
          genre: document.getElementById('edit-genre').value.trim() || null,
          catalogueNumber: document.getElementById('edit-catalogue').value.trim() || null,
          notes: document.getElementById('edit-notes').value.trim() || null,
        };
        const res = await fetch('/api/music-items/' + ITEM_ID, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          window.location.reload();
        } else {
          alert('Failed to save changes.');
        }
      });

      document.getElementById('status-select').addEventListener('change', async (e) => {
        await fetch('/api/music-items/' + ITEM_ID, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ listenStatus: e.target.value }),
        });
      });

      document.getElementById('delete-btn').addEventListener('click', async () => {
        if (!confirm('Delete this release?')) return;
        const res = await fetch('/api/music-items/' + ITEM_ID, { method: 'DELETE' });
        if (res.ok) window.location.href = '/';
      });
    </script>
  </body>
</html>`;
}

export function createReleasePageRoutes(fetchItem: FetchItemFn = fetchFullItem): Hono {
  const routes = new Hono();

  routes.get("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.text("Invalid ID", 400);
    }

    const item = await fetchItem(id);
    if (!item) {
      return c.html(renderNotFoundPage(), 404);
    }

    const cssHref = await getCssHref();
    return c.html(renderReleasePage(item, cssHref));
  });

  return routes;
}

export const releasePageRoutes = createReleasePageRoutes();
```

**Step 2: Run the tests**

```bash
bun test tests/unit/release-page-route.test.ts
```

Expected: All tests PASS.

**Step 3: Run full unit test suite to check for regressions**

```bash
bun test tests/unit
```

Expected: All tests PASS.

**Step 4: Commit**

```bash
git add tests/unit/release-page-route.test.ts server/routes/release-page.ts
git commit -m "feat: add server-rendered release permalink route at /r/:id"
```

---

### Task 3: Register the route in server/index.ts + fix dev routing

**Files:**
- Modify: `server/index.ts`

**Context:** Two changes needed:

1. Register `releasePageRoutes` at `/r` (before static files in production).
2. In dev mode the HTTP server currently only sends `/api/*` and `/uploads/*` to Hono — everything else goes to Vite. Add `/r/` to that condition so the release page route is reachable in development.

**Step 1: Read the current server/index.ts**

Read `server/index.ts` in full before editing (already done above — included for reference).

**Step 2: Apply the two changes**

Add import at the top with other route imports:
```typescript
import { releasePageRoutes } from "./routes/release-page";
```

Add route registration (after the existing `app.route("/api/release", releaseRoutes)` line):
```typescript
app.route("/r", releasePageRoutes);
```

Update the dev routing condition (the `if` inside `createHttpServer`):
```typescript
// Before:
if (req.url?.startsWith("/api/") || req.url?.startsWith("/uploads/")) {
// After:
if (req.url?.startsWith("/api/") || req.url?.startsWith("/uploads/") || req.url?.startsWith("/r/")) {
```

**Step 3: Run unit tests to confirm nothing broke**

```bash
bun test tests/unit
```

Expected: All tests PASS.

**Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat: register release page route and update dev routing"
```

---

### Task 4: Add CSS for the release page

**Files:**
- Modify: `src/styles/main.css`

**Context:** The release page reuses existing classes (`.btn`, `.btn--ghost`, `.btn--danger`, `.btn--primary`, `.input`, `.status-select`, `.music-card__stack-chip`, `.header`, `.main`). We need new `.release-page__*` classes. Append them at the end of `main.css`.

**Step 1: Append the following styles to `src/styles/main.css`**

```css
/* ─── Release Permalink Page ────────────────────────────────────────────── */

.release-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  max-width: 600px;
}

.release-page__nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.release-page__artwork {
  width: 100%;
  max-width: 400px;
  height: auto;
  display: block;
  border: 2px solid var(--chrome-dark);
}

.release-page__title {
  font-family: var(--font-mono);
  font-size: 1.4rem;
  color: var(--playlist-text);
  margin: 0;
}

.release-page__artist {
  color: var(--playlist-text-hover);
  font-size: 1rem;
}

.release-page__meta {
  color: var(--chrome-dark);
  font-size: 0.85rem;
}

.release-page__catalogue {
  color: var(--chrome-dark);
  font-size: 0.85rem;
}

.release-page__notes {
  color: var(--playlist-text);
  font-size: 0.9rem;
  white-space: pre-wrap;
}

.release-page__edit-row {
  display: flex;
  gap: 8px;
}

.release-page__edit-row .input {
  flex: 1;
}

.release-page__edit-actions {
  display: flex;
  gap: 8px;
}

.release-page__status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.release-page__stacks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.release-page__footer {
  margin-top: 8px;
}
```

**Step 2: Run unit tests**

```bash
bun test tests/unit
```

Expected: All tests PASS (CSS changes don't affect unit tests).

**Step 3: Commit**

```bash
git add src/styles/main.css
git commit -m "feat: add CSS styles for release permalink page"
```

---

### Task 5: Add permalink link to music cards in the list view

**Files:**
- Modify: `src/ui/view/templates.ts`

**Context:** `renderMusicCard` in `templates.ts` renders the `.music-card__actions` div with drag handle, optional link, stack, and delete buttons. Add a permalink icon link (`<a href="/r/:id">`) between the stack button and the delete button. Use the same SVG style (external link icon already in the template) — use a simple link/chain icon or a small "↗" arrow.

**Step 1: Read `src/ui/view/templates.ts` to locate the actions area**

The `.music-card__actions` div is in `renderMusicCard`. Find the line with `data-action="delete"` and insert the permalink link before it.

**Step 2: Add the permalink link**

Inside the `renderMusicCard` function, in the `.music-card__actions` block, add this **before** the delete button:

```typescript
<a href="/r/${item.id}" class="btn btn--ghost" title="View release page">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
  </svg>
</a>
```

**Step 3: Run unit tests**

```bash
bun test tests/unit
```

Expected: All tests PASS.

**Step 4: Commit**

```bash
git add src/ui/view/templates.ts
git commit -m "feat: add permalink link to music cards in list view"
```

---

### Task 6: Manual smoke test

**No code changes.** Verify everything works end-to-end.

**Step 1: Start the dev server**

```bash
bun run dev
```

**Step 2: Open the app in browser**

Navigate to `http://localhost:3000`. Confirm the list loads and each card has a link icon.

**Step 3: Click a card's permalink icon**

Expect: navigates to `http://localhost:3000/r/<id>` and shows the release page with title, artist, artwork, metadata.

**Step 4: Test view → edit → cancel**

Click Edit. Fields should appear. Click Cancel. View mode should return.

**Step 5: Test edit → save**

Click Edit, change the title, click Save. Expect page reloads with the new title.

**Step 6: Test status dropdown**

Change the status select. No reload, but navigating back to the list should show the updated status.

**Step 7: Test delete**

Click Delete, confirm. Expect redirect to `/` and item removed from list.

**Step 8: Test 404**

Navigate to `http://localhost:3000/r/99999`. Expect "Not found" page with back link.

**Step 9: Commit any fixes found during smoke test**

If any issues found during smoke test, fix and commit with `fix: <description>`.

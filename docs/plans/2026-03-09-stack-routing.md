# Stack Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give each stack its own URL (`/stack/jazz-2`) with server-side canonical slug validation and redirect, client-side pushState navigation, and popstate handling.

**Architecture:** A shared slug utility (`shared/slug.ts`) used by both server and client. The server route validates the slug and 301-redirects stale slugs (e.g. after a rename). It embeds the selected stack ID in the server state JSON so the client can pre-select it without an extra round-trip. The client dispatches `STACK_SELECTED` from the embedded state, pushes history on tab click, and handles popstate for back/forward.

**Tech Stack:** Hono (server routes), XState v5 (app machine), `history.pushState` / `popstate` (client routing), Bun test runner

---

### Task 1: Slug utility

**Files:**
- Create: `shared/slug.ts`
- Create: `tests/unit/slug.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/unit/slug.test.ts
import { describe, expect, it } from "bun:test";
import { buildStackSlug, parseStackIdFromSlug } from "../../shared/slug";

describe("buildStackSlug", () => {
  it("lowercases and hyphenates the name then appends the id", () => {
    expect(buildStackSlug("New Releases", 5)).toBe("new-releases-5");
  });

  it("strips leading and trailing hyphens from the slug", () => {
    expect(buildStackSlug("  Jazz  ", 2)).toBe("jazz-2");
  });

  it("collapses multiple non-alphanumeric characters into one hyphen", () => {
    expect(buildStackSlug("Lo-Fi / Ambient", 9)).toBe("lo-fi-ambient-9");
  });

  it("handles names that are entirely non-alphanumeric", () => {
    expect(buildStackSlug("!!!!", 1)).toBe("1");
  });
});

describe("parseStackIdFromSlug", () => {
  it("extracts the numeric id from the trailing segment", () => {
    expect(parseStackIdFromSlug("new-releases-5")).toBe(5);
  });

  it("returns null when there is no trailing numeric segment", () => {
    expect(parseStackIdFromSlug("jazz")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseStackIdFromSlug("")).toBeNull();
  });

  it("handles a slug that is just an id", () => {
    expect(parseStackIdFromSlug("1")).toBe(1);
  });
});
```

**Step 2: Run to verify they fail**

```bash
bun test tests/unit/slug.test.ts
```

Expected: FAIL — "Cannot find module '../../shared/slug'"

**Step 3: Implement `shared/slug.ts`**

```typescript
export function buildStackSlug(name: string, id: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `${slug}-${id}` : String(id);
}

export function parseStackIdFromSlug(slug: string): number | null {
  const match = slug.match(/-?(\d+)$/);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  return isNaN(id) ? null : id;
}
```

**Step 4: Run tests — must pass**

```bash
bun test tests/unit/slug.test.ts
```

Expected: 8 tests pass.

**Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add shared/slug.ts tests/unit/slug.test.ts
git commit -m "feat: add stack slug utility (buildStackSlug, parseStackIdFromSlug)"
```

---

### Task 2: Server route `GET /stack/:slug`

**Files:**
- Modify: `server/routes/main-page.ts`
- Modify: `server/index.ts`
- Test: `tests/unit/main-page-route.test.ts`

**Context:** `main-page.ts` already has `createMainPageRoutes()` returning a Hono router. The `GET /` handler calls `fetchInitialStacks()`, renders HTML, and embeds stacks JSON via `safeJson({ stacks: initialStacks })`. The stack route reuses all of this, adds `selectedStackId` to the JSON, and redirects stale slugs.

**Step 1: Add slug tests to `tests/unit/main-page-route.test.ts`**

Append to the existing file:

```typescript
import { buildStackSlug } from "../../shared/slug";

describe("stack route canonical slug logic", () => {
  it("canonical slug for a stack matches buildStackSlug", () => {
    const slug = buildStackSlug("New Releases", 5);
    expect(slug).toBe("new-releases-5");
  });

  it("slug with different casing is not canonical", () => {
    expect(buildStackSlug("Jazz", 2)).not.toBe("Jazz-2");
  });
});
```

**Step 2: Run to verify they pass immediately** (pure logic, no DB)

```bash
bun test tests/unit/main-page-route.test.ts
```

Expected: all pass.

**Step 3: Add the stack route to `createMainPageRoutes()` in `server/routes/main-page.ts`**

Add this import at the top of the file:

```typescript
import { buildStackSlug, parseStackIdFromSlug } from "../../shared/slug";
```

Add a DB import for the stacks table (already imported: `stacks` from `"../db/schema"`, `db` from `"../db/index"`, `eq` from `"drizzle-orm"`).

Inside `createMainPageRoutes()`, add the stack route **before** the `GET "/"` route:

```typescript
routes.get("/stack/:slug", async (c) => {
  const slug = c.req.param("slug");

  // Extract ID from slug
  const stackId = parseStackIdFromSlug(slug);
  if (stackId === null) {
    return c.notFound();
  }

  // Look up stack in DB
  const stack = await db
    .select({ id: stacks.id, name: stacks.name })
    .from(stacks)
    .where(eq(stacks.id, stackId))
    .get();

  if (!stack) {
    return c.notFound();
  }

  // Redirect if slug is not canonical (e.g. stack was renamed)
  const canonical = buildStackSlug(stack.name, stack.id);
  if (slug !== canonical) {
    return c.redirect(`/stack/${canonical}`, 301);
  }

  // Render the same page as `/` but with selectedStackId in state
  const [initialItems, initialStacks, { cssHref, scriptSrc }] = await Promise.all([
    fetchInitialItems(),
    fetchInitialStacks(),
    getPageAssets(),
  ]);

  const musicListHtml = renderMusicList(initialItems, DEFAULT_FILTER, "");
  const stackBarTabsHtml = initialStacks.map((s) => renderStackTab(s)).join("");
  const stacksJson = safeJson({ stacks: initialStacks, selectedStackId: stackId });
  const primaryRssAlternateLinksHtml = renderPrimaryFeedAlternateLinks();
  const rssAlternateLinksHtml = renderStackFeedAlternateLinks(initialStacks);

  return c.html(
    renderMainPage({
      musicListHtml,
      stackBarTabsHtml,
      stacksJson,
      cssHref,
      scriptSrc,
      primaryRssAlternateLinksHtml,
      rssAlternateLinksHtml,
      isDev,
      appVersion: pkg.version,
    }),
  );
});
```

**Step 4: Register the stack route in `server/index.ts`**

The `mainPageRoutes` is already registered with `app.route("/", mainPageRoutes)` at line 25. The `/stack/:slug` handler is inside `mainPageRoutes`, so it is automatically registered at `/stack/:slug`. No change to `server/index.ts` is needed — verify this is the case by checking that `app.route("/", mainPageRoutes)` catches all paths served by `mainPageRoutes`.

**Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

**Step 6: Run all unit tests**

```bash
bun test tests/unit
```

Expected: all pass.

**Step 7: Commit**

```bash
git add server/routes/main-page.ts tests/unit/main-page-route.test.ts
git commit -m "feat: add /stack/:slug server route with canonical redirect"
```

---

### Task 3: Client — read selected stack from server state

**Files:**
- Modify: `src/app.ts` — `readServerState()` method and `initialize()` method

**Context:** `readServerState()` currently returns `{ stacks: StackWithCount[] } | null`. The server now embeds `selectedStackId` in the JSON. We need to read it and dispatch `STACK_SELECTED` before the music list renders.

**Step 1: Update `readServerState()` return type (lines ~109–117)**

Change the return type annotation and parsing:

```typescript
private readServerState(): { stacks: StackWithCount[]; selectedStackId?: number } | null {
  const el = document.getElementById("__initial_state__");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as { stacks: StackWithCount[]; selectedStackId?: number };
  } catch {
    return null;
  }
}
```

**Step 2: Use `selectedStackId` in `initialize()` (lines ~89–107)**

After dispatching `STACKS_LOADED`, check for `selectedStackId`:

```typescript
async initialize(): Promise<void> {
  this.setupAddForm();
  this.appActor.send({ type: "APP_READY" });

  const serverState = this.readServerState();
  if (serverState) {
    this.appActor.send({
      type: "STACKS_LOADED",
      stacks: serverState.stacks,
    });
    if (serverState.selectedStackId != null) {
      this.appActor.send({
        type: "STACK_SELECTED",
        stackId: serverState.selectedStackId,
      });
    }
  }

  // If a stack is pre-selected, we must fetch the filtered list (server rendered unfiltered)
  const hasServerData = serverState !== null && serverState.selectedStackId == null;
  this.initializeUI(hasServerData);

  const versionEl = document.getElementById("app-version");
  if (versionEl) {
    versionEl.textContent = `v${__APP_VERSION__}`;
  }
}
```

**Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

**Step 4: Run unit tests**

```bash
bun test tests/unit
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/app.ts
git commit -m "feat: read selectedStackId from server state on init"
```

---

### Task 4: Client — push state on stack tab click

**Files:**
- Modify: `src/app.ts` — `setupStackBar()` method
- Modify: `src/app.ts` — imports

**Context:** When a stack tab is clicked, `setupStackBar()` dispatches `STACK_SELECTED` or `STACK_SELECTED_ALL` then re-renders. We need to also push the correct URL. Stacks are in `this.appCtx.stacks`.

**Step 1: Add import for `buildStackSlug` at top of `src/app.ts`**

Add to the existing imports:

```typescript
import { buildStackSlug } from "../shared/slug";
```

**Step 2: Update the stack tab click handler in `setupStackBar()` (lines ~906–916)**

```typescript
if (tab.dataset.stack === "all") {
  this.appActor.send({ type: "STACK_SELECTED_ALL" });
  history.pushState(null, "", "/");
} else if (tab.dataset.stackId) {
  const stackId = Number(tab.dataset.stackId);
  this.appActor.send({ type: "STACK_SELECTED", stackId });
  const stack = this.appCtx.stacks.find((s) => s.id === stackId);
  if (stack) {
    history.pushState(null, "", `/stack/${buildStackSlug(stack.name, stack.id)}`);
  }
}
```

**Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

**Step 4: Run unit tests**

```bash
bun test tests/unit
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/app.ts
git commit -m "feat: push history state on stack tab click"
```

---

### Task 5: Client — popstate handler

**Files:**
- Modify: `src/app.ts` — add `setupPopstateHandler()` and call it from `initializeUI()`

**Context:** When the user presses back/forward, `popstate` fires. We need to re-parse the URL and update the app state. This mirrors the `setupStackBar()` click logic in reverse.

**Step 1: Add import for `parseStackIdFromSlug` at top of `src/app.ts`**

Update the existing shared/slug import:

```typescript
import { buildStackSlug, parseStackIdFromSlug } from "../shared/slug";
```

**Step 2: Add `setupPopstateHandler()` method to the `App` class**

```typescript
private setupPopstateHandler(): void {
  window.addEventListener("popstate", () => {
    const path = window.location.pathname;
    if (path.startsWith("/stack/")) {
      const slug = path.slice("/stack/".length);
      const stackId = parseStackIdFromSlug(slug);
      if (stackId !== null) {
        this.appActor.send({ type: "STACK_SELECTED", stackId });
        void this.renderStackBar();
        void this.renderMusicList();
        return;
      }
    }
    this.appActor.send({ type: "STACK_SELECTED_ALL" });
    void this.renderStackBar();
    void this.renderMusicList();
  });
}
```

**Step 3: Call `setupPopstateHandler()` from `initializeUI()` (lines ~119–141)**

Add it alongside the other setup calls:

```typescript
private initializeUI(hasServerData: boolean): void {
  this.setupFilterBar();
  this.setupBrowseControls();
  this.setupStackBar();
  this.setupStackManagePanel();
  this.setupStackParentLinker();
  this.setupLinkPicker();
  this.setupEventDelegation();
  this.setupMusicListReorder();
  this.setupCustomListScrollbar();
  this.setupCustomStackScrollbar();
  this.setupPopstateHandler(); // ← add this line

  if (hasServerData) {
    // ... rest unchanged
```

**Step 4: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

**Step 5: Run all unit tests**

```bash
bun test tests/unit
```

Expected: all pass.

**Step 6: Commit**

```bash
git add src/app.ts
git commit -m "feat: handle popstate for stack back/forward navigation"
```

---

### Task 6: Manual smoke test

Start the dev server:

```bash
bun run dev
```

Verify:

1. Load `/` — "All" tab is active, URL stays `/`
2. Click a stack tab — URL changes to `/stack/{slug}-{id}`, music list re-filters
3. Click "All" tab — URL returns to `/`
4. Press browser back — previous stack is selected again, URL returns to `/stack/...`
5. Direct load of `/stack/{slug}-{id}` — correct stack pre-selected, filtered list shown
6. Direct load of `/stack/wrong-name-{id}` (wrong slug, correct ID) — 301 redirect to canonical URL
7. Direct load of `/stack/anything-99999` (nonexistent ID) — 404

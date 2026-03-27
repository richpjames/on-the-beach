# Persistent Bandcamp Player Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Music from a Bandcamp release continues playing uninterrupted as the user navigates between pages, hosted in a draggable Win98-style window above a real taskbar.

**Architecture:** Replace the decorative CSS `body::before`/`body::after` taskbar with a real `<div id="taskbar">` DOM element. `#now-playing-player` becomes a draggable Win98 window housing the Bandcamp iframe. A new `src/player.ts` module manages the player lifecycle and exposes `window.__player` so inline release-page scripts can call `load()`. Release pages render a "▶ Listen" button instead of the inline iframe.

**Tech Stack:** Vanilla TypeScript, CSS custom properties (Win98 palette already in `main.css`), Bandcamp EmbeddedPlayer iframe

---

## Task 1: Add real taskbar DOM to the shell

**Files:**
- Modify: `server/routes/main-page.ts` (around line 432–442 and 456)

The footer currently has a dead `#now-playing-bar` block. Remove it. Replace the empty `#now-playing-player` div with a structured player window. Add the real taskbar element before the closing `</body>`.

**Step 1: Remove `#now-playing-bar` from the footer**

In `main-page.ts`, find the footer block (lines 432–442) and replace it with:

```html
<footer class="footer">
  <span id="app-version">v${escapeHtml(opts.appVersion)}</span>
</footer>
```

**Step 2: Replace `#now-playing-player` with structured player window**

Replace `<div id="now-playing-player" aria-hidden="true"></div>` (line 456) with:

```html
<div id="now-playing-player" class="player-window" hidden aria-hidden="true">
  <div class="player-window__titlebar" id="player-titlebar">
    <span class="player-window__icon" aria-hidden="true">♫</span>
    <span class="player-window__title" id="player-title-text">Now Playing</span>
    <div class="player-window__winbtns">
      <button class="player-window__winbtn" id="player-minimize" title="Minimize">_</button>
      <button class="player-window__winbtn player-window__winbtn--close" id="player-close" aria-label="Stop playback" title="Close">✕</button>
    </div>
  </div>
  <div class="player-window__body" id="player-body"></div>
</div>
```

**Step 3: Add `#taskbar` just before `</body>` (after `#add-loading-overlay` closes)**

```html
<div id="taskbar">
  <button id="taskbar-start" class="taskbar__start">🪟 Start</button>
  <button id="taskbar-np-btn" class="taskbar__task" hidden>
    <span aria-hidden="true">♫</span>
    <span id="taskbar-np-label"></span>
  </button>
  <span id="taskbar-clock" class="taskbar__clock"></span>
</div>
```

**Step 4: Commit**

```bash
git add server/routes/main-page.ts
git commit -m "feat: add real taskbar and player window DOM to shell"
```

---

## Task 2: Replace CSS pseudo-element taskbar with real styles

**Files:**
- Modify: `src/styles/main.css`

**Step 1: Remove `body::before` and `body::after` blocks**

Find and delete the two pseudo-element blocks (lines ~1946–1980):

```css
/* DELETE THIS: */
body::before {
  content: "🪟 Start";
  ...
}

/* DELETE THIS: */
body::after {
  content: "♫ On The Beach — Music Tracking";
  ...
}
```

**Step 2: Add taskbar styles**

After the `/* BODY TASKBAR */` section comment, add:

```css
/* ═══════════════════════════════════════════════════
   TASKBAR — Windows 98 (real DOM)
═══════════════════════════════════════════════════ */
#taskbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: var(--taskbar-height);
  background: var(--chrome);
  border-top: 2px solid var(--chrome-white);
  display: flex;
  align-items: stretch;
  z-index: 9999;
  gap: 0;
}

#taskbar-start {
  width: 80px;
  flex-shrink: 0;
  border: none;
  border-right: 2px solid var(--chrome-darker);
  font-weight: bold;
  font-size: 11px;
  font-family: "Tahoma", "MS Sans Serif", sans-serif;
  background: var(--chrome);
  cursor: default;
  padding: 0 8px;
  text-align: left;
}

.taskbar__task {
  padding: 2px 10px;
  font-size: 11px;
  font-family: "Tahoma", "MS Sans Serif", sans-serif;
  background: var(--chrome);
  border-width: 1px;
  border-style: solid;
  border-color: var(--chrome-white) var(--chrome-darker) var(--chrome-darker) var(--chrome-white);
  margin: 3px 2px;
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 180px;
  overflow: hidden;
  cursor: default;
  white-space: nowrap;
}

.taskbar__task[data-minimized] {
  border-color: var(--chrome-darker) var(--chrome-white) var(--chrome-white) var(--chrome-darker);
}

.taskbar__clock {
  margin-left: auto;
  padding: 0 10px;
  font-size: 11px;
  font-family: "Tahoma", "MS Sans Serif", sans-serif;
  border-left: 1px solid var(--chrome-dark);
  display: flex;
  align-items: center;
}
```

**Step 3: Add player window styles**

Append after the taskbar styles:

```css
/* ═══════════════════════════════════════════════════
   PLAYER WINDOW — Draggable Bandcamp player
═══════════════════════════════════════════════════ */
.player-window {
  position: fixed;
  bottom: calc(var(--taskbar-height) + 8px);
  right: 12px;
  width: 350px;
  background: var(--chrome);
  border-width: 2px;
  border-style: solid;
  border-color: var(--chrome-white) var(--chrome-darker) var(--chrome-darker) var(--chrome-white);
  box-shadow:
    3px 3px 0 #000000,
    4px 4px 0 rgba(0, 0, 0, 0.3);
  z-index: 9998;
  user-select: none;
}

.player-window__titlebar {
  background: var(--title-bar);
  padding: 3px 4px 3px 6px;
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: move;
}

.player-window__icon {
  font-size: 13px;
  line-height: 1;
}

.player-window__title {
  color: #ffffff;
  font-size: 11px;
  font-weight: bold;
  font-family: "Tahoma", "MS Sans Serif", sans-serif;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.player-window__winbtns {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.player-window__winbtn {
  width: 16px;
  height: 14px;
  font-size: 9px;
  font-weight: bold;
  background: var(--chrome);
  border-width: 1px;
  border-style: solid;
  border-color: var(--chrome-white) var(--chrome-darker) var(--chrome-darker) var(--chrome-white);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: #000000;
  line-height: 1;
  padding: 0;
  font-family: "Tahoma", monospace;
}

.player-window__winbtn:active {
  border-color: var(--chrome-darker) var(--chrome-white) var(--chrome-white) var(--chrome-darker);
}

.player-window__body {
  line-height: 0;
}

.player-window__body iframe {
  display: block;
  width: 100%;
  height: 241px;
  border: 0;
}
```

**Step 4: Commit**

```bash
git add src/styles/main.css
git commit -m "feat: replace taskbar pseudo-elements with real DOM styles, add player window styles"
```

---

## Task 3: Create `src/player.ts`

**Files:**
- Create: `src/player.ts`

This module owns the player window: loading iframes, dragging, toggling visibility, and the taskbar clock. It exposes `window.__player` so inline release-page scripts can call `load()`.

**Step 1: Create `src/player.ts`**

```typescript
declare global {
  interface Window {
    __player: { load: typeof load; stop: typeof stop };
  }
}

let windowEl: HTMLElement;
let titleEl: HTMLElement;
let bodyEl: HTMLElement;
let npBtnEl: HTMLButtonElement;
let npLabelEl: HTMLElement;

export function initPlayer(): void {
  windowEl = document.getElementById("now-playing-player") as HTMLElement;
  titleEl = document.getElementById("player-title-text") as HTMLElement;
  bodyEl = document.getElementById("player-body") as HTMLElement;
  npBtnEl = document.getElementById("taskbar-np-btn") as HTMLButtonElement;
  npLabelEl = document.getElementById("taskbar-np-label") as HTMLElement;

  document.getElementById("player-close")?.addEventListener("click", stop);
  document.getElementById("player-minimize")?.addEventListener("click", minimize);
  npBtnEl.addEventListener("click", toggleWindow);

  initDrag();
  initClock();

  window.__player = { load, stop };
}

function load(src: string, title: string, artist: string): void {
  const label = artist ? `${artist} — ${title}` : title;

  bodyEl.innerHTML = `<iframe src="${src}" seamless title="Bandcamp player"></iframe>`;
  titleEl.textContent = label;
  npLabelEl.textContent = label;

  npBtnEl.hidden = false;
  delete npBtnEl.dataset.minimized;
  windowEl.hidden = false;
  windowEl.removeAttribute("aria-hidden");
}

function stop(): void {
  bodyEl.innerHTML = "";
  npBtnEl.hidden = true;
  windowEl.hidden = true;
  windowEl.setAttribute("aria-hidden", "true");
  // Reset position so next open appears at default bottom-right
  windowEl.style.removeProperty("left");
  windowEl.style.removeProperty("top");
  windowEl.style.removeProperty("bottom");
  windowEl.style.removeProperty("right");
}

function minimize(): void {
  windowEl.hidden = true;
  npBtnEl.dataset.minimized = "true";
}

function toggleWindow(): void {
  if (windowEl.hidden) {
    windowEl.hidden = false;
    windowEl.removeAttribute("aria-hidden");
    delete npBtnEl.dataset.minimized;
  } else {
    minimize();
  }
}

function initDrag(): void {
  const titlebar = document.getElementById("player-titlebar")!;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dragging = false;

  titlebar.addEventListener("mousedown", (e) => {
    if ((e.target as Element).closest("button")) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = windowEl.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    windowEl.style.left = `${startLeft + (e.clientX - startX)}px`;
    windowEl.style.top = `${startTop + (e.clientY - startY)}px`;
    windowEl.style.bottom = "auto";
    windowEl.style.right = "auto";
  });

  document.addEventListener("mouseup", () => {
    dragging = false;
  });
}

function initClock(): void {
  const clockEl = document.getElementById("taskbar-clock");
  if (!clockEl) return;

  function tick(): void {
    const now = new Date();
    clockEl!.textContent = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  tick();
  setInterval(tick, 10_000);
}
```

**Step 2: Wire up in `src/main.ts`**

Add `import { initPlayer } from "./player";` and call `initPlayer()` in `bootstrap()`:

```typescript
import { initialize } from "./app";
import { initRouter } from "./router";
import { initPlayer } from "./player";

async function bootstrap() {
  try {
    await initialize();
    initRouter();
    initPlayer();
    console.log("[App] Initialized successfully");
  } catch (error) {
    ...
  }
}
```

**Step 3: Commit**

```bash
git add src/player.ts src/main.ts
git commit -m "feat: add player.ts - persistent draggable player with taskbar clock"
```

---

## Task 4: Replace inline Bandcamp embed with Listen button

**Files:**
- Modify: `server/routes/release-page.ts`

**Step 1: Change `renderBandcampEmbed()` to return a button**

Replace the function body (lines 88–103) with:

```typescript
function renderBandcampEmbed(item: MusicItemFull): string {
  const meta = parseLinkMetadata(item.primary_link_metadata);
  const albumId = meta?.album_id;
  if (!albumId) return "";

  const embedType = meta.item_type === "track" ? "track" : "album";
  const src = `https://bandcamp.com/EmbeddedPlayer/${embedType}=${escapeHtml(albumId)}/size=large/bgcol=ffffff/linkcol=0687f5/artwork=none/transparent=true/`;
  const title = escapeHtml(item.title);
  const artist = escapeHtml(item.artist_name ?? "");

  return `<button
    class="release-page__listen-btn"
    data-src="${src}"
    data-title="${title}"
    data-artist="${artist}"
  >▶ Listen</button>`;
}
```

**Step 2: Add Listen button click handler to the release page inline script**

In the inline `<script>` block in `renderReleasePage()` (after `const ITEM_ID = ${item.id};`), add:

```javascript
const listenBtn = document.querySelector('.release-page__listen-btn');
if (listenBtn) {
  listenBtn.addEventListener('click', () => {
    window.__player?.load(
      listenBtn.dataset.src,
      listenBtn.dataset.title,
      listenBtn.dataset.artist,
    );
  });
}
```

**Step 3: Commit**

```bash
git add server/routes/release-page.ts
git commit -m "feat: replace inline Bandcamp embed with Listen button that loads persistent player"
```

---

## Task 5: Style the Listen button

**Files:**
- Modify: `src/styles/main.css`

**Step 1: Add `.release-page__listen-btn` styles**

Find the release page section in `main.css` (search for `.release-page__`) and add:

```css
.release-page__listen-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-family: "Tahoma", "MS Sans Serif", sans-serif;
  font-size: 11px;
  background: var(--chrome);
  border-width: 2px;
  border-style: solid;
  border-color: var(--chrome-white) var(--chrome-darker) var(--chrome-darker) var(--chrome-white);
  cursor: pointer;
  color: #000000;
  margin-top: 8px;
}

.release-page__listen-btn:active {
  border-color: var(--chrome-darker) var(--chrome-white) var(--chrome-white) var(--chrome-darker);
}
```

**Step 2: Commit**

```bash
git add src/styles/main.css
git commit -m "feat: style Listen button in Win98 theme"
```

---

## Task 6: Playwright test — player persists across navigation

**Files:**
- Create: `playwright/persistent-player.spec.ts`

This test seeds a Bandcamp item that already has `primary_link_metadata` with an `album_id`, navigates to its release page, clicks Listen, then navigates away and verifies the player is still visible.

**Step 1: Check how the test API seeds data**

Read `playwright/fixtures/` to understand how `request.post("/api/__test__/reset")` and item creation work. Look at an existing test like `bandcamp-link.spec.ts` for the pattern.

**Step 2: Write the test**

```typescript
import { expect, test } from "./fixtures/parallel-test";

// A real Bandcamp album that the scraper will resolve with an album_id.
// Uses seekers international since it's already referenced in other tests.
const BANDCAMP_URL =
  "https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("player persists when navigating back to the list", async ({ page }) => {
  // Add a Bandcamp item and wait for it to be scraped
  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  // Navigate to the release page
  await page.locator(".music-card").first().click();
  await expect(page.locator(".release-page__listen-btn")).toBeVisible({ timeout: 5_000 });

  // Click Listen
  await page.locator(".release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();
  await expect(page.locator("#taskbar-np-btn")).toBeVisible();

  // Navigate back to the list
  await page.locator("a[href='/']").first().click();
  await expect(page.locator("#main")).toBeVisible();

  // Player is still visible and taskbar button still present
  await expect(page.locator("#now-playing-player")).toBeVisible();
  await expect(page.locator("#taskbar-np-btn")).toBeVisible();
});

test("taskbar button toggles player visibility", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().click();
  await expect(page.locator(".release-page__listen-btn")).toBeVisible({ timeout: 5_000 });
  await page.locator(".release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  // Minimize via taskbar button
  await page.locator("#taskbar-np-btn").click();
  await expect(page.locator("#now-playing-player")).toBeHidden();

  // Restore via taskbar button
  await page.locator("#taskbar-np-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();
});

test("close button stops playback", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().click();
  await expect(page.locator(".release-page__listen-btn")).toBeVisible({ timeout: 5_000 });
  await page.locator(".release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  await page.locator("#player-close").click();
  await expect(page.locator("#now-playing-player")).toBeHidden();
  await expect(page.locator("#taskbar-np-btn")).toBeHidden();
});
```

**Step 3: Run the tests**

```bash
npx playwright test playwright/persistent-player.spec.ts --headed
```

Expected: all 3 tests pass. If the scraper doesn't return an `album_id` for the test URL (possible in CI without network), the Listen button won't render — that's acceptable; the test would need a pre-seeded item with metadata.

**Step 4: Commit**

```bash
git add playwright/persistent-player.spec.ts
git commit -m "test: add Playwright tests for persistent Bandcamp player"
```

---

## Checklist

- [ ] Task 1: Real taskbar + player window DOM in shell HTML
- [ ] Task 2: CSS — replace pseudo-elements, add taskbar + player window styles
- [ ] Task 3: `src/player.ts` + wire into `main.ts`
- [ ] Task 4: Release page renders Listen button instead of inline iframe
- [ ] Task 5: Style the Listen button
- [ ] Task 6: Playwright tests

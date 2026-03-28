# YouTube Persistent Player Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the inline YouTube iframe on release pages with a `▶ Watch` button that loads into the same persistent floating player window as Bandcamp, auto-resizing to video dimensions.

**Architecture:** `renderYouTubeEmbed()` in the release-page route is replaced by `renderYouTubeButton()`, which emits a `release-page__listen-btn` with `data-player-type="video"`. The inline script already wires up all `.release-page__listen-btn` clicks; it gains a fourth `playerType` arg pass-through. `player.ts`'s `load()` gains an optional `playerType` param that toggles a `player-window--video` CSS class and adds iframe `allow`/`allowfullscreen` attributes. The player window CSS gets a `--video` modifier for wider dimensions.

**Tech Stack:** TypeScript, Bun test, Hono SSR, vanilla DOM, CSS custom properties

---

### Task 1: Update YouTube release page tests to expect a button (not inline iframe)

The existing "YouTube embed" describe block expects `<iframe` and `youtube-nocookie.com/embed/…` in the raw HTML. After this change those will be in a `data-src` attribute on a button instead.

**Files:**
- Modify: `tests/unit/release-page-route.test.ts`

**Step 1: Update the three video-URL tests**

Replace the body of the `test.each` that checks `<iframe` + `youtube-nocookie.com/embed/iS7-iBia7GE`:

```typescript
test.each([
  ["www.youtube.com", "https://www.youtube.com/watch?v=iS7-iBia7GE"],
  ["m.youtube.com (mobile)", "https://m.youtube.com/watch?v=iS7-iBia7GE"],
  ["youtu.be (shortlink)", "https://youtu.be/iS7-iBia7GE"],
])("renders YouTube watch button for %s URL", async (_label, primary_url) => {
  const item = {
    ...baseItem,
    primary_url,
    primary_source: "youtube" as const,
    primary_link_metadata: null,
  };
  mockFetchItem.mockResolvedValue(item);
  const app = makeApp();
  const res = await app.request("http://localhost/r/42");
  const html = await res.text();
  expect(html).toContain('data-src="https://www.youtube-nocookie.com/embed/iS7-iBia7GE"');
  expect(html).toContain('data-player-type="video"');
  expect(html).toContain("release-page__listen-btn");
  expect(html).not.toContain("<iframe");
});
```

**Step 2: Update the playlist test**

Replace the playlist test body (currently checks for `<iframe` and inline embed URL):

```typescript
test("renders YouTube watch button for playlist URL", async () => {
  const item = {
    ...baseItem,
    primary_url: "https://www.youtube.com/playlist?list=PLE31AAD9114F343C4",
    primary_source: "youtube" as const,
    primary_link_metadata: null,
  };
  mockFetchItem.mockResolvedValue(item);
  const app = makeApp();
  const res = await app.request("http://localhost/r/42");
  const html = await res.text();
  expect(html).toContain('data-src="https://www.youtube-nocookie.com/embed/videoseries?list=PLE31AAD9114F343C4"');
  expect(html).toContain('data-player-type="video"');
  expect(html).toContain("release-page__listen-btn");
  expect(html).not.toContain("<iframe");
});
```

**Step 3: Add a test that artwork shows for YouTube items (not inline video)**

```typescript
test("shows artwork image for youtube items instead of inline video", async () => {
  const item = {
    ...baseItem,
    primary_url: "https://www.youtube.com/watch?v=iS7-iBia7GE",
    primary_source: "youtube" as const,
    artwork_url: "/uploads/yt-art.jpg",
    primary_link_metadata: null,
  };
  mockFetchItem.mockResolvedValue(item);
  const app = makeApp();
  const res = await app.request("http://localhost/r/42");
  const html = await res.text();
  expect(html).toContain('src="/uploads/yt-art.jpg"');
  expect(html).toContain("release-page__artwork");
});
```

**Step 4: Run tests to verify they now fail**

```bash
bun test tests/unit/release-page-route.test.ts
```

Expected: The updated YouTube tests FAIL (still finding `<iframe`, not finding button).

---

### Task 2: Implement `renderYouTubeButton()` and update the release page template

**Files:**
- Modify: `server/routes/release-page.ts`

**Step 1: Replace `renderYouTubeEmbed()` with `renderYouTubeButton()`**

Delete the `renderYouTubeEmbed` function entirely and add:

```typescript
function renderYouTubeButton(item: MusicItemFull): string {
  if (!item.primary_url) return "";

  const videoId = extractYouTubeVideoId(item.primary_url);
  if (videoId && /^[\w-]+$/.test(videoId)) {
    const src = `https://www.youtube-nocookie.com/embed/${escapeHtml(videoId)}`;
    const title = escapeHtml(item.title);
    const artist = escapeHtml(item.artist_name ?? "");
    return `<button
    class="release-page__listen-btn"
    data-src="${src}"
    data-title="${title}"
    data-artist="${artist}"
    data-player-type="video"
  >▶ Watch</button>`;
  }

  const playlistId = extractYouTubePlaylistId(item.primary_url);
  if (playlistId && /^[\w-]+$/.test(playlistId)) {
    const src = `https://www.youtube-nocookie.com/embed/videoseries?list=${escapeHtml(playlistId)}`;
    const title = escapeHtml(item.title);
    const artist = escapeHtml(item.artist_name ?? "");
    return `<button
    class="release-page__listen-btn"
    data-src="${src}"
    data-title="${title}"
    data-artist="${artist}"
    data-player-type="video"
  >▶ Watch</button>`;
  }

  return "";
}
```

**Step 2: Update the release page template**

In `renderReleasePage`, find the line that starts with:

```typescript
${extractYouTubeVideoId(item.primary_url ?? "") || extractYouTubePlaylistId(item.primary_url ?? "") ? renderYouTubeEmbed(item) : safeArtworkUrl(item.artwork_url ?? "") ? `<img class="release-page__artwork" src="${escapeHtml(item.artwork_url!)}" alt="Artwork for ${escapeHtml(item.title)}" />` : ""}
```

Replace it with (artwork always shown when available, regardless of YouTube):

```typescript
${safeArtworkUrl(item.artwork_url ?? "") ? `<img class="release-page__artwork" src="${escapeHtml(item.artwork_url!)}" alt="Artwork for ${escapeHtml(item.title)}" />` : ""}
```

**Step 3: Add YouTube button to the content section**

Find the Bandcamp embed line:

```typescript
${item.primary_url?.includes("bandcamp.com") ? renderBandcampEmbed(item) : ""}
```

Add the YouTube button on the next line:

```typescript
${item.primary_url?.includes("bandcamp.com") ? renderBandcampEmbed(item) : ""}
${item.primary_source === "youtube" ? renderYouTubeButton(item) : ""}
```

**Step 4: Update the inline script to pass `playerType`**

Find the block starting with `const listenBtn = document.querySelector('.release-page__listen-btn');` and update the `window.__player?.load(...)` call:

```javascript
window.__player?.load(
  src,
  listenBtn.dataset.title ?? '',
  listenBtn.dataset.artist ?? '',
  listenBtn.dataset.playerType ?? 'audio',
);
```

**Step 5: Run tests**

```bash
bun test tests/unit/release-page-route.test.ts
```

Expected: All YouTube tests PASS. All Bandcamp and Mixcloud tests still PASS.

**Step 6: Commit**

```bash
git add server/routes/release-page.ts tests/unit/release-page-route.test.ts
git commit -m "feat: replace inline YouTube embed with persistent player button"
```

---

### Task 3: Update `player.ts` to support `playerType`

**Files:**
- Modify: `src/player.ts`

There are no unit tests for `player.ts` (DOM module). Manual verification is at the end.

**Step 1: Add `playerType` to `load()` and apply video mode**

Update the `load` function signature and body:

```typescript
function load(src: string, title: string, artist: string, playerType: "audio" | "video" = "audio"): void {
  const label = artist ? `${artist} — ${title}` : title;

  bodyEl.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src = src;
  iframe.title = playerType === "video" ? "YouTube player" : "Bandcamp player";
  iframe.setAttribute("seamless", "");
  if (playerType === "video") {
    iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture");
    iframe.allowFullscreen = true;
    windowEl.classList.add("player-window--video");
  } else {
    windowEl.classList.remove("player-window--video");
  }
  bodyEl.appendChild(iframe);
  titleEl.textContent = label;
  npLabelEl.textContent = label;

  npBtnEl.hidden = false;
  delete npBtnEl.dataset.minimized;
  windowEl.hidden = false;
  windowEl.removeAttribute("aria-hidden");
}
```

**Step 2: Remove video class on `stop()`**

In the `stop()` function, add after `bodyEl.innerHTML = ""`:

```typescript
windowEl.classList.remove("player-window--video");
```

**Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: No errors.

**Step 4: Commit**

```bash
git add src/player.ts
git commit -m "feat: player load() supports video mode with wider window"
```

---

### Task 4: Add CSS for `player-window--video` modifier

**Files:**
- Modify: `src/styles/main.css`

**Step 1: Add the video modifier rules**

After the `.player-window__body iframe { ... }` block (around line 2100), add:

```css
.player-window--video {
  width: 480px;
}

.player-window--video .player-window__body iframe {
  height: auto;
  aspect-ratio: 16 / 9;
}
```

**Step 2: Run full test suite**

```bash
bun test tests/unit
```

Expected: All tests PASS.

**Step 3: Commit**

```bash
git add src/styles/main.css
git commit -m "feat: player-window--video CSS modifier for 16:9 video size"
```

---

### Task 5: Manual smoke test

Start the dev server and verify end-to-end:

```bash
bun run dev
```

1. Open a YouTube release page (e.g. `/r/<id>` for an item with a YouTube URL)
2. Confirm the page shows artwork (not an inline video)
3. Confirm a `▶ Watch` button appears in the content area
4. Click `▶ Watch` — the floating player window should open at 480px wide with a 16:9 iframe
5. Navigate back to `/` — the player should persist (audio preserved)
6. Open a Bandcamp release page — confirm `▶ Listen` still works and the player returns to compact (350px) size

---

**Plan complete and saved to `docs/plans/2026-03-28-youtube-persistent-player.md`. Two execution options:**

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open a new session with `superpowers:executing-plans`, batch execution with checkpoints

**Which approach?**

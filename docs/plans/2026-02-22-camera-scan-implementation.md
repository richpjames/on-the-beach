# Camera Scan Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a camera button to the add-item form that snaps a photo of a record/CD cover, sends it to Mistral's vision API, and prefills artist + title fields.

**Architecture:** Browser captures a photo via native file input, resizes it client-side, and POSTs base64 to `POST /api/release/scan`. The Hono backend saves the image to `/uploads/`, sends it to Mistral's vision API (`mistral-small-latest`), parses the structured JSON response, and returns `{ artist, title, artworkPath }`. The frontend expands the "More options" panel and prefills the fields.

**Tech Stack:** Hono (backend), vanilla TypeScript (frontend), `@mistralai/mistralai` SDK, Bun runtime, Playwright (E2E), `bun:test` (unit)

---

### Task 1: Install Mistral SDK

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run: `bun add @mistralai/mistralai`

**Step 2: Verify installation**

Run: `bun pm ls | grep mistral`
Expected: `@mistralai/mistralai` appears in the list

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add @mistralai/mistralai SDK"
```

---

### Task 2: Vision module — unit test + implementation

**Files:**
- Create: `server/vision.ts`
- Create: `tests/unit/vision.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/vision.test.ts`:

```typescript
import { describe, test, expect, mock, spyOn, afterEach } from "bun:test";
import { extractAlbumInfo, type ScanResult } from "../../server/vision";

// We mock at the fetch level since the Mistral SDK uses fetch internally.
// This avoids coupling tests to SDK internals.

describe("extractAlbumInfo", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns artist and title from a successful response", async () => {
    // The Mistral SDK uses fetch under the hood.
    // We mock fetch to return a chat completion with our expected JSON.
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: '{"artist": "Radiohead", "title": "OK Computer"}',
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const result = await extractAlbumInfo("base64imagedata");
    expect(result).toEqual({ artist: "Radiohead", title: "OK Computer" });
  });

  test("returns null fields when LLM cannot identify content", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: '{"artist": null, "title": null}',
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const result = await extractAlbumInfo("base64imagedata");
    expect(result).toEqual({ artist: null, title: null });
  });

  test("returns null when API call fails", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const result = await extractAlbumInfo("base64imagedata");
    expect(result).toBeNull();
  });

  test("returns null when response is not valid JSON", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I can see an album cover but I'm not sure what it is",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const result = await extractAlbumInfo("base64imagedata");
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/vision.test.ts`
Expected: FAIL — `Cannot find module "../../server/vision"`

**Step 3: Write the implementation**

Create `server/vision.ts`:

```typescript
import { Mistral } from "@mistralai/mistralai";

export interface ScanResult {
  artist: string | null;
  title: string | null;
}

const PROMPT = `You are looking at a photo of a music record, CD, or album cover.
Identify the artist name and the album title from the cover.
Return ONLY a JSON object with this exact shape: {"artist": "...", "title": "..."}
If you cannot determine a field, set it to null.
Do not include any other text, explanation, or markdown formatting.`;

/**
 * Send a base64-encoded image to Mistral's vision API and extract
 * the artist name and album title.
 *
 * Returns null if the API call fails or the response cannot be parsed.
 */
export async function extractAlbumInfo(base64Image: string): Promise<ScanResult | null> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    console.error("MISTRAL_API_KEY is not set");
    return null;
  }

  const client = new Mistral({ apiKey });

  try {
    const response = await client.chat.complete({
      model: "mistral-small-latest",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            {
              type: "image_url",
              imageUrl: `data:image/jpeg;base64,${base64Image}`,
            },
          ],
        },
      ],
    });

    const text = response.choices?.[0]?.message?.content;
    if (typeof text !== "string") return null;

    const parsed = JSON.parse(text);
    return {
      artist: parsed.artist ?? null,
      title: parsed.title ?? null,
    };
  } catch {
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/vision.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add server/vision.ts tests/unit/vision.test.ts
git commit -m "feat: add Mistral vision module for album cover extraction"
```

---

### Task 3: Release scan route + uploads directory

**Files:**
- Create: `server/routes/release.ts`
- Modify: `server/index.ts`

**Step 1: Create the uploads directory**

Run: `mkdir -p uploads && echo "uploads/" >> .gitignore`

Check `.gitignore` already has `uploads/` or add it.

**Step 2: Create the route file**

Create `server/routes/release.ts`:

```typescript
import { Hono } from "hono";
import { extractAlbumInfo } from "../vision";

export const releaseRoutes = new Hono();

releaseRoutes.post("/scan", async (c) => {
  const body = await c.req.json<{ image: string }>();

  if (!body.image) {
    return c.json({ error: "No image provided" }, 400);
  }

  // Strip data URL prefix if present (e.g. "data:image/jpeg;base64,")
  const base64 = body.image.replace(/^data:image\/\w+;base64,/, "");

  // Save image to uploads directory
  const filename = `${crypto.randomUUID()}.jpg`;
  const filepath = `uploads/${filename}`;
  const buffer = Buffer.from(base64, "base64");
  await Bun.write(filepath, buffer);

  // Extract artist and title via Mistral vision
  const result = await extractAlbumInfo(base64);

  if (!result) {
    return c.json({
      artist: null,
      title: null,
      artworkPath: `/uploads/${filename}`,
    });
  }

  return c.json({
    artist: result.artist,
    title: result.title,
    artworkPath: `/uploads/${filename}`,
  });
});
```

**Step 3: Mount the route and serve uploads in `server/index.ts`**

Add after line 5 (the ingest import):
```typescript
import { releaseRoutes } from "./routes/release";
```

Add after line 12 (`app.route("/api/ingest", ingestRoutes);`):
```typescript
app.route("/api/release", releaseRoutes);
```

Add uploads static serving. In the production block (after line 57), add before the SPA fallback:
```typescript
app.use("/uploads/*", serveStatic({ root: "./" }));
```

In the dev block, add a route handler for uploads in the HTTP server callback (inside the `createHttpServer` callback, before the viteHandle call):
```typescript
if (req.url?.startsWith("/uploads/")) {
  honoListener(req, res);
  return;
}
```

And add the same `app.use("/uploads/*", ...)` line at the app level (before the dev/production branching) so it works in both modes:

Actually, simplest approach: add the static serving right after the API routes (around line 13), before the dev/prod branching:
```typescript
app.use("/uploads/*", serveStatic({ root: "./" }));
```

And in the dev server's request handler, add `/uploads/` alongside `/api/`:
```typescript
if (req.url?.startsWith("/api/") || req.url?.startsWith("/uploads/")) {
```

**Step 4: Verify the server starts**

Run: `NODE_ENV=test bun server/index.ts &` then `curl -s http://localhost:3000/api/release/scan -X POST -H 'Content-Type: application/json' -d '{}' | head`
Expected: `{"error":"No image provided"}` with status 400

Kill the background server.

**Step 5: Commit**

```bash
git add server/routes/release.ts server/index.ts .gitignore
git commit -m "feat: add POST /api/release/scan endpoint with uploads"
```

---

### Task 4: Client-side — camera button + image resize + scan request

**Files:**
- Modify: `index.html`
- Modify: `src/app.ts`
- Modify: `src/services/api-client.ts`
- Modify: `src/types/index.ts`

**Step 1: Add ScanResult type**

In `src/types/index.ts`, add at the end:

```typescript
export interface ScanResult {
  artist: string | null;
  title: string | null;
  artworkPath: string;
}
```

**Step 2: Add API client method**

In `src/services/api-client.ts`, add to the `ApiClient` class after the music items section:

```typescript
  // ── Release scanning ─────────────────────────────────────────

  async scanCover(imageBase64: string): Promise<ScanResult> {
    const res = await fetch(`${this.baseUrl}/api/release/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageBase64 }),
    });
    if (!res.ok) throw new Error(`scanCover failed: ${res.status}`);
    return res.json();
  }
```

Add `ScanResult` to the import from `../types`.

**Step 3: Add camera button and hidden file input to `index.html`**

In `index.html`, inside the `.add-form__row` div (after the URL input, before the submit button), add:

```html
<input
  type="file"
  id="camera-input"
  accept="image/*"
  capture="environment"
  hidden
/>
<button type="button" class="btn btn--ghost" id="scan-btn" title="Scan album cover">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
    <circle cx="12" cy="13" r="4"></circle>
  </svg>
</button>
```

**Step 4: Add scan handling to `src/app.ts`**

In the `App` class, add a new private field:

```typescript
private pendingArtworkPath: string | null = null;
```

In `setupAddForm()`, after the stack chip removal listener (around line 68), add:

```typescript
    // Camera scan button
    const scanBtn = document.getElementById("scan-btn");
    const cameraInput = document.getElementById("camera-input") as HTMLInputElement;

    scanBtn?.addEventListener("click", () => {
      cameraInput?.click();
    });

    cameraInput?.addEventListener("change", async () => {
      const file = cameraInput.files?.[0];
      if (!file) return;

      scanBtn!.disabled = true;
      scanBtn!.classList.add("scanning");

      try {
        const base64 = await this.resizeAndEncode(file);
        const result = await this.api.scanCover(base64);

        if (result.artist || result.title) {
          // Expand the details panel
          const details = form.querySelector(".add-form__details") as HTMLDetailsElement;
          if (details) details.open = true;

          // Prefill fields
          const artistInput = form.querySelector('input[name="artist"]') as HTMLInputElement;
          const titleInput = form.querySelector('input[name="title"]') as HTMLInputElement;
          if (result.artist && artistInput) artistInput.value = result.artist;
          if (result.title && titleInput) titleInput.value = result.title;

          this.pendingArtworkPath = result.artworkPath;
        } else {
          alert("Couldn't read the cover. Try again or enter details manually.");
        }
      } catch {
        alert("Scan unavailable. Enter details manually.");
      } finally {
        scanBtn!.disabled = false;
        scanBtn!.classList.remove("scanning");
        cameraInput.value = "";
      }
    });
```

Add the `resizeAndEncode` private method to the `App` class:

```typescript
  private resizeAndEncode(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1024;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, width, height);
        // Return base64 without the data URL prefix
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve(dataUrl.replace(/^data:image\/\w+;base64,/, ""));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
```

In the form submit handler (around line 97), add `artworkUrl` to the create call. After the `notes` variable declaration, add:

```typescript
      const artworkUrl = this.pendingArtworkPath ?? undefined;
```

Add `artworkUrl` to the `createMusicItem` call object. Then after form.reset(), clear the pending artwork:

```typescript
        this.pendingArtworkPath = null;
```

**Step 5: Update `CreateMusicItemInput` type**

In `src/types/index.ts`, add to `CreateMusicItemInput`:

```typescript
  artworkUrl?: string;
```

**Step 6: Update backend to accept `artworkUrl` in create input**

In `server/music-item-creator.ts`, update `createMusicItemDirect` (line 213) to use the override:

```typescript
artworkUrl: overrides.artworkUrl ?? null,
```

(It's currently hardcoded to `null`.)

**Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

**Step 8: Commit**

```bash
git add index.html src/app.ts src/services/api-client.ts src/types/index.ts server/music-item-creator.ts
git commit -m "feat: add camera scan button with image resize and form prefill"
```

---

### Task 5: CSS for camera button and scanning state

**Files:**
- Modify: `src/styles/main.css`

**Step 1: Add camera button styles**

In `src/styles/main.css`, after the `.btn--danger:hover` rule (around line 332), add:

```css
/* Camera scan button */
#scan-btn {
  flex-shrink: 0;
}

#scan-btn.scanning {
  opacity: 0.5;
  pointer-events: none;
}

#scan-btn.scanning svg {
  animation: scan-pulse 1s ease-in-out infinite;
}

@keyframes scan-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
```

**Step 2: Verify visually**

Run: `bun run dev`
Open http://localhost:3000 on a browser — confirm the camera button appears in the form row.

**Step 3: Commit**

```bash
git add src/styles/main.css
git commit -m "style: add camera scan button and scanning animation"
```

---

### Task 6: E2E test — scan cover prefills form

**Files:**
- Create: `playwright/scan-cover.spec.ts`

**Step 1: Write the E2E test**

Create `playwright/scan-cover.spec.ts`:

```typescript
import { expect, test } from "@playwright/test";
import * as path from "node:path";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("scan cover button triggers file input and prefills form on API response", async ({
  page,
}) => {
  await page.goto("/");

  // Mock the /api/release/scan endpoint to avoid needing a real Mistral API key
  await page.route("**/api/release/scan", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        artist: "Boards of Canada",
        title: "Music Has the Right to Children",
        artworkPath: "/uploads/test.jpg",
      }),
    });
  });

  // The scan button should be visible
  const scanBtn = page.locator("#scan-btn");
  await expect(scanBtn).toBeVisible();

  // Prepare file chooser before clicking
  const fileChooserPromise = page.waitForEvent("filechooser");
  await scanBtn.click();
  const fileChooser = await fileChooserPromise;

  // Upload a test image (a small 1x1 pixel JPEG)
  // We create a minimal JPEG buffer for the test
  await fileChooser.setFiles({
    name: "cover.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//wgALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//aAAgBAQAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPwB//9k=",
      "base64",
    ),
  });

  // Wait for the form to be prefilled
  const artistInput = page.locator('input[name="artist"]');
  const titleInput = page.locator('input[name="title"]');

  // The details panel should auto-expand
  await expect(page.locator(".add-form__details")).toHaveAttribute("open", "");

  // Fields should be prefilled
  await expect(artistInput).toHaveValue("Boards of Canada", { timeout: 5_000 });
  await expect(titleInput).toHaveValue("Music Has the Right to Children");
});
```

**Step 2: Run the test**

Run: `bunx playwright test playwright/scan-cover.spec.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add playwright/scan-cover.spec.ts
git commit -m "test: add E2E test for camera scan cover flow"
```

---

### Task 7: Update Dockerfile and documentation

**Files:**
- Modify: `Dockerfile`

**Step 1: Add uploads volume to Dockerfile**

In `Dockerfile`, before the `CMD` line, add:

```dockerfile
RUN mkdir -p /app/uploads
VOLUME ["/app/uploads"]
```

**Step 2: Commit**

```bash
git add Dockerfile
git commit -m "chore: add uploads volume to Dockerfile"
```

---

### Task 8: Run full test suite and verify

**Step 1: Run unit tests**

Run: `bun test tests/unit`
Expected: All tests pass

**Step 2: Run E2E tests**

Run: `bunx playwright test playwright/scan-cover.spec.ts`
Expected: All tests pass

**Step 3: Run lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: No errors

**Step 4: Final commit if any fixups needed**

Only if previous steps required changes.

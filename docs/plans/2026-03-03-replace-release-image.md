# Replace Release Image — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users replace a release's artwork from the release detail page edit mode, via file upload or URL input.

**Architecture:** All changes are confined to `server/routes/release-page.ts`. The edit-mode HTML gets an "Artwork" section (hidden file input + upload button + URL text field). Client JS handles the upload flow (base64-encode → POST /api/release/image → populate URL field) and includes `artworkUrl` in the existing Save PATCH. No new endpoints.

**Tech Stack:** Hono (server-side HTML), vanilla JS in inline `<script>`, Playwright (E2E tests), Bun (test runner: `bun test`).

---

### Task 1: Write and run the failing Playwright test

**Files:**
- Create: `playwright/replace-image.spec.ts`

The test verifies the full happy path: open edit mode on a release, upload a mocked image, save, see the new artwork.

**Step 1: Create the test file**

```typescript
// playwright/replace-image.spec.ts
import path from "node:path";
import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("can replace release image via file upload in edit mode", async ({ page, request }) => {
  // Create an item with no artwork
  const res = await request.post("/api/music-items", {
    data: { title: "Replace Image Test", listenStatus: "to-listen" },
  });
  const item = await res.json();

  await page.goto(`/r/${item.id}`);

  // Mock the upload endpoint
  await page.route("**/api/release/image", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ artworkUrl: "/uploads/mock-replaced.jpg" }),
    });
  });

  // Enter edit mode
  await page.getByRole("button", { name: "Edit" }).click();

  // The artwork section should be visible
  await expect(page.locator("#edit-artwork-url")).toBeVisible();

  // Upload a file
  const fixturePath = path.join(process.cwd(), "playwright/fixtures/cover-sample.png");
  await page.getByRole("button", { name: "Replace image" }).click();
  await page.locator("#artwork-file-input").setInputFiles(fixturePath);

  // URL field should be populated with the mock URL
  await expect(page.locator("#edit-artwork-url")).toHaveValue("/uploads/mock-replaced.jpg", {
    timeout: 5_000,
  });

  // Save
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(`/r/${item.id}`);

  // New artwork should be displayed
  await expect(page.locator(".release-page__artwork")).toHaveAttribute(
    "src",
    "/uploads/mock-replaced.jpg",
  );
});

test("can replace release image via URL input in edit mode", async ({ page, request }) => {
  // Create an item
  const res = await request.post("/api/music-items", {
    data: { title: "URL Replace Test", listenStatus: "to-listen" },
  });
  const item = await res.json();

  await page.goto(`/r/${item.id}`);

  // Enter edit mode
  await page.getByRole("button", { name: "Edit" }).click();

  // Clear and type a new URL
  await page.locator("#edit-artwork-url").fill("https://example.com/new-art.jpg");

  // Save
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(`/r/${item.id}`);

  // New artwork should be displayed
  await expect(page.locator(".release-page__artwork")).toHaveAttribute(
    "src",
    "https://example.com/new-art.jpg",
  );
});
```

**Step 2: Run to confirm failure**

```bash
cd /workspace && bunx playwright test playwright/replace-image.spec.ts --reporter=line
```

Expected: both tests FAIL — elements like `#edit-artwork-url` and "Replace image" button don't exist yet.

---

### Task 2: Add artwork section HTML to edit mode

**Files:**
- Modify: `server/routes/release-page.ts`

**Step 1: Locate the anchor point**

In `renderReleasePage`, find the edit-mode fields div. It ends with:

```html
                  <div class="release-page__edit-actions">
                    <button type="button" class="btn btn--primary" id="save-btn">Save changes</button>
                    <button type="button" class="btn" id="cancel-btn">Cancel</button>
                  </div>
                </div>
```

**Step 2: Add the artwork section HTML just before the closing `</div>` of `release-page__edit-fields`**

Replace:
```typescript
                  <div class="release-page__edit-actions">
                    <button type="button" class="btn btn--primary" id="save-btn">Save changes</button>
                    <button type="button" class="btn" id="cancel-btn">Cancel</button>
                  </div>
                </div>
```

With:
```typescript
                  <div class="release-page__edit-artwork">
                    <input type="file" id="artwork-file-input" accept="image/*" style="display:none" />
                    <button type="button" class="btn" id="artwork-upload-btn">Replace image</button>
                    <input class="input" type="text" id="edit-artwork-url" value="${escapeHtml(item.artwork_url ?? "")}" placeholder="Artwork URL" />
                  </div>
                  <div class="release-page__edit-actions">
                    <button type="button" class="btn btn--primary" id="save-btn">Save changes</button>
                    <button type="button" class="btn" id="cancel-btn">Cancel</button>
                  </div>
                </div>
```

**Step 3: No test run yet** — the JS wiring in Task 3 is needed first.

---

### Task 3: Wire up client-side JS for upload and save

**Files:**
- Modify: `server/routes/release-page.ts`

**Step 1: Locate the save-btn click handler in the inline `<script>`**

Find this block:
```javascript
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
```

**Step 2: Add `artworkUrl` to the save body**

Change `notes: document.getElementById('edit-notes').value.trim() || null,` to:
```javascript
          notes: document.getElementById('edit-notes').value.trim() || null,
          artworkUrl: document.getElementById('edit-artwork-url').value.trim() || null,
```

**Step 3: Add the upload JS block**

Find the line:
```javascript
      renderStackChips();
      loadStacks();
```

Insert this block immediately **before** it:

```javascript
      // ── Artwork upload ───────────────────────────────────────────────────
      const artworkUploadBtn = document.getElementById('artwork-upload-btn');
      const artworkFileInput = document.getElementById('artwork-file-input');
      const artworkUrlInput = document.getElementById('edit-artwork-url');

      if (artworkUploadBtn && artworkFileInput && artworkUrlInput) {
        artworkUploadBtn.addEventListener('click', () => artworkFileInput.click());

        artworkFileInput.addEventListener('change', async () => {
          const file = artworkFileInput.files?.[0];
          if (!file) return;

          artworkUploadBtn.disabled = true;
          artworkUploadBtn.textContent = 'Uploading…';

          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            const base64 = dataUrl.split(',')[1];
            const res = await fetch('/api/release/image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ imageBase64: base64 }),
            });
            if (!res.ok) throw new Error('Upload failed: ' + res.status);
            const { artworkUrl } = await res.json();
            artworkUrlInput.value = artworkUrl;
          } catch (err) {
            alert('Failed to upload image.');
            console.error(err);
          } finally {
            artworkUploadBtn.disabled = false;
            artworkUploadBtn.textContent = 'Replace image';
            artworkFileInput.value = '';
          }
        });
      }
```

**Step 4: Run tests**

```bash
cd /workspace && bunx playwright test playwright/replace-image.spec.ts --reporter=line
```

Expected: both tests PASS.

**Step 5: Run the full test suite to check for regressions**

```bash
cd /workspace && bunx playwright test --reporter=line
```

Expected: all tests PASS.

**Step 6: Commit**

```bash
git add playwright/replace-image.spec.ts server/routes/release-page.ts
git commit -m "feat: replace release image via upload or URL in edit mode"
```

---

## Notes

- The upload JS uses `FileReader` directly (no canvas resize) — the server-side `POST /api/release/image` handles validation. If the image is very large the request may be rejected by the `MAX_IMAGE_BASE64_LENGTH` guard (2MB base64 ≈ 1.5MB file). This is acceptable for now.
- `artworkUrl: null` in the PATCH body will clear the artwork. If you type a blank URL and save, the artwork will be removed. This is intentional.
- `isValidArtworkUrl` on the server already accepts `https?://` and `/uploads/` paths, so both upload results and external URLs work without backend changes.

# Star Rating Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show a 1–5 star rating widget on music cards with `listened` or `to-revisit` status; clicking a checked star clears the rating back to null.

**Architecture:** Pure CSS hover/fill state using radio inputs ordered 5→1 in DOM with `flex-direction: row-reverse` for visual left-to-right display. JS delegates `change` (new rating) and `mousedown`+`click` (clear gesture) from the music list container. No backend changes needed — `rating INTEGER` already exists in schema, types, and PATCH endpoint.

**Tech Stack:** TypeScript (`src/app.ts`), CSS (`src/styles/main.css`), Playwright for e2e tests.

---

### Task 1: Write the failing Playwright test

**Files:**
- Create: `playwright/rating.spec.ts`

**Step 1: Write the test**

```typescript
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("star rating appears on listened items and persists", async ({ page }) => {
  await page.goto("/");

  // Add an item manually (no URL needed)
  await page.getByPlaceholder("Paste a music link (optional)...").fill("Test Album");
  await page.getByRole("button", { name: "Add" }).click();
  const card = page.locator(".music-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Rating widget should NOT be visible on to-listen items
  await expect(card.locator(".star-rating")).not.toBeVisible();

  // Change status to listened
  await card.locator(".status-select").selectOption("listened");
  await expect(card.locator(".star-rating")).toBeVisible({ timeout: 5_000 });

  // Click 3 stars
  await card.locator('label[for$="-3"]').click();

  // Re-fetch the page and confirm rating is persisted
  await page.reload();
  await page.locator(".filter-btn[data-filter='listened']").click();
  const reloadedCard = page.locator(".music-card").first();
  await expect(reloadedCard.locator('input[value="3"]')).toBeChecked({ timeout: 5_000 });

  // Click the checked star again to clear the rating
  await reloadedCard.locator('input[value="3"]').click();
  await expect(reloadedCard.locator('input[value="3"]')).not.toBeChecked({ timeout: 5_000 });
});
```

**Step 2: Run test to confirm it fails**

```bash
bunx playwright test playwright/rating.spec.ts --reporter=list
```

Expected: FAIL — `.star-rating` not found.

---

### Task 2: Add CSS for star rating widget

**Files:**
- Modify: `src/styles/main.css` — append after `.btn:disabled` block

**Step 1: Add `.visually-hidden` utility and `.star-rating` styles**

```css
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.star-rating {
  display: flex;
  flex-direction: row-reverse;
  border: none;
  padding: 0;
  margin: 0;
  gap: 1px;
}

.star-rating input[type="radio"] {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
  pointer-events: none;
}

.star-rating label {
  cursor: pointer;
  color: var(--chrome-darker);
  font-size: 14px;
  line-height: 1;
  padding: 0 1px;
}

/* Fill on hover: the hovered star and all stars to its right (lower DOM index = higher value = visually left) */
.star-rating label:hover,
.star-rating label:hover ~ label {
  color: #c8a000;
}

/* When hovering, reset the currently checked fill to avoid double-highlight */
.star-rating:hover input[type="radio"]:checked ~ label {
  color: var(--chrome-darker);
}

/* Fill checked star and all stars with lower value (higher DOM index) */
.star-rating input[type="radio"]:checked ~ label {
  color: #c8a000;
}
```

**Step 2: Verify styles look correct in browser (no automated step)**

No test to run here — visual check only.

---

### Task 3: Add star rating HTML to `renderMusicCard`

**Files:**
- Modify: `src/app.ts` — update `renderMusicCard` method

**Step 1: Add a helper method to generate the star rating HTML**

Add this private method to the `App` class, directly above `renderMusicCard`:

```typescript
private renderStarRating(itemId: number, rating: number | null): string {
  const stars = [5, 4, 3, 2, 1]
    .map(
      (n) => `
        <input type="radio" id="star-${itemId}-${n}" name="rating-${itemId}" value="${n}" ${rating === n ? "checked" : ""}>
        <label for="star-${itemId}-${n}" title="${n} star${n > 1 ? "s" : ""}">★</label>`,
    )
    .join("");
  return `
    <fieldset class="star-rating">
      <legend class="visually-hidden">Rating</legend>
      ${stars}
    </fieldset>`;
}
```

**Step 2: Call it conditionally in `renderMusicCard`**

In `renderMusicCard`, find the `<div class="music-card__meta">` block and add the rating widget after the status select. The rating shows only when `listen_status` is `listened` or `to-revisit`:

```typescript
// Replace this line in renderMusicCard:
<div class="music-card__meta">
  <select class="status-select">${statusOptions}</select>
  ...
</div>

// With:
<div class="music-card__meta">
  <select class="status-select">${statusOptions}</select>
  ${["listened", "to-revisit"].includes(item.listen_status) ? this.renderStarRating(item.id, item.rating) : ""}
  ...
</div>
```

The exact edit in context (find this block in `renderMusicCard`):

```typescript
          <div class="music-card__meta">
            <select class="status-select">${statusOptions}</select>
            ${
              item.primary_source
```

Replace with:

```typescript
          <div class="music-card__meta">
            <select class="status-select">${statusOptions}</select>
            ${["listened", "to-revisit"].includes(item.listen_status) ? this.renderStarRating(item.id, item.rating) : ""}
            ${
              item.primary_source
```

**Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

---

### Task 4: Add JS event delegation for rating changes

**Files:**
- Modify: `src/app.ts` — update `setupEventDelegation` and add `ratingClearCandidate` field

**Step 1: Add a private field to the `App` class**

In the class body (near the other private fields at the top):

```typescript
private ratingClearCandidate: { id: number; value: number } | null = null;
```

**Step 2: Add `mousedown` listener in `setupEventDelegation`**

Inside `setupEventDelegation`, after the existing `list.addEventListener("change", ...)` block, add:

```typescript
list.addEventListener("mousedown", (e) => {
  const input = (e.target as HTMLElement).closest('input[type="radio"]') as HTMLInputElement | null;
  if (!input || !input.name.startsWith("rating-")) return;

  if (input.checked) {
    const card = input.closest("[data-item-id]") as HTMLElement;
    this.ratingClearCandidate = {
      id: Number(card?.dataset.itemId),
      value: Number(input.value),
    };
  } else {
    this.ratingClearCandidate = null;
  }
});

list.addEventListener("click", async (e) => {
  const input = e.target as HTMLInputElement;
  if (input.type !== "radio" || !input.name?.startsWith("rating-")) return;

  if (this.ratingClearCandidate) {
    const card = input.closest("[data-item-id]") as HTMLElement;
    const id = Number(card?.dataset.itemId);
    if (id === this.ratingClearCandidate.id && Number(input.value) === this.ratingClearCandidate.value) {
      this.ratingClearCandidate = null;
      await this.api.updateMusicItem(id, { rating: null });
      await this.renderMusicList();
      return;
    }
  }
  this.ratingClearCandidate = null;
});
```

**Step 3: Add rating handler to the existing `change` listener**

In `setupEventDelegation`, inside the existing `list.addEventListener("change", async (e) => { ... })` block, after the `status-select` handler:

```typescript
// Rating radio
if (target.type === "radio" && target.name?.startsWith("rating-")) {
  const card = target.closest("[data-item-id]") as HTMLElement;
  const id = Number(card?.dataset.itemId);
  const rating = Number(target.value);
  if (id) {
    await this.api.updateMusicItem(id, { rating });
    await this.renderMusicList();
  }
}
```

**Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

**Step 5: Commit**

```bash
git add src/app.ts src/styles/main.css
git commit -m "feat: add 1-5 star rating to listened/to-revisit cards"
```

---

### Task 5: Run the Playwright test and verify it passes

**Step 1: Run the rating spec**

```bash
bunx playwright test playwright/rating.spec.ts --reporter=list
```

Expected: PASS.

**Step 2: Run the full e2e suite to check for regressions**

```bash
bun run test:e2e
```

Expected: all tests pass.

**Step 3: Add the new spec to `test:e2e` in `package.json`**

In `package.json`, find the `"test:e2e"` script and append `playwright/rating.spec.ts` to the list.

**Step 4: Commit**

```bash
git add playwright/rating.spec.ts package.json
git commit -m "test: add e2e test for star rating"
```

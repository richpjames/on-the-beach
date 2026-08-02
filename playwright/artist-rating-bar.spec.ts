import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/parallel-test";

// The minimum-artist-rating bar on the settings page uses the same star control
// as an item's rating, so the gestures have to match: the right half of a star
// sets it whole, the left half sets a half step, and clicking the selected
// value again clears the bar back to "no bar".

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

const STARS = '[aria-label="Minimum artist rating"]';
const VALUE = "[data-min-artist-rating]";

/**
 * Click a star at a chosen point across its width. Playwright's own `.click()`
 * aims at the centre — exactly the half/whole boundary — so sub-pixel layout
 * decides the outcome. Every click here is deliberately off-centre.
 */
async function clickStar(page: Page, value: number, fraction: number): Promise<void> {
  const star = page.locator(STARS).locator(`[data-rating-star="${value}"]`);
  await expect(star).toBeVisible({ timeout: 10_000 });
  const box = await star.boundingBox();
  if (!box) throw new Error(`star ${value} has no bounding box`);

  await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes("/api/settings") && resp.request().method() === "PUT",
    ),
    page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2),
  ]);
}

test("the minimum artist rating bar is set with stars and persists", async ({ page }) => {
  await page.goto("/settings");

  await expect(page.locator(STARS)).toBeVisible({ timeout: 10_000 });
  // Unset by default, so the value reads as off rather than as zero stars.
  await expect(page.locator(VALUE)).toHaveAttribute("data-min-artist-rating", "0");

  await clickStar(page, 4, 0.75);
  await expect(page.locator(VALUE)).toHaveAttribute("data-min-artist-rating", "4");

  await page.reload();
  await expect(page.locator(STARS).locator('[data-rating-star="4"]')).toHaveClass(
    /is-active-full/,
    { timeout: 5_000 },
  );

  // Clicking the selected star again clears the bar back to "any artist".
  await clickStar(page, 4, 0.75);
  await expect(page.locator(VALUE)).toHaveAttribute("data-min-artist-rating", "0");
  await expect(page.locator(STARS).locator('[data-rating-star="4"]')).not.toHaveClass(/is-active/);
});

test("the left half of a star sets a half-step bar", async ({ page }) => {
  await page.goto("/settings");

  await clickStar(page, 3, 0.25);

  await expect(page.locator(VALUE)).toHaveAttribute("data-min-artist-rating", "2.5");
  await expect(page.locator(STARS).locator('[data-rating-star="3"]')).toHaveClass(/is-active-half/);
});

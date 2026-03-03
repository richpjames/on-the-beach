import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("star rating appears on to-listen items and persists", async ({ page }) => {
  await page.goto("/");

  // Add an item manually via the title field (no URL)
  await page.getByRole("button", { name: "Add" }).click(); // reveals artist/album fields
  await page.locator('input[name="title"]').fill("Test Album");
  await page.getByRole("button", { name: "Add" }).click(); // submits
  const card = page.locator(".music-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Rating widget should be visible on to-listen items
  await expect(card.locator(".star-rating")).toBeVisible({ timeout: 5_000 });

  // Click 3 stars
  await card.locator('label[for$="-3"]').click();

  // Re-fetch the page and confirm rating is persisted
  await page.reload();
  const reloadedCard = page.locator(".music-card").first();
  await expect(reloadedCard.locator('input[value="3"]')).toBeChecked({ timeout: 5_000 });

  // Click the checked star's label again to clear the rating
  await reloadedCard.locator('label[for$="-3"]').click();
  await expect(reloadedCard.locator('input[value="3"]')).not.toBeChecked({ timeout: 5_000 });
});

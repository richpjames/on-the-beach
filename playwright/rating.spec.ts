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

  // Rating widget is visible on all items
  await expect(card.locator("[data-rating-stars]")).toBeVisible({
    timeout: 5_000,
  });

  // Click 3 stars and wait for the PATCH to complete before reloading
  await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes("/api/music-items/") && resp.request().method() === "PATCH",
    ),
    card.locator('[data-rating-star="3"]').click(),
  ]);

  // Re-fetch the page and confirm rating is persisted
  await page.reload();
  const reloadedCard = page.locator(".music-card").first();
  await expect(reloadedCard.locator('[data-rating-star="3"]')).toHaveClass(/is-active-full/, {
    timeout: 5_000,
  });

  // Click the checked star again to clear the rating
  await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes("/api/music-items/") && resp.request().method() === "PATCH",
    ),
    reloadedCard.locator('[data-rating-star="3"]').click(),
  ]);
  await expect(reloadedCard.locator('[data-rating-star="3"]')).not.toHaveClass(/is-active/);
});

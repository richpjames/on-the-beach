import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("star rating appears on to-listen items and persists", async ({ page }) => {
  await page.goto("/");

  // Add an item manually via the title field (no URL)
  await page.getByRole("button", { name: "Add" }).click(); // reveals artist/release fields
  await page.locator('input[name="title"]').fill("Test Release");
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

test("half stars preview live while hovering, before any click", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Add" }).click();
  await page.locator('input[name="title"]').fill("Hover Release");
  await page.getByRole("button", { name: "Add" }).click();
  const star = page.locator(".music-card").first().locator('[data-rating-star="4"]');
  await expect(star).toBeVisible({ timeout: 10_000 });

  // Hover the LEFT half of the 4th star: it should paint as a half live, with
  // no click and nothing committed yet.
  const box = await star.boundingBox();
  if (!box) throw new Error("star has no bounding box");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await expect(star).toHaveClass(/is-active-half/);

  // Sweep to the right half of the same star: it fills whole, still no click.
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect(star).toHaveClass(/is-active-full/);

  // Moving the pointer away drops the preview entirely (nothing was committed).
  await page.mouse.move(box.x, box.y - 100);
  await expect(star).not.toHaveClass(/is-active/);
});

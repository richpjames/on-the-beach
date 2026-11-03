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

test("star count is configurable and ratings keep accuracy across scale changes", async ({
  page,
  request,
}) => {
  // A 10-star scale paints ten glyphs.
  const settings = await request.put("/api/settings", {
    data: { ratingStarCount: 10 },
  });
  expect(settings.ok()).toBe(true);

  await page.goto("/");
  await page.getByRole("button", { name: "Add" }).click();
  await page.locator('input[name="title"]').fill("Ten Scale Release");
  await page.getByRole("button", { name: "Add" }).click();
  const card = page.locator(".music-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator("[data-rating-star]")).toHaveCount(10);

  // Nine of ten stars…
  await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes("/api/music-items/") && resp.request().method() === "PATCH",
    ),
    card.locator('[data-rating-star="9"]').click(),
  ]);

  // …is four and a half of five after the scale changes…
  await request.put("/api/settings", { data: { ratingStarCount: 5 } });
  await page.reload();
  const fiveScaleCard = page.locator(".music-card").first();
  await expect(fiveScaleCard.locator("[data-rating-star]")).toHaveCount(5);
  await expect(fiveScaleCard.locator('[data-rating-star="4"]')).toHaveClass(/is-active-full/);
  await expect(fiveScaleCard.locator('[data-rating-star="5"]')).toHaveClass(/is-active-half/);

  // …and exactly nine of ten again when the scale returns — the stored
  // out-of-100 rating lost nothing in the round trip.
  await request.put("/api/settings", { data: { ratingStarCount: 10 } });
  await page.reload();
  const tenScaleCard = page.locator(".music-card").first();
  await expect(tenScaleCard.locator("[data-rating-star]")).toHaveCount(10);
  await expect(tenScaleCard.locator('[data-rating-star="9"]')).toHaveClass(/is-active-full/);
});

test("ratings can be switched off entirely", async ({ page, request }) => {
  const settings = await request.put("/api/settings", {
    data: { ratingEnabled: false },
  });
  expect(settings.ok()).toBe(true);

  await page.goto("/");
  await page.getByRole("button", { name: "Add" }).click();
  await page.locator('input[name="title"]').fill("Unrated Release");
  await page.getByRole("button", { name: "Add" }).click();
  const card = page.locator(".music-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });

  // No stars on the card, and no star-rating sort offered.
  await expect(card.locator("[data-rating-stars]")).toHaveCount(0);
  await expect(page.locator('#browse-sort option[value="star-rating"]')).toHaveCount(0);

  // The release page hides them too.
  await card.locator(".music-card__title").click();
  await expect(page.locator("[data-rating-stars]")).toHaveCount(0);
});

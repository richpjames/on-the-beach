import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("initial form shows link input first, artist and release revealed after clicking Add", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByPlaceholder("Paste a music link...")).toBeVisible();
  await expect(page.locator('input[name="artist"]')).toBeHidden();
  await expect(page.locator('input[name="title"]')).toBeHidden();
  await expect(page.locator('select[name="itemType"]')).toBeHidden();

  await page.getByRole("button", { name: "Add" }).click();

  await expect(page.locator('input[name="artist"]')).toBeVisible();
  await expect(page.locator('input[name="title"]')).toBeVisible();
  await expect(page.locator('select[name="itemType"]')).toBeVisible();
});

test("can manually add a release without link or artwork", async ({ page }) => {
  await page.goto("/");

  const addButton = page.getByRole("button", { name: "Add" });
  await expect(addButton).toBeEnabled();
  await addButton.click(); // reveals artist/release fields
  await addButton.click(); // submits with empty fields

  const card = page.locator(".music-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator(".music-card__title")).toHaveText("Untitled");
  await expect(card.locator('a[title="Open link"]')).toHaveCount(0);
  await expect(card.locator('img[alt="No artwork available"]')).toBeVisible();
});

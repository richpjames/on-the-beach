import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("initial form only shows artist, album, and type until details are expanded", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator('input[name="artist"]')).toBeVisible();
  await expect(page.locator('input[name="title"]')).toBeVisible();
  await expect(page.locator('select[name="itemType"]')).toBeVisible();
  await expect(page.getByPlaceholder("Paste a music link...")).toBeHidden();

  await page.locator(".add-form__details summary").click();
  await expect(page.getByPlaceholder("Paste a music link...")).toBeVisible();
});

test("can manually add a release without link or artwork", async ({ page }) => {
  await page.goto("/");

  const addButton = page.getByRole("button", { name: "Add" });
  await expect(addButton).toBeEnabled();
  await addButton.click();

  const card = page.locator(".music-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator(".music-card__title")).toHaveText("Untitled");
  await expect(card.locator('a[title="Open link"]')).toHaveCount(0);
  await expect(card.locator('img[alt="No artwork available"]')).toBeVisible();
});

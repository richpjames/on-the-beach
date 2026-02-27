import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("adding a link shows the new item", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("Paste a music link...")).toBeVisible();
  page.on("dialog", async (dialog) => {
    await dialog.accept();
  });

  const bandcampUrl =
    "https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue";
  const cardCountBefore = await page.locator(".music-card").count();

  await page.getByPlaceholder("Paste a music link...").fill(bandcampUrl);
  await page.getByRole("button", { name: "Add" }).click();

  const addedCard = page
    .locator(".music-card", {
      has: page.locator(`a[title="Open link"][href="${bandcampUrl}"]`),
    })
    .first();

  await expect(addedCard).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".music-card")).toHaveCount(cardCountBefore + 1);
});

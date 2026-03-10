import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("youtube link shows source badge and embed on release page", async ({ page }) => {
  const youtubeUrl = "https://www.youtube.com/watch?v=iS7-iBia7GE";

  await page.goto("/");
  await page.getByPlaceholder("Paste a music link...").fill(youtubeUrl);
  await page.getByRole("button", { name: "Add" }).click();

  const card = page
    .locator(".music-card", {
      has: page.locator(`a[title="Open link"][href="${youtubeUrl}"]`),
    })
    .first();

  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });
  await expect(card).toBeVisible();

  const sourceBadgeLink = card.locator(`.badge--source[href="${youtubeUrl}"]`);
  await expect(sourceBadgeLink).toHaveText("youtube");

  // Navigate to the release page and verify the embed is present
  await card.locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/);
  await expect(page.locator("iframe.release-page__youtube-embed")).toBeVisible({ timeout: 10_000 });
});

test("mobile m.youtube.com link is normalised and embed shows", async ({ page }) => {
  const mobileUrl = "https://m.youtube.com/watch?v=iS7-iBia7GE";
  const normalizedUrl = "https://www.youtube.com/watch?v=iS7-iBia7GE";

  await page.goto("/");
  await page.getByPlaceholder("Paste a music link...").fill(mobileUrl);
  await page.getByRole("button", { name: "Add" }).click();

  const card = page
    .locator(".music-card", {
      has: page.locator(`a[title="Open link"][href="${normalizedUrl}"]`),
    })
    .first();

  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });
  await expect(card).toBeVisible();
  await expect(card.locator(".badge--source")).toHaveText("youtube");

  await card.locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/);
  await expect(page.locator("iframe.release-page__youtube-embed")).toBeVisible({ timeout: 10_000 });
});

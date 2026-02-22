import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("links with protocol https", async ({ page }) => {
  const bandcampUrl =
    "https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue";

  await page.goto("/");
  await page.getByPlaceholder("Paste a music link (optional)...").fill(bandcampUrl);
  await page.getByRole("button", { name: "Add" }).click();

  const card = page
    .locator(".music-card", {
      has: page.locator(`a[href="${bandcampUrl}"]`),
    })
    .first();

  await expect(card).toBeVisible({ timeout: 10_000 });

  const sourceBadgeLink = card.locator(`.badge--source[href="${bandcampUrl}"]`);
  await expect(sourceBadgeLink).toHaveText("bandcamp");

  const popupPromise = page.waitForEvent("popup");
  await sourceBadgeLink.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(bandcampUrl);
  await popup.close();
});

test("links without https", async ({ page }) => {
  // User pastes URL without https:// prefix - a common copy-paste scenario
  const bandcampUrlNoProtocol = "phewjapan.bandcamp.com/album/paper-masks";
  const expectedNormalizedUrl = "https://phewjapan.bandcamp.com/album/paper-masks";

  await page.goto("/");

  const urlInput = page.getByPlaceholder("Paste a music link (optional)...");
  await urlInput.fill(bandcampUrlNoProtocol);
  await page.getByRole("button", { name: "Add" }).click();

  const card = page.locator(".music-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });

  // The card should show the title from URL parsing
  await expect(card.locator(".music-card__title")).toContainText(/paper masks/i);

  // Should show bandcamp as the source badge
  await expect(card.locator(".badge--source")).toHaveText("bandcamp");

  // The source badge should link to the full URL with protocol
  await expect(card.locator(".badge--source")).toHaveAttribute("href", expectedNormalizedUrl);
});

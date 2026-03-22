import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("links with protocol https", async ({ page }) => {
  const bandcampUrl =
    "https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue";

  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(bandcampUrl);
  await page.getByRole("button", { name: "Add" }).click();

  const card = page
    .locator(".music-card", {
      has: page.locator(`a[title="Open link"][href="${bandcampUrl}"]`),
    })
    .first();

  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });
  await expect(card).toBeVisible();

  const sourceBadgeLink = card.locator(`.badge--source[href="${bandcampUrl}"]`);
  await expect(sourceBadgeLink).toHaveText("Bandcamp");
  await expect(sourceBadgeLink).toHaveAttribute("href", bandcampUrl);
});

test("links without https", async ({ page }) => {
  // User pastes URL without https:// prefix - a common copy-paste scenario
  const bandcampUrlNoProtocol = "phewjapan.bandcamp.com/album/paper-masks";
  const expectedNormalizedUrl = "https://phewjapan.bandcamp.com/album/paper-masks";

  await page.goto("/");

  const urlInput = page.getByPlaceholder("search or paste a link");
  await urlInput.fill(bandcampUrlNoProtocol);
  await page.getByRole("button", { name: "Add" }).click();

  const card = page
    .locator(".music-card", {
      has: page.locator(`a[title="Open link"][href="${expectedNormalizedUrl}"]`),
    })
    .first();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });
  await expect(card).toBeVisible();

  // The card should show the title from URL parsing
  await expect(card.locator(".music-card__title")).toContainText(/paper masks/i);

  // Should show bandcamp as the source badge
  await expect(card.locator(".badge--source")).toHaveText("Bandcamp");

  // The source badge should link to the full URL with protocol
  await expect(card.locator(".badge--source")).toHaveAttribute("href", expectedNormalizedUrl);
});

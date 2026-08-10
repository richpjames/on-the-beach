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

test("a Bandcamp link added by hand is reachable from the release page", async ({ page }) => {
  const bandcampUrl =
    "https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue";

  // A release with no link at all — the case where the added link becomes the
  // primary one, and so is left out of the secondary "🔗" list in view mode.
  await page.goto("/");
  const addButton = page.getByRole("button", { name: "Add" });
  await addButton.click(); // reveals artist/release fields
  await page.locator('input[name="title"]').fill("Hand Linked Release");
  await addButton.click(); // submits

  const card = page.locator(".music-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });

  await page.locator("#edit-btn").click();
  await page.locator("#link-source-input").click();
  await page.locator('#source-dropdown [data-value="Bandcamp"]').click();
  await page.locator("#link-url-input").fill(bandcampUrl);
  await page.locator("#add-link-btn").click();

  // Adding the link scrapes it for the ids the Bandcamp player needs.
  await expect(page.locator("#link-list .release-page__link-row")).toHaveCount(1, {
    timeout: 30_000,
  });
  await page.locator("#cancel-btn").click();

  // Exactly one control in view mode reaches the link: the ▶ Bandcamp button
  // when the scrape found an album id, the plain source link when it didn't
  // (whether it does is left to the route's own test, which doesn't depend on
  // Bandcamp being up). Before, a first Bandcamp link produced neither.
  const actions = page.locator(".release-page__actions");
  await expect(
    actions.locator(`[data-href="${bandcampUrl}"], a[href="${bandcampUrl}"]`),
  ).toHaveCount(1, { timeout: 15_000 });
});

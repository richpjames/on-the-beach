import { expect, test } from "./fixtures/parallel-test";

// On touch devices no "listen here" button renders (the floating player window
// doesn't suit a phone), so the destination it would have used has to surface
// as one of the "there" links instead. It used to be swallowed by the
// here-destination dedupe, leaving a release whose only web presence is its
// playable embed with an empty actions row.
const BANDCAMP_URL =
  "https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("a phone gets the listen destination as a plain link", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });

  // No in-page player on a phone, so no "listen here" button — but the
  // Bandcamp page is still reachable, named plainly.
  await expect(page.locator(".release-page__actions .release-page__listen-btn")).toHaveCount(0, {
    timeout: 10_000,
  });
  const link = page.locator(
    `.release-page__actions .release-page__link-btn[href="${BANDCAMP_URL}"]`,
  );
  await expect(link).toBeVisible({ timeout: 10_000 });
  await expect(link).toContainText("Bandcamp");
});

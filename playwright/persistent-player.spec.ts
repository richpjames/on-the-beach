import { expect, test } from "./fixtures/parallel-test";

const BANDCAMP_URL =
  "https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("player persists when navigating back to the list", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  // Navigate to the release page
  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.locator(".release-page__listen-btn")).toBeVisible({ timeout: 10_000 });

  // Start playback
  await page.locator(".release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();
  await expect(page.locator("#taskbar-np-btn")).toBeVisible();

  // Navigate back to the list
  await page.locator("a[href='/']").first().click();
  await expect(page.locator("#main")).toBeVisible();

  // Player is still visible
  await expect(page.locator("#now-playing-player")).toBeVisible();
  await expect(page.locator("#taskbar-np-btn")).toBeVisible();
});

test("taskbar button toggles player visibility", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.locator(".release-page__listen-btn")).toBeVisible({ timeout: 10_000 });
  await page.locator(".release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  // Minimize via taskbar button
  await page.locator("#taskbar-np-btn").click();
  await expect(page.locator("#now-playing-player")).toBeHidden();

  // Restore via taskbar button
  await page.locator("#taskbar-np-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();
});

test("close button stops playback", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.locator(".release-page__listen-btn")).toBeVisible({ timeout: 10_000 });
  await page.locator(".release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  await page.locator("#player-close").click();
  await expect(page.locator("#now-playing-player")).toBeHidden();
  await expect(page.locator("#taskbar-np-btn")).toBeHidden();
});

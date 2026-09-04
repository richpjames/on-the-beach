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

test("player titlebar links back to the release being played", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });
  const releaseUrl = page.url();
  await expect(page.locator(".release-page__listen-btn")).toBeVisible({ timeout: 10_000 });
  await page.locator(".release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  // Leave the release, then use the titlebar to come back to it.
  await page.locator("a[href='/']").first().click();
  await expect(page.locator("#main")).toBeVisible();

  await page.locator("#player-title-text").click();
  await expect(page).toHaveURL(releaseUrl, { timeout: 10_000 });
  // Playback survives the trip back.
  await expect(page.locator("#now-playing-player")).toBeVisible();
});

test("dragging the player titlebar does not navigate", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.locator(".release-page__listen-btn")).toBeVisible({ timeout: 10_000 });
  await page.locator(".release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  await page.locator("a[href='/']").first().click();
  await expect(page.locator("#main")).toBeVisible();

  // Drag the titlebar sideways — the window moves, and the drag must not be
  // mistaken for a click on the release link.
  const titlebar = page.locator("#player-titlebar");
  const box = (await titlebar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 60, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator("#main")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

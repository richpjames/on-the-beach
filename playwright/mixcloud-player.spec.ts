import { expect, test } from "./fixtures/parallel-test";

// A real show. Unlike Bandcamp and SoundCloud the Mixcloud widget is built
// from the link's own URL — nothing is scraped, nothing can come up empty —
// so the show is playable the moment the link is added.
const MIXCLOUD_URL = "https://www.mixcloud.com/nozwon/light-sleeper-radio-021/";
const WIDGET_SRC = `https://www.mixcloud.com/widget/iframe/?hide_cover=1&feed=${encodeURIComponent(
  "/nozwon/light-sleeper-radio-021/",
)}`;

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("a Mixcloud link plays in the internal player", async ({ page }) => {
  // A release with no link at all, so the hand-added Mixcloud link becomes
  // the primary one.
  await page.goto("/");
  const addButton = page.getByRole("button", { name: "Add" });
  await addButton.click(); // reveals artist/release fields
  await page.locator('input[name="title"]').fill("Hand Linked Mixcloud");
  await addButton.click(); // submits

  const card = page.locator(".music-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });

  await page.locator("#edit-btn").click();
  await page.locator("#link-source-input").click();
  await page.locator('#source-dropdown [data-value="Mixcloud"]').click();
  await page.locator("#link-url-input").fill(MIXCLOUD_URL);
  await page.locator("#add-link-btn").click();
  await expect(page.locator("#link-list .release-page__link-row")).toHaveCount(1, {
    timeout: 30_000,
  });
  await page.locator("#cancel-btn").click();

  // "listen here" carries the widget URL, and the show's own page stays out of
  // the "there" list — the release is already playing here, so nothing else
  // in the actions row should point at it. The fixed inline iframe the page
  // used to render for Mixcloud is gone: the show plays in the player window
  // like every other source.
  const listen = page
    .locator(".release-page__actions")
    .getByRole("button", { name: "Listen on Mixcloud" });
  await expect(listen).toHaveCount(1, { timeout: 15_000 });
  await expect(listen).toHaveAttribute("data-src", WIDGET_SRC);
  await expect(listen).toHaveAttribute("data-href", MIXCLOUD_URL);
  await expect(page.locator(`.release-page__link-btn[href="${MIXCLOUD_URL}"]`)).toHaveCount(0);
  await expect(page.locator(".release-page__mixcloud-embed")).toHaveCount(0);

  // And it loads into the player window like Bandcamp and SoundCloud do.
  await listen.click();
  await expect(page.locator("#now-playing-player")).toBeVisible();
  await expect(page.locator("#player-body iframe")).toHaveAttribute("src", WIDGET_SRC);
});

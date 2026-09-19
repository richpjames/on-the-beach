import { expect, test } from "./fixtures/parallel-test";

// A real track: adding the link scrapes the SoundCloud page for the urn the
// widget needs, the same way a Bandcamp link is scraped for its album id.
const SOUNDCLOUD_URL = "https://soundcloud.com/boardsofcanada/roygbiv";
const WIDGET_SRC =
  "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/1441376377&visual=false&show_artwork=false&hide_related=true&show_comments=false";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("a SoundCloud link plays in the embedded player", async ({ page }) => {
  // A release with no link at all, so the hand-added SoundCloud link becomes
  // the primary one.
  await page.goto("/");
  const addButton = page.getByRole("button", { name: "Add" });
  await addButton.click(); // reveals artist/release fields
  await page.locator('input[name="title"]').fill("Hand Linked SoundCloud");
  await addButton.click(); // submits

  const card = page.locator(".music-card").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });

  await page.locator("#edit-btn").click();
  await page.locator("#link-source-input").click();
  await page.locator('#source-dropdown [data-value="SoundCloud"]').click();
  await page.locator("#link-url-input").fill(SOUNDCLOUD_URL);
  await page.locator("#add-link-btn").click();
  await expect(page.locator("#link-list .release-page__link-row")).toHaveCount(1, {
    timeout: 30_000,
  });
  await page.locator("#cancel-btn").click();

  // The scrape stored the track's urn, so the listen word carries the widget
  // URL and stands in for the plain source link — nothing else in the actions
  // row should point at the SoundCloud page.
  const listen = page.getByRole("button", { name: "Listen on SoundCloud" });
  await expect(listen).toHaveCount(1, { timeout: 15_000 });
  await expect(listen).toHaveAttribute("data-src", WIDGET_SRC);
  await expect(listen).toHaveAttribute("data-href", SOUNDCLOUD_URL);
  await expect(page.locator(`.release-page__link-btn[href="${SOUNDCLOUD_URL}"]`)).toHaveCount(0);

  // And it loads into the player window like Bandcamp does.
  await listen.click();
  await expect(page.locator("#now-playing-player")).toBeVisible();
  await expect(page.locator("#player-body iframe")).toHaveAttribute("src", WIDGET_SRC);
});

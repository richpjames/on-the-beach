import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("mixcloud link uses uploader and title metadata instead of URL slug fallback", async ({
  page,
}) => {
  const mixcloudUrl = "https://www.mixcloud.com/nozwon/light-sleeper-radio-021/";

  // Mock the music-items API so the test is not sensitive to external Mixcloud
  // oEmbed availability. The assertions verify the UI shows metadata
  // (title/artist from oEmbed) rather than the URL slug ("light-sleeper-radio-021"
  // / "nozwon").
  const fakeItem = {
    id: 1,
    title: "New Rap Music January 2026",
    normalized_title: "new rap music january 2026",
    item_type: "mix",
    artist_id: 1,
    artist_name: "Andrew",
    listen_status: "to-listen",
    purchase_intent: "none",
    price_cents: null,
    currency: "GBP",
    notes: null,
    rating: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    listened_at: null,
    artwork_url: null,
    is_physical: 0,
    physical_format: null,
    label: null,
    year: null,
    country: null,
    genre: null,
    catalogue_number: null,
    musicbrainz_release_id: null,
    musicbrainz_artist_id: null,
    primary_url: mixcloudUrl,
    primary_source: "mixcloud",
    primary_link_metadata: null,
    stacks: [],
  };

  await page.route(/\/api\/music-items/, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(fakeItem),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [fakeItem], total: 1 }),
      });
    }
  });

  await page.goto("/");
  await page.getByPlaceholder("search or paste a link").fill(mixcloudUrl);
  await page.getByRole("button", { name: "Add" }).click();

  const card = page
    .locator(".music-card", {
      has: page.locator(`a[href="${mixcloudUrl}"]`),
    })
    .first();

  await expect(card).toBeVisible({ timeout: 20_000 });

  await expect(card.locator(".music-card__title")).toContainText(/new rap music january 2026/i);
  await expect(card.locator(".music-card__artist")).toContainText(/andrew/i);

  await expect(card.locator(".music-card__title")).not.toContainText(/light sleeper radio 021/i);
  await expect(card.locator(".music-card__artist")).not.toContainText(/nozwon/i);
});

import { test, expect } from "./fixtures/parallel-test";

// Following an artist is opt-in, and the release page's Follow button is
// where it happens. This spec walks the whole loop: follow from the record,
// see the artist in the settings panel, unfollow from there.

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("following an artist from the record page opts them into the watch", async ({
  page,
  request,
}) => {
  const seeded = await request.post("/api/__test__/music-items", {
    data: {
      title: "Harbour Line",
      artistName: "Tape Anchor",
    },
  });
  expect(seeded.ok()).toBe(true);
  const { id } = (await seeded.json()) as { id: number };

  await page.goto(`/r/${id}`);
  const follow = page.locator("#follow-artist-btn");

  // Not followed: the button offers to follow.
  await expect(follow).toHaveText("Follow");

  await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes(`/api/artists/`) && resp.request().method() === "PUT",
    ),
    follow.click(),
  ]);

  // Followed: the button sits pressed in and offers to undo.
  await expect(follow).toHaveText("Following ✓");
  await expect(follow).toHaveClass(/release-page__follow-btn--following/);

  // The settings panel lists exactly the followed artists.
  await page.goto("/settings");
  const row = page.locator(".artist-list__row").filter({ hasText: "Tape Anchor" });
  await expect(row).toHaveCount(1);

  // Unfollowing takes the artist back out.
  await row.locator('[data-artist-action="unfollow"]').click();
  await expect(page.locator("#tracked-artists-status")).toContainText("Unfollowed Tape Anchor");
  await expect(row).toHaveCount(0);
});

test("a record without an artist has no follow button", async ({ page, request }) => {
  const seeded = await request.post("/api/__test__/music-items", {
    data: { title: "Nameless Tide" },
  });
  expect(seeded.ok()).toBe(true);
  const { id } = (await seeded.json()) as { id: number };

  await page.goto(`/r/${id}`);

  await expect(page.locator(".release-page")).toBeVisible();
  await expect(page.locator("#follow-artist-btn")).toHaveCount(0);
});

import { expect, test } from "./fixtures/parallel-test";

// Saving edits refreshes the loads in place — no full reload, which would
// stop the player (see persistent-player.spec.ts). The form must still be
// re-seeded from the saved row afterwards: a pasted catalogue URL becomes the
// stored id, and reopening the form shows the row, not what was typed before
// the save.

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("reopening the edit form after a save shows the saved row", async ({ page, request }) => {
  const seeded = await request.post("/api/__test__/music-items", {
    data: { title: "Harbour Line", artistName: "Tape Anchor" },
  });
  expect(seeded.ok()).toBe(true);
  const { id } = (await seeded.json()) as { id: number };

  // The on-view lookup is resolution-on-view.spec's business; keep it out of
  // the way here so the match under test is only the hand-pasted one.
  await page.route(`**/api/release/resolution-lookup/${id}`, (route) =>
    route.fulfill({ json: { skipped: true } }),
  );

  await page.goto(`/r/${id}`);
  await page.locator("#edit-btn").click();
  await page.locator("#edit-discogs").fill("https://www.discogs.com/release/12345");
  await page.locator("#edit-year").fill("1999");
  await page.locator("#save-btn").click();
  await expect(page.locator("#edit-mode")).toBeHidden();

  // Reopen: the form shows the saved row — the canonical id the paste became,
  // not the URL that was typed. Without the post-save re-seed the fields keep
  // their pre-save values and the next save writes them back over the row.
  await page.locator("#edit-btn").click();
  await expect(page.locator("#edit-discogs")).toHaveValue("12345");
  await expect(page.locator("#edit-year")).toHaveValue("1999");

  // An unrelated second save keeps the match: the form carries the stored id,
  // so the comparison against the fresh row sends no match update.
  await page.locator("#edit-label").fill("Harbour Records");
  await page.locator("#save-btn").click();
  await expect(page.locator("#edit-mode")).toBeHidden();
  const line = page.locator(".release-page__resolution");
  await expect(line).toContainText("Matched in Discogs");
  await expect(line.locator("a", { hasText: "Discogs" })).toHaveAttribute(
    "href",
    "https://www.discogs.com/release/12345",
  );
});

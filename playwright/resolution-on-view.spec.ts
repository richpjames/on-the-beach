import { expect, test } from "./fixtures/parallel-test";

// Opening a release asks the catalogues what it is. The resolver itself is
// out of reach under test (OTB_DISABLE_EXTERNAL_LOOKUPS), so the endpoint is
// stood in for — what's under test is that the page fires the lookup on open
// and renders the verdict it lands. The skip rules the server enforces are
// the unit tests' business (resolution-lookup.test.ts).

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("opening an unresolved release looks it up and shows the match", async ({ page, request }) => {
  const seeded = await request.post("/api/__test__/music-items", {
    data: { title: "Harbour Line", artistName: "Tape Anchor" },
  });
  expect(seeded.ok()).toBe(true);
  const { id } = (await seeded.json()) as { id: number };

  // Hold the answer so the pending line is observable, then let the verdict
  // land — the same beat a real catalogue takes to answer.
  let answer!: () => void;
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  let calls = 0;
  await page.route(`**/api/release/resolution-lookup/${id}`, async (route) => {
    calls++;
    await held;
    await route.fulfill({
      json: {
        resolutionStatus: "matched",
        musicbrainzReleaseId: "mb-release-uuid",
        musicbrainzReleaseGroupId: "mb-group-uuid",
        musicbrainzArtistId: "mb-artist-uuid",
        discogsReleaseId: 12345,
        discogsMasterId: 6789,
      },
    });
  });

  await page.goto(`/r/${id}`);
  await expect(page.locator(".release-page__resolution")).toContainText(
    "Looking it up in the catalogues…",
  );

  answer();
  const line = page.locator(".release-page__resolution");
  await expect(line).toContainText("Matched in Discogs and MusicBrainz");
  await expect(line.locator("a", { hasText: "Discogs" })).toHaveAttribute(
    "href",
    "https://www.discogs.com/release/12345",
  );
  await expect(line.locator("a", { hasText: "MusicBrainz" })).toHaveAttribute(
    "href",
    "https://musicbrainz.org/release/mb-release-uuid",
  );
  expect(calls).toBe(1);

  // The edit form's catalogue fields carry the found match too, so saving
  // the form afterwards doesn't write its initial emptiness back over it.
  await page.locator("#edit-btn").click();
  await expect(page.locator("#edit-discogs")).toHaveValue("12345");
  await expect(page.locator("#edit-mb-release")).toHaveValue("mb-release-uuid");
});

test("a release that already carries a match is not asked about", async ({ page, request }) => {
  const created = await request.post("/api/music-items", {
    data: {
      title: "Water Bearer",
      artistName: "Sally Oldfield",
      discogsReleaseId: 54321,
    },
  });
  expect(created.ok()).toBe(true);
  const item = (await created.json()) as { id: number };

  let calls = 0;
  await page.route(`**/api/release/resolution-lookup/${item.id}`, (route) => {
    calls++;
    return route.fulfill({ json: { skipped: true } });
  });

  await page.goto(`/r/${item.id}`);
  // The secondary-link lookup fires from the same mount, so its request is
  // the barrier: by the time it reaches the network, the resolution decision
  // has been made. A settled row must not have asked.
  await page.waitForRequest(`**/api/release/secondary-link-lookup/${item.id}`);
  expect(calls).toBe(0);
  await expect(page.locator(".release-page__resolution")).toHaveCount(0);
});

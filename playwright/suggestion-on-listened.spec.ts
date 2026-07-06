// playwright/suggestion-on-listened.spec.ts
import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("suggestion modal appears when a release is marked listened on the release page", async ({
  page,
  request,
}) => {
  // Create a to-listen release.
  const res = await request.post("/api/music-items", {
    data: { title: "Amber", artistName: "Autechre", listenStatus: "to-listen", year: 1994 },
  });
  const item = await res.json();

  await page.goto(`/r/${item.id}`);
  await expect(page.locator("#status-select")).toBeVisible();

  // Mock the PATCH status update to return a pending suggestion, mirroring what
  // the server returns once a background MusicBrainz lookup has stored one.
  await page.route(`**/api/music-items/${item.id}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        item: { ...item, listen_status: "listened" },
        suggestion: {
          id: 999,
          sourceItemId: item.id,
          title: "Tri Repetae",
          artistName: "Autechre",
          itemType: "album",
          year: 1995,
          musicbrainzReleaseId: null,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      }),
    });
  });

  // Change status to Listened.
  await page.locator("#status-select").selectOption("listened");

  // The suggestion picker modal should surface the suggested release.
  const modal = page.locator("#suggestion-picker-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(modal).toContainText("Tri Repetae");
  await expect(modal).toContainText("Autechre");
});

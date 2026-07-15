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

  // It must overlay the viewport, not sit in document flow below the release
  // (the release-page body class used to override its fixed positioning).
  const position = await modal.evaluate((el) => getComputedStyle(el).position);
  expect(position).toBe("fixed");
});

test("accepting a suggestion adds the release to the to-listen list", async ({ page, request }) => {
  const res = await request.post("/api/music-items", {
    data: { title: "Amber", artistName: "Autechre", listenStatus: "to-listen", year: 1994 },
  });
  const item = await res.json();

  // Stand in for the MusicBrainz prefetch, which is disabled under test.
  await request.post("/api/__test__/suggestions", {
    data: {
      sourceItemId: item.id,
      title: "Tri Repetae",
      artistName: "Autechre",
      itemType: "album",
      year: 1995,
    },
  });

  await page.goto(`/r/${item.id}`);
  await page.locator("#status-select").selectOption("listened");

  const modal = page.locator("#suggestion-picker-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });

  // Accept must POST to the real item id (a live prop read after the modal
  // closed used to send /api/music-items/null/... and create nothing).
  const acceptResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/music-items/${item.id}/suggestion/accept`) &&
      response.request().method() === "POST",
    { timeout: 5_000 },
  );
  await page.locator("#suggestion-picker-accept").click();
  expect((await acceptResponse).status()).toBe(201);

  const list = await (await request.get("/api/music-items?listenStatus=to-listen")).json();
  const items = Array.isArray(list) ? list : list.items;
  const added = items.find((entry: { title: string }) => entry.title === "Tri Repetae");
  expect(added).toBeTruthy();
  expect(added.listen_status).toBe("to-listen");
});

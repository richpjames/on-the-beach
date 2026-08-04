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

// A 1x1 transparent PNG, enough for the browser to treat a request as loaded.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Show the modal for a suggestion carrying the given MusicBrainz ids, by
 * standing in for the PATCH that surfaces one when an item is marked listened.
 */
async function openSuggestionWithIds(
  page: import("@playwright/test").Page,
  item: { id: number },
  ids: { musicbrainzReleaseId: string | null; musicbrainzReleaseGroupId: string | null },
): Promise<void> {
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
          status: "pending",
          createdAt: new Date().toISOString(),
          ...ids,
        },
      }),
    });
  });

  await page.goto(`/r/${item.id}`);
  await expect(page.locator("#status-select")).toBeVisible();
  await page.locator("#status-select").selectOption("listened");
  await expect(page.locator("#suggestion-picker-modal")).toBeVisible({ timeout: 5_000 });
}

test("suggestion artwork comes from the release group, which Cover Art Archive actually has", async ({
  page,
  request,
}) => {
  const res = await request.post("/api/music-items", {
    data: { title: "Amber", artistName: "Autechre", listenStatus: "to-listen", year: 1994 },
  });
  const item = await res.json();

  const requested: string[] = [];
  await page.route("https://coverartarchive.org/**", async (route) => {
    requested.push(route.request().url());
    // Mirror the real thing: the individual pressing has no scan, the group does.
    if (route.request().url().includes("/release-group/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG });
      return;
    }
    await route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" });
  });

  await openSuggestionWithIds(page, item, {
    musicbrainzReleaseId: "release-uuid",
    musicbrainzReleaseGroupId: "release-group-uuid",
  });

  const artwork = page.locator(".suggestion-picker__artwork");
  await expect(artwork).toBeVisible();
  await expect
    .poll(() =>
      requested.some((url) => url.includes("/release-group/release-group-uuid/front-250")),
    )
    .toBe(true);
  // The group answered, so the sparse per-release endpoint is never asked.
  expect(requested.some((url) => url.includes("/release/release-uuid/"))).toBe(false);
});

test("suggestion artwork falls back to the release when the group has none", async ({
  page,
  request,
}) => {
  const res = await request.post("/api/music-items", {
    data: { title: "Amber", artistName: "Autechre", listenStatus: "to-listen", year: 1994 },
  });
  const item = await res.json();

  await page.route("https://coverartarchive.org/**", async (route) => {
    if (route.request().url().includes("/release-group/")) {
      await route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG });
  });

  await openSuggestionWithIds(page, item, {
    musicbrainzReleaseId: "release-uuid",
    musicbrainzReleaseGroupId: "release-group-uuid",
  });

  const artwork = page.locator(".suggestion-picker__artwork");
  await expect(artwork).toHaveAttribute(
    "src",
    "https://coverartarchive.org/release/release-uuid/front-250",
    { timeout: 5_000 },
  );
  await expect
    .poll(() => artwork.evaluate((img: HTMLImageElement) => img.naturalWidth > 0))
    .toBe(true);
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

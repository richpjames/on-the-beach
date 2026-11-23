import { expect, test } from "./fixtures/parallel-test";

const BANDCAMP_URL =
  "https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("player persists when navigating back to the list", async ({ page }) => {
  await page.goto("/?filter=to-listen");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  // Navigate to the release page
  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.locator(".release-page__actions .release-page__listen-btn")).toBeVisible({
    timeout: 10_000,
  });

  // Start playback
  await page.locator(".release-page__actions .release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();
  await expect(page.locator("#taskbar-np-btn")).toBeVisible();

  // Navigate back to the list
  await page.locator(".release-page__nav a").first().click();
  await expect(page.locator("#main")).toBeVisible();

  // Player is still visible
  await expect(page.locator("#now-playing-player")).toBeVisible();
  await expect(page.locator("#taskbar-np-btn")).toBeVisible();
});

test("taskbar button toggles player visibility", async ({ page }) => {
  await page.goto("/?filter=to-listen");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.locator(".release-page__actions .release-page__listen-btn")).toBeVisible({
    timeout: 10_000,
  });
  await page.locator(".release-page__actions .release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  // Minimize via taskbar button
  await page.locator("#taskbar-np-btn").click();
  await expect(page.locator("#now-playing-player")).toBeHidden();

  // Restore via taskbar button
  await page.locator("#taskbar-np-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();
});

test("close button stops playback", async ({ page }) => {
  await page.goto("/?filter=to-listen");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.locator(".release-page__actions .release-page__listen-btn")).toBeVisible({
    timeout: 10_000,
  });
  await page.locator(".release-page__actions .release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  await page.locator("#player-close").click();
  await expect(page.locator("#now-playing-player")).toBeHidden();
  await expect(page.locator("#taskbar-np-btn")).toBeHidden();
});

test("player titlebar links back to the release being played", async ({ page }) => {
  await page.goto("/?filter=to-listen");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });
  // The card link carries ?from= back to the pinned to-listen view, but the
  // player titlebar links to the plain /r/:id — compare the release, not the
  // incidental query string.
  const releasePath = new URL(page.url()).pathname;
  await expect(page.locator(".release-page__actions .release-page__listen-btn")).toBeVisible({
    timeout: 10_000,
  });
  await page.locator(".release-page__actions .release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  // Leave the release, then use the titlebar to come back to it.
  await page.locator(".release-page__nav a").first().click();
  await expect(page.locator("#main")).toBeVisible();

  await page.locator("#player-title-text").click();
  await expect(page).toHaveURL((url) => url.pathname === releasePath, { timeout: 10_000 });
  // Playback survives the trip back.
  await expect(page.locator("#now-playing-player")).toBeVisible();
});

test("saving release edits does not interrupt playback", async ({ page, request }) => {
  // Seed the release directly (the add flow scrapes the live page) and stand
  // in for the Bandcamp widget, so nothing here depends on the live web.
  const seeded = await request.post("/api/__test__/music-items", {
    data: {
      title: "Harbour Line",
      artistName: "Tape Anchor",
      links: [
        {
          sourceName: "bandcamp",
          url: "https://tapetracks.bandcamp.com/album/harbour-line",
          metadata: { album_id: "4213567", item_type: "album" },
        },
      ],
    },
  });
  expect(seeded.ok()).toBe(true);
  const { id } = (await seeded.json()) as { id: number };

  await page.route("**bandcamp.com/EmbeddedPlayer/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><body style="margin:0"><div style="position:absolute;inset:0;background:#b7c9c2"></div></body></html>',
    }),
  );

  await page.goto(`/r/${id}`);
  await page.locator(".release-page__actions .release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  // Tag the live embed so a remount (which would restart the track) is visible.
  await page.evaluate(() => {
    const f = document.querySelector("#player-body iframe");
    if (f) (f as unknown as Record<string, unknown>).__otbTag = "original";
  });

  // The floating window covers the footer's Edit button — minimise first;
  // playback keeps running behind the taskbar button.
  await page.locator("#player-minimize").click();
  await expect(page.locator("#now-playing-player")).toBeHidden();

  await page.locator("#edit-btn").click();
  await page.locator("#edit-year").fill("1999");
  await page.locator("#save-btn").click();
  await expect(page.locator("#edit-mode")).toBeHidden();

  // The save used to reload the whole page, resetting the module-scoped
  // player actor and stopping playback whatever the source. It must refresh
  // the loads in place instead: still playing, same URL, same embed.
  await expect(page.locator("#taskbar-np-btn")).toBeVisible();
  await expect(page).toHaveURL(`/r/${id}`);

  await page.locator("#taskbar-np-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();
  expect(
    await page.evaluate(() => {
      const f = document.querySelector("#player-body iframe") as unknown as Record<string, unknown>;
      return f?.__otbTag === "original";
    }),
  ).toBe(true);

  // And the saved edit shows in view mode without a reload.
  await expect(page.locator(".release-page__meta")).toContainText("1999");
});

test("dragging the player titlebar does not navigate", async ({ page }) => {
  await page.goto("/?filter=to-listen");
  await page.getByPlaceholder("search or paste a link").fill(BANDCAMP_URL);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card")).toHaveCount(1, { timeout: 30_000 });

  await page.locator(".music-card").first().locator("a.music-card__link").click();
  await expect(page).toHaveURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.locator(".release-page__actions .release-page__listen-btn")).toBeVisible({
    timeout: 10_000,
  });
  await page.locator(".release-page__actions .release-page__listen-btn").click();
  await expect(page.locator("#now-playing-player")).toBeVisible();

  await page.locator(".release-page__nav a").first().click();
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

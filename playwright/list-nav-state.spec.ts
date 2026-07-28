import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures/parallel-test";

/**
 * Seed a release directly through the API — no link, so nothing here depends on
 * an external service being reachable.
 */
async function seedRelease(
  request: APIRequestContext,
  title: string,
  artist: string,
): Promise<number> {
  const res = await request.post("/api/music-items", {
    data: { title, artist, itemType: "album" },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).id as number;
}

async function seedStack(
  request: APIRequestContext,
  name: string,
  itemId: number,
): Promise<number> {
  const res = await request.post("/api/stacks", { data: { name } });
  expect(res.ok()).toBe(true);
  const stackId = (await res.json()).id as number;
  const assign = await request.post(`/api/stacks/items/${itemId}`, {
    data: { stackIds: [stackId] },
  });
  expect(assign.ok()).toBe(true);
  return stackId;
}

test.describe("List view state in the URL", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("/api/__test__/reset");
  });

  test("back from a release returns to the stack it was opened from", async ({ page, request }) => {
    const itemId = await seedRelease(request, "Stack Release", "Stack Artist");
    const stackId = await seedStack(request, "Ambient", itemId);

    await page.goto(`/s/${stackId}/ambient`);
    await expect(page.locator(".music-card").first()).toBeVisible();

    await page.locator(".music-card").first().locator("a.music-card__link").click();
    await expect(page).toHaveURL(new RegExp(`/r/${itemId}\\?from=`));

    // The in-app back button lands back on the stack, not the home list.
    await page.locator(".release-page__nav a").click();
    await expect(page).toHaveURL(new RegExp(`/s/${stackId}/ambient$`));
    await expect(page.locator(".stack-tab.active", { hasText: "Ambient" })).toBeVisible();
  });

  test("browser back from a release returns to the stack it was opened from", async ({
    page,
    request,
  }) => {
    const itemId = await seedRelease(request, "Back Release", "Back Artist");
    const stackId = await seedStack(request, "Dub Techno", itemId);

    // Reach the stack the way the app does: shallow-pushed from the home list.
    await page.goto("/");
    await expect(page.locator(".stack-tab", { hasText: "Dub Techno" })).toBeVisible();
    await page.locator(".stack-tab", { hasText: "Dub Techno" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${stackId}/dub-techno$`));

    await page.locator(".music-card").first().locator("a.music-card__link").click();
    await expect(page).toHaveURL(new RegExp(`/r/${itemId}\\?from=`));

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/s/${stackId}/dub-techno$`));
    await expect(page.locator(".stack-tab.active", { hasText: "Dub Techno" })).toBeVisible();
  });

  test("filter and sort choices live in the URL and survive a release visit", async ({
    page,
    request,
  }) => {
    const itemId = await seedRelease(request, "Sorted Release", "Sorted Artist");

    await page.goto("/");
    await page.locator('.filter-btn[data-filter="all"]').click();
    await expect(page).toHaveURL(/\/\?filter=all$/);

    await page.locator("#browse-sort").selectOption("artist-name");
    await expect(page).toHaveURL(/filter=all/);
    await expect(page).toHaveURL(/sort=artist-name/);

    await page.locator(".music-card").first().locator("a.music-card__link").click();
    await expect(page).toHaveURL(new RegExp(`/r/${itemId}\\?from=`));

    await page.locator(".release-page__nav a").click();
    await expect(page).toHaveURL(/filter=all/);
    await expect(page).toHaveURL(/sort=artist-name/);
    await expect(page.locator('.filter-btn[data-filter="all"]')).toHaveClass(/active/);
    await expect(page.locator("#browse-sort")).toHaveValue("artist-name");
  });

  test("a list URL with browsing state renders that view on a cold load", async ({
    page,
    request,
  }) => {
    await seedRelease(request, "Queued Release", "Queued Artist");

    await page.goto("/?filter=listened");
    await expect(page.locator('.filter-btn[data-filter="listened"]')).toHaveClass(/active/);
    // The seeded release is still to-listen, so the listened view is empty.
    await expect(page.locator(".music-card")).toHaveCount(0);
    await expect(page).toHaveURL(/\/\?filter=listened$/);
  });

  test("a tampered back target falls back to the home list", async ({ page, request }) => {
    const itemId = await seedRelease(request, "Tampered Release", "Tampered Artist");

    await page.goto(`/r/${itemId}?from=https://example.com/`);
    await expect(page.locator(".release-page__nav a")).toHaveAttribute("href", "/");
  });
});

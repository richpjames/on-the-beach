import { expect, test } from "./fixtures/parallel-test";

test.describe("Link picker scroll", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("/api/__test__/reset");
    await page.goto("/");
    await expect(page.getByPlaceholder("search or paste a link")).toBeVisible();
  });

  test("modal list scrolls instead of overflowing the viewport when there are many releases", async ({
    page,
  }) => {
    // Mock the API to return many release candidates (ambiguous link)
    const manyCandidates = Array.from({ length: 10 }, (_, i) => ({
      candidateId: `release-${i}`,
      title: `Release Title ${i + 1}`,
      artist: `Artist ${i + 1}`,
      itemType: "album",
      evidence: "product title in 'New Arrivals' section",
    }));

    await page.route(/\/api\/music-items/, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            kind: "ambiguous_link",
            url: "https://example.com/newsletter",
            message: "This link mentions several releases. Pick one or more to add.",
            candidates: manyCandidates,
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.getByPlaceholder("search or paste a link").fill("https://example.com/newsletter");
    await page.getByRole("button", { name: "Add" }).click();

    const dialog = page.locator(".link-picker__dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // The dialog must not overflow the viewport
    const viewportHeight = page.viewportSize()!.height;
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewportHeight);

    // The "Select all" row must have positive height (must not collapse to zero)
    const listHeader = page.locator(".link-picker__list-header");
    const listHeaderBox = await listHeader.boundingBox();
    expect(listHeaderBox).not.toBeNull();
    expect(listHeaderBox!.height).toBeGreaterThan(0);

    // The list must be scrollable (content taller than visible area)
    const listEl = page.locator(".link-picker__list");
    const { scrollHeight, clientHeight } = await listEl.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight);
  });
});

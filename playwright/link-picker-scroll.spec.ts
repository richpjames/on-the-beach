import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/parallel-test";

/** Stub an ambiguous-link response so the picker opens with a scrollable list. */
async function openPickerWithManyCandidates(page: Page): Promise<void> {
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
}

test.describe("Link picker scroll", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("/api/__test__/reset");
    await page.goto("/");
    await expect(page.getByPlaceholder("search or paste a link")).toBeVisible();
  });

  test("modal list scrolls instead of overflowing the viewport when there are many releases", async ({
    page,
  }) => {
    await openPickerWithManyCandidates(page);

    const dialog = page.locator("#link-picker-modal .link-picker__dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // The dialog must not overflow the viewport
    const viewportHeight = page.viewportSize()!.height;
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewportHeight);

    // The "Select all" row must have positive height (must not collapse to zero)
    const listHeader = page.locator("#link-picker-modal .link-picker__list-header");
    const listHeaderBox = await listHeader.boundingBox();
    expect(listHeaderBox).not.toBeNull();
    expect(listHeaderBox!.height).toBeGreaterThan(0);

    // The list must be scrollable (content taller than visible area)
    const listEl = page.locator("#link-picker-modal .link-picker__list");
    const { scrollHeight, clientHeight } = await listEl.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight);
  });

  test("selecting a candidate keeps the list's scroll position", async ({ page }) => {
    await openPickerWithManyCandidates(page);

    const dialog = page.locator("#link-picker-modal .link-picker__dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const listEl = page.locator("#link-picker-modal .link-picker__list");
    const scrolled = await listEl.evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight;
      return el.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);

    // Toggling a candidate reassigns the picker context; the list must not jump.
    const candidate = page.locator("#link-picker-modal .link-picker__candidate").last();
    await candidate.click();
    await expect(candidate).toHaveAttribute("aria-pressed", "true");

    expect(await listEl.evaluate((el) => el.scrollTop)).toBe(scrolled);

    // Deselecting is the same code path.
    await candidate.click();
    await expect(candidate).toHaveAttribute("aria-pressed", "false");

    expect(await listEl.evaluate((el) => el.scrollTop)).toBe(scrolled);
  });
});

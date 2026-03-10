import { expect, test } from "./fixtures/parallel-test";

test.describe("Stack dropdown scroll", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("/api/__test__/reset");
    await page.goto("/");
    await expect(page.getByPlaceholder("Paste a music link...")).toBeVisible();
  });

  test("shows scrollbar when more than 5 stacks exist and new-stack input stays visible", async ({
    page,
    request,
  }) => {
    // Add a music item to get a card
    await page
      .getByPlaceholder("Paste a music link...")
      .fill("https://seekersinternational.bandcamp.com/album/scroll-test");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator(".music-card").first()).toBeVisible({ timeout: 10_000 });

    // Create 8 stacks via API so dropdown definitely needs to scroll
    for (const name of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"]) {
      await request.post("/api/stacks", { data: { name } });
    }

    // Open stack dropdown
    await page
      .locator(".music-card")
      .first()
      .locator('.music-card__action-btn[data-action="stack"]')
      .click();
    await expect(page.locator(".stack-dropdown")).toBeVisible();

    // The list container should be scrollable (overflow-y: auto with max-height)
    const listEl = page.locator(".stack-dropdown__list");
    await expect(listEl).toBeVisible();

    const { scrollHeight, clientHeight } = await listEl.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight);

    // The "New stack..." input must always be visible (not scrolled away)
    await expect(page.locator(".stack-dropdown__new-input")).toBeVisible();

    // Take a screenshot for visual inspection
    await page
      .locator(".stack-dropdown")
      .screenshot({ path: "playwright/screenshots/stack-dropdown-scroll.png" });
  });

  test("stack dropdown scroll works on mobile", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14 Pro

    await page
      .getByPlaceholder("Paste a music link...")
      .fill("https://seekersinternational.bandcamp.com/album/mobile-scroll");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator(".music-card").first()).toBeVisible({ timeout: 10_000 });

    for (const name of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"]) {
      await request.post("/api/stacks", { data: { name } });
    }

    // On mobile the stack button is inside the "..." overflow menu
    await page.locator(".music-card").first().locator(".music-card__menu-toggle").click();
    await page.locator(".music-card__menu-item[data-action='stack-menu']").click();
    await expect(page.locator(".stack-dropdown")).toBeVisible();

    // Verify scrollable on mobile too
    const listEl = page.locator(".stack-dropdown__list");
    const { scrollHeight, clientHeight } = await listEl.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight);
    await expect(page.locator(".stack-dropdown__new-input")).toBeVisible();

    await page
      .locator(".stack-dropdown")
      .screenshot({ path: "playwright/screenshots/stack-dropdown-scroll-mobile.png" });
  });
});

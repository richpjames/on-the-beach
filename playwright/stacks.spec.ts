import { expect, test } from "./fixtures/parallel-test";

test.describe("Stacks", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("/api/__test__/reset");
    await page.goto("/");
    await expect(page.getByPlaceholder("search or paste a link")).toBeVisible();
  });

  test("can create a stack and assign a link to it", async ({ page }) => {
    // Add a link
    await page
      .getByPlaceholder("search or paste a link")
      .fill("https://seekersinternational.bandcamp.com/album/test-stacks");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator(".music-card").first()).toBeVisible({ timeout: 10_000 });

    // Open stack dropdown on the card
    await page
      .locator(".music-card")
      .first()
      .locator('.music-card__action-btn[data-action="stack"]')
      .click();
    await expect(page.locator(".stack-dropdown")).toBeVisible();

    // Create a new stack inline
    await page.locator(".stack-dropdown__new-input").fill("Salsa");
    await page.locator(".stack-dropdown__new-input").press("Enter");

    // Verify stack tab appears
    await expect(page.locator(".stack-tab", { hasText: "Salsa" })).toBeVisible();

    // Close dropdown
    await page.keyboard.press("Escape");

    // Click the Salsa tab
    await page.locator(".stack-tab", { hasText: "Salsa" }).click();

    // Card should still be visible (it's in the Salsa stack)
    await expect(page.locator(".music-card").first()).toBeVisible();
  });

  test("shows stack chips on card after assignment", async ({ page }) => {
    // Add a link
    await page
      .getByPlaceholder("search or paste a link")
      .fill("https://seekersinternational.bandcamp.com/album/chip-test");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator(".music-card").first()).toBeVisible({ timeout: 10_000 });

    // Assign to a new stack via the card dropdown
    await page
      .locator(".music-card")
      .first()
      .locator('.music-card__action-btn[data-action="stack"]')
      .click();
    await expect(page.locator(".stack-dropdown")).toBeVisible();
    await page.locator(".stack-dropdown__new-input").fill("Late Night");
    await page.locator(".stack-dropdown__new-input").press("Enter");
    // Wait for the stack tab to appear before closing — ensures the API calls have completed
    await expect(page.locator(".stack-tab", { hasText: "Late Night" })).toBeVisible();

    // Close dropdown — chips should appear on the card
    await page.keyboard.press("Escape");
    await expect(
      page.locator(".music-card").first().locator(".music-card__stack-chip"),
    ).toBeVisible();
    await expect(
      page.locator(".music-card").first().locator(".music-card__stack-chip"),
    ).toContainText("Late Night");
  });

  test("can rename and delete a stack from the management panel", async ({ page }) => {
    // Add a link and create a stack first
    await page
      .getByPlaceholder("search or paste a link")
      .fill("https://seekersinternational.bandcamp.com/album/manage-test");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator(".music-card").first()).toBeVisible({ timeout: 10_000 });

    // Create stack via card dropdown
    await page
      .locator(".music-card")
      .first()
      .locator('.music-card__action-btn[data-action="stack"]')
      .click();
    await page.locator(".stack-dropdown__new-input").fill("OldName");
    await page.locator(".stack-dropdown__new-input").press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.locator(".stack-tab", { hasText: "OldName" })).toBeVisible();

    // Open management panel
    await page.locator("#manage-stacks-btn").click();
    await expect(page.locator(".stack-manage")).toBeVisible();

    // Rename
    await page.locator(".stack-manage__rename-btn").first().click();
    await page.locator(".stack-manage__rename-input").fill("NewName");
    await page.locator(".stack-manage__rename-confirm").click();
    await expect(page.locator(".stack-tab", { hasText: "NewName" })).toBeVisible();

    // Delete
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator(".stack-manage__delete-btn").first().click();
    await expect(page.locator(".stack-tab", { hasText: "NewName" })).not.toBeVisible();
  });

  test("can delete the currently selected stack from the stack bar", async ({ page }) => {
    await page
      .getByPlaceholder("search or paste a link")
      .fill("https://seekersinternational.bandcamp.com/album/delete-selected-stack");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator(".music-card").first()).toBeVisible({ timeout: 10_000 });

    await page
      .locator(".music-card")
      .first()
      .locator('.music-card__action-btn[data-action="stack"]')
      .click();
    await page.locator(".stack-dropdown__new-input").fill("Throwaway");
    await page.locator(".stack-dropdown__new-input").press("Enter");
    await page.keyboard.press("Escape");

    await page.locator(".stack-tab", { hasText: "Throwaway" }).click();
    await expect(page.locator("#delete-stack-btn")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#delete-stack-btn").click();

    await expect(page.locator(".stack-tab", { hasText: "Throwaway" })).not.toBeVisible();
    await expect(page.locator(".stack-tab[data-stack='all']")).toHaveClass(/active/);
  });

  test("keeps the stack bar to two rows and scrolls on mobile when many stacks exist", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByPlaceholder("search or paste a link")).toBeVisible();

    await page.locator("#manage-stacks-btn").click();
    await expect(page.locator(".stack-manage")).toBeVisible();

    for (let index = 1; index <= 12; index += 1) {
      const stackName = `Long Stack ${index}`;
      await page.locator("#stack-manage-input").fill(stackName);
      await page.locator("#stack-manage-create-btn").click();
      await expect(page.locator(".stack-manage__item", { hasText: stackName })).toBeVisible();
      await expect(page.locator(".stack-tab", { hasText: stackName })).toHaveCount(1);
    }

    await expect(page.locator(".stack-tab", { hasText: "Long Stack 12" })).toHaveCount(1);
    const stackBarMetrics = await page.locator("#stack-bar").evaluate((element) => {
      const tabs = Array.from(element.querySelectorAll(".stack-tab")).filter((tab) => {
        const htmlTab = tab as HTMLElement;
        return !htmlTab.hidden;
      });

      const topPositions = tabs.map((tab) =>
        Math.round((tab as HTMLElement).getBoundingClientRect().top),
      );
      const rowPositions: number[] = [];
      const rowTolerance = 4;

      for (const top of topPositions.sort((left, right) => left - right)) {
        const matchesExistingRow = rowPositions.some(
          (rowTop) => Math.abs(rowTop - top) <= rowTolerance,
        );

        if (!matchesExistingRow) {
          rowPositions.push(top);
        }
      }

      return {
        rowCount: rowPositions.length,
        scrollsHorizontally: element.scrollWidth > element.clientWidth,
      };
    });

    expect(stackBarMetrics.rowCount).toBeLessThanOrEqual(2);
    expect(stackBarMetrics.scrollsHorizontally).toBe(true);
  });
});

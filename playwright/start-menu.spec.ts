import { test, expect } from "./fixtures/parallel-test";

test("start menu opens, runs an action, and closes", async ({ page }) => {
  await page.goto("/");

  const startBtn = page.locator("#taskbar-start");
  const menu = page.locator("#start-menu");

  await expect(menu).toBeHidden();
  await startBtn.click();
  await expect(menu).toBeVisible();
  await expect(startBtn).toHaveAttribute("aria-expanded", "true");
  await expect(menu.locator(".start-menu__item")).toHaveCount(5);

  // "Add a release" focuses the add input and closes the menu
  await menu.locator('[data-start-action="add"]').click();
  await expect(menu).toBeHidden();
  await expect(page.locator("#url-input")).toBeFocused();

  // Escape closes a reopened menu
  await startBtn.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(startBtn).toHaveAttribute("aria-expanded", "false");

  // Outside click closes too
  await startBtn.click();
  await expect(menu).toBeVisible();
  await page.locator("h1").click();
  await expect(menu).toBeHidden();
});

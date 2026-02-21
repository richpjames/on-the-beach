import { test, expect } from "@playwright/test";

test("footer shows semver version", async ({ page }) => {
  await page.goto("/");
  const version = page.locator("#app-version");
  await expect(version).toBeVisible();
  await expect(version).toHaveText(/^v\d+\.\d+\.\d+$/);
});

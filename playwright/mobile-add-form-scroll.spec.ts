import { expect, test } from "./fixtures/parallel-test";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("mobile add form can scroll when manual entry is expanded", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator('input[name="artist"]')).toBeVisible();

  await page.locator(".add-form__details summary").click();
  await expect(page.locator('textarea[name="notes"]')).toBeVisible();

  const beforeScroll = await page.evaluate(() => ({
    overflowY: window.getComputedStyle(document.body).overflowY,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));

  expect(beforeScroll.overflowY).toBe("auto");
  expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.innerHeight);

  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });

  await page.waitForFunction(() => window.scrollY > 0);
  await expect(page.locator(".footer")).toBeInViewport();
});

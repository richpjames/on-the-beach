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
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: window.innerHeight,
    mainScrollbarCount: document.querySelectorAll("#main-scrollbar").length,
  }));

  expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight);
  expect(beforeScroll.mainScrollbarCount).toBe(0);

  await page.evaluate(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  });

  await page.waitForFunction(() => {
    return window.scrollY > 0;
  });

  await expect(page.locator(".list-section")).toBeInViewport();
  await expect(page.locator(".footer")).toBeInViewport();
});

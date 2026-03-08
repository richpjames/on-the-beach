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

  const mainScroll = page.locator("#main-scroll");

  const beforeScroll = await page.evaluate(() => ({
    overflowY: window.getComputedStyle(document.getElementById("main-scroll")!).overflowY,
    scrollHeight: document.getElementById("main-scroll")!.scrollHeight,
    clientHeight: document.getElementById("main-scroll")!.clientHeight,
  }));

  expect(beforeScroll.overflowY).toBe("auto");
  expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight);

  await page.evaluate(() => {
    const scroll = document.getElementById("main-scroll");
    if (scroll) {
      scroll.scrollTo({ top: scroll.scrollHeight, behavior: "auto" });
    }
  });

  await page.waitForFunction(() => {
    const scroll = document.getElementById("main-scroll");
    return scroll ? scroll.scrollTop > 0 : false;
  });

  await expect(mainScroll).toBeVisible();
  await expect(page.locator(".list-section")).toBeInViewport();
  await expect(page.locator(".footer")).toBeInViewport();
});

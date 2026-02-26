import path from "node:path";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  await request.post("/api/__test__/reset");
  await page.goto("/");
  await expect(page.getByPlaceholder("Paste a music link...")).toBeVisible();
});

test("scan prefill opens details and fills artist/title", async ({ page }) => {
  await page.route("**/api/release/image", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        artworkUrl: "/uploads/mock-cover.jpg",
      }),
    });
  });

  await page.route("**/api/release/scan", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        artist: "Boards of Canada",
        title: "Music Has the Right to Children",
      }),
    });
  });

  const fixturePath = path.join(process.cwd(), "playwright/fixtures/cover-sample.png");

  await page.getByRole("button", { name: "Scan album cover" }).click();
  await page.locator("#scan-file-input").setInputFiles(fixturePath);

  await expect(page.locator(".add-form__details")).toHaveAttribute("open", "");
  await expect(page.locator('input[name="artist"]')).toHaveValue("Boards of Canada");
  await expect(page.locator('input[name="title"]')).toHaveValue("Music Has the Right to Children");
  await expect(page.locator('input[name="artworkUrl"]')).toHaveValue("/uploads/mock-cover.jpg");

  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".music-card").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".music-card__artwork").first()).toHaveAttribute(
    "src",
    "/uploads/mock-cover.jpg",
  );
});

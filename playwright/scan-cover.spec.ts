import path from "node:path";
import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ page, request }) => {
  await request.post("/api/__test__/reset");
  await page.goto("/");
});

test("photo button is visible and triggers file input", async ({ page }) => {
  const scanBtn = page.getByRole("button", { name: "Scan release cover" });
  await expect(scanBtn).toBeVisible();
  await expect(scanBtn).toHaveText("Photo");

  const [fileChooser] = await Promise.all([page.waitForEvent("filechooser"), scanBtn.click()]);
  expect(fileChooser).toBeTruthy();
});

test("scan prefill opens details and fills artist/release title", async ({ page }) => {
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

  await page.getByRole("button", { name: "Scan release cover" }).click();
  await page.locator("#scan-file-input").setInputFiles(fixturePath);

  await expect(page.locator(".add-form__details")).toHaveAttribute("open", "");
  await expect(page.locator('input[name="artist"]')).toHaveValue("Boards of Canada");
  await expect(page.locator('input[name="title"]')).toHaveValue("Music Has the Right to Children");
  await expect(page.locator('input[name="artworkUrl"]')).toHaveValue("/uploads/mock-cover.jpg");

  const createRequest = page.waitForResponse((response) => {
    return (
      response.url().includes("/api/music-items") &&
      response.request().method() === "POST" &&
      response.status() === 201
    );
  });
  const refreshRequest = page.waitForResponse((response) => {
    return (
      response.url().includes("/api/music-items") &&
      response.request().method() === "GET" &&
      response.status() === 200
    );
  });

  await page.getByRole("button", { name: "Add" }).click();
  await createRequest;
  await refreshRequest;

  const card = page
    .locator(".music-card", {
      has: page.locator(".music-card__title", {
        hasText: "Music Has the Right to Children",
      }),
    })
    .first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator(".music-card__artwork")).toHaveAttribute(
    "src",
    "/uploads/mock-cover.jpg",
  );
});

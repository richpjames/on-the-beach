// playwright/replace-image.spec.ts
import path from "node:path";
import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("can replace release image via file upload in edit mode", async ({ page, request }) => {
  // Create an item with no artwork
  const res = await request.post("/api/music-items", {
    data: { title: "Replace Image Test", listenStatus: "to-listen" },
  });
  const item = await res.json();

  // Mock the upload endpoint
  await page.route("**/api/release/image", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ artworkUrl: "/uploads/mock-replaced.jpg" }),
    });
  });

  await page.goto(`/r/${item.id}`);

  // Enter edit mode
  await page.getByRole("button", { name: "Edit" }).click();

  // The artwork section should be visible
  await expect(page.locator("#edit-artwork-url")).toBeVisible();

  // Upload a file
  const fixturePath = path.join(process.cwd(), "playwright/fixtures/cover-sample.png");
  await page.getByRole("button", { name: "Replace image" }).click();
  await page.locator("#artwork-file-input").setInputFiles(fixturePath);

  // URL field should be populated with the mock URL
  await expect(page.locator("#edit-artwork-url")).toHaveValue("/uploads/mock-replaced.jpg", {
    timeout: 5_000,
  });

  // Save
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(`/r/${item.id}`);

  // New artwork should be displayed
  await expect(page.locator(".release-page__artwork")).toHaveAttribute(
    "src",
    "/uploads/mock-replaced.jpg",
  );
});

test("can replace release image via URL input in edit mode", async ({ page, request }) => {
  // Create an item
  const res = await request.post("/api/music-items", {
    data: { title: "URL Replace Test", listenStatus: "to-listen" },
  });
  const item = await res.json();

  await page.goto(`/r/${item.id}`);

  // Enter edit mode
  await page.getByRole("button", { name: "Edit" }).click();

  // Clear and type a new URL
  await page.locator("#edit-artwork-url").fill("https://example.com/new-art.jpg");

  // Save
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(`/r/${item.id}`);

  // New artwork should be displayed
  await expect(page.locator(".release-page__artwork")).toHaveAttribute(
    "src",
    "https://example.com/new-art.jpg",
  );
});

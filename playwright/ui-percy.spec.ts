import percySnapshot from "@percy/playwright";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./fixtures/parallel-test";

const PERCY_CSS = `
  body::before,
  body::after {
    display: none !important;
    content: none !important;
  }

  body {
    padding-bottom: 16px !important;
  }

  #app-version {
    visibility: hidden;
  }

  * {
    caret-color: transparent !important;
  }
`;

type ManualItemInput = {
  title: string;
  artist: string;
  label: string;
  year: string;
  genre: string;
  notes: string;
};

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("captures main and release views", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("Paste a music link...")).toBeVisible();

  const scanFixturePath = path.join(process.cwd(), "playwright/fixtures/cover-sample.png");
  const uploadedArtworkUrl = "/uploads/sally-oldfield-water-bearer.png";

  await mockCoverScanRoutes(page, scanFixturePath, uploadedArtworkUrl);
  await addItemViaCoverScan(page, scanFixturePath, uploadedArtworkUrl);

  await addManualItem(page, {
    title: "Night Bus Tape",
    artist: "Slope Unit",
    label: "Shoreline Works",
    year: "2023",
    genre: "Dub Techno",
    notes: "Percy fixture manual item",
  });

  await expect(page.locator(".music-card")).toHaveCount(2);
  await captureSnapshot(page, testInfo, "main-app-view");

  await page
    .locator(".music-card", { hasText: "Water Bearer" })
    .first()
    .locator(".music-card__link")
    .click();
  await page.waitForURL(/\/r\/\d+$/);
  await expect(page.locator(".release-page")).toBeVisible();
  await expect(page.locator("#view-mode")).toBeVisible();

  await captureSnapshot(page, testInfo, "release-page-view");
});

async function captureSnapshot(page: Page, testInfo: TestInfo, viewName: string): Promise<void> {
  const viewport = page.viewportSize();
  const widths = viewport ? [viewport.width] : undefined;
  const minHeight = viewport?.height;

  await percySnapshot(page, `${testInfo.project.name} - ${viewName}`, {
    percyCSS: PERCY_CSS,
    widths,
    minHeight,
  });
}

async function ensureSecondaryVisible(page: Page): Promise<void> {
  const secondary = page.locator(".add-form__secondary");
  if (await secondary.isHidden()) {
    await page.getByRole("button", { name: "Add" }).click();
    await expect(secondary).toBeVisible();
  }
}

async function addManualItem(page: Page, item: ManualItemInput): Promise<void> {
  await ensureSecondaryVisible(page);

  const details = page.locator(".add-form__details");
  const isOpen = await details.evaluate(
    (element) => element instanceof HTMLDetailsElement && element.open,
  );
  if (!isOpen) {
    await details.locator("summary").click();
    await expect(details).toHaveAttribute("open", "");
  }

  const cards = page.locator(".music-card");
  const cardCountBefore = await cards.count();

  await page.locator('input[name="title"]').fill(item.title);
  await page.locator('input[name="artist"]').fill(item.artist);
  await page.locator('input[name="label"]').fill(item.label);
  await page.locator('input[name="year"]').fill(item.year);
  await page.locator('input[name="genre"]').fill(item.genre);
  await page.locator('textarea[name="notes"]').fill(item.notes);

  await page.getByRole("button", { name: "Add" }).click();
  await expect(cards).toHaveCount(cardCountBefore + 1, { timeout: 10_000 });
}

async function mockCoverScanRoutes(
  page: Page,
  fixturePath: string,
  uploadedArtworkUrl: string,
): Promise<void> {
  await page.route("**/api/release/image", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        artworkUrl: uploadedArtworkUrl,
      }),
    });
  });

  await page.route("**/api/release/scan", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        artist: "Sally Oldfield",
        title: "Water Bearer",
      }),
    });
  });

  await page.route(`**${uploadedArtworkUrl}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      path: fixturePath,
    });
  });
}

async function addItemViaCoverScan(
  page: Page,
  fixturePath: string,
  uploadedArtworkUrl: string,
): Promise<void> {
  const cards = page.locator(".music-card");
  const cardCountBefore = await cards.count();

  await ensureSecondaryVisible(page);

  const details = page.locator(".add-form__details");
  const isOpen = await details.evaluate(
    (element) => element instanceof HTMLDetailsElement && element.open,
  );
  if (!isOpen) {
    await details.locator("summary").click();
    await expect(details).toHaveAttribute("open", "");
  }

  await page.getByRole("button", { name: "Scan release cover" }).click();
  await page.locator("#scan-file-input").setInputFiles(fixturePath);

  await expect(page.locator(".add-form__details")).toHaveAttribute("open", "");
  await expect(page.locator('input[name="artist"]')).toHaveValue("Sally Oldfield");
  await expect(page.locator('input[name="title"]')).toHaveValue("Water Bearer");
  await expect(page.locator('input[name="artworkUrl"]')).toHaveValue(uploadedArtworkUrl);

  await page.getByRole("button", { name: "Add" }).click();
  await expect(cards).toHaveCount(cardCountBefore + 1, { timeout: 10_000 });

  const scannedCard = page.locator(".music-card", { hasText: "Water Bearer" }).first();
  await expect(scannedCard).toBeVisible();
  await expect(scannedCard.locator(".music-card__artwork").first()).toHaveAttribute(
    "src",
    uploadedArtworkUrl,
  );
}

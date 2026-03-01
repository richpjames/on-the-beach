import percySnapshot from "@percy/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./fixtures/parallel-test";

const PERCY_CSS = `
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

  await addManualItem(page, {
    title: "Ritual Waves",
    artist: "Sea of Gates",
    label: "Low Tide Audio",
    year: "2024",
    genre: "Ambient",
    notes: "Percy fixture item one",
  });
  await addManualItem(page, {
    title: "Night Bus Tape",
    artist: "Slope Unit",
    label: "Shoreline Works",
    year: "2023",
    genre: "Dub Techno",
    notes: "Percy fixture item two",
  });

  await expect(page.locator(".music-card")).toHaveCount(2);
  await captureSnapshot(page, testInfo, "main-app-view");

  await page.locator(".music-card .music-card__link").first().click();
  await page.waitForURL(/\/r\/\d+$/);
  await expect(page.locator(".release-page")).toBeVisible();
  await expect(page.locator("#view-mode")).toBeVisible();

  await captureSnapshot(page, testInfo, "release-page-view");
});

async function captureSnapshot(page: Page, testInfo: TestInfo, viewName: string): Promise<void> {
  await percySnapshot(page, `${testInfo.project.name} - ${viewName}`, {
    percyCSS: PERCY_CSS,
  });
}

async function addManualItem(page: Page, item: ManualItemInput): Promise<void> {
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

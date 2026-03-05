import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures/parallel-test";

test.describe("Reorder (mouse)", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("/api/__test__/reset");

    for (const title of ["First", "Second", "Third"]) {
      const response = await request.post("/api/music-items", {
        data: {
          title,
          itemType: "album",
        },
      });
      expect(response.ok()).toBe(true);
    }

    await page.goto("/");
    await expect(page.locator(".music-card")).toHaveCount(3);
  });

  test("reorders with mouse drag and persists after reload", async ({ page }) => {
    const initialTitles = await getCardTitles(page);
    const expectedTitles = [initialTitles[1], initialTitles[2], initialTitles[0]];

    await dragFirstCardToBottomWithMouse(page);
    await expect.poll(() => getCardTitles(page)).toEqual(expectedTitles);

    await page.reload();
    await expect(page.locator(".music-card")).toHaveCount(3);
    await expect.poll(() => getCardTitles(page)).toEqual(expectedTitles);
  });
});

test.describe("Reorder (touch)", () => {
  const pixel7 = devices["Pixel 7"];
  test.use({
    viewport: pixel7.viewport,
    userAgent: pixel7.userAgent,
    deviceScaleFactor: pixel7.deviceScaleFactor,
    isMobile: pixel7.isMobile,
    hasTouch: pixel7.hasTouch,
  });

  test.beforeEach(async ({ page, request }) => {
    await request.post("/api/__test__/reset");

    for (const title of ["First", "Second", "Third"]) {
      const response = await request.post("/api/music-items", {
        data: {
          title,
          itemType: "album",
        },
      });
      expect(response.ok()).toBe(true);
    }

    await page.goto("/");
    await expect(page.locator(".music-card")).toHaveCount(3);
  });

  test("reorders with touch drag and persists after reload", async ({ page }) => {
    const initialTitles = await getCardTitles(page);
    const expectedTitles = [initialTitles[1], initialTitles[2], initialTitles[0]];

    await dragFirstCardToBottomWithTouch(page);
    await expect.poll(() => getCardTitles(page)).toEqual(expectedTitles);

    await page.reload();
    await expect(page.locator(".music-card")).toHaveCount(3);
    await expect.poll(() => getCardTitles(page)).toEqual(expectedTitles);
  });
});

async function getCardTitles(page: Page): Promise<string[]> {
  return page.locator(".music-card .music-card__title").allTextContents();
}

async function dragFirstCardToBottomWithMouse(page: Page): Promise<void> {
  await dragFirstCardToBottomWithPointer(page, "mouse", 41);
}

async function dragFirstCardToBottomWithTouch(page: Page): Promise<void> {
  await dragFirstCardToBottomWithPointer(page, "touch", 77);
}

async function dragFirstCardToBottomWithPointer(
  page: Page,
  pointerType: "mouse" | "touch",
  pointerId: number,
): Promise<void> {
  const cards = page.locator(".music-card");
  const sourceHandle = cards.first().locator(".music-card__drag-handle");
  const targetCard = cards.nth(2);

  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetCard.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("Missing drag source or target bounding box");
  }

  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height - 6;

  await sourceHandle.dispatchEvent("pointerdown", {
    pointerId,
    pointerType,
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: startX,
    clientY: startY,
    bubbles: true,
  });
  await page.locator("html").dispatchEvent("pointermove", {
    pointerId,
    pointerType,
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: endX,
    clientY: endY,
    bubbles: true,
  });
  await page.locator("html").dispatchEvent("pointerup", {
    pointerId,
    pointerType,
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: endX,
    clientY: endY,
    bubbles: true,
  });
}

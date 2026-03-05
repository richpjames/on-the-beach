import type { Page } from "@playwright/test";
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

  test("handles the multi-step move sequence and persists after reload", async ({ page }) => {
    const initialTitles = await getCardTitles(page);
    expect(initialTitles).toHaveLength(3);
    const expectedTitles = [initialTitles[1], initialTitles[2], initialTitles[0]];

    // 1) Move one item up.
    await dragCardByIndexWithMouse(page, 2, 1, "before");
    await expect
      .poll(() => getCardTitles(page))
      .toEqual([initialTitles[0], initialTitles[2], initialTitles[1]]);

    // 2) Move the item below it above the one just moved up.
    await dragCardByIndexWithMouse(page, 2, 1, "before");
    await expect.poll(() => getCardTitles(page)).toEqual(initialTitles);

    // 3) Move the one above the two that moved down by 2 positions.
    await dragCardByIndexWithMouse(page, 0, 2, "after");
    await expect.poll(() => getCardTitles(page)).toEqual(expectedTitles);

    await page.reload();
    await expect(page.locator(".music-card")).toHaveCount(3);
    await expect.poll(() => getCardTitles(page)).toEqual(expectedTitles);
  });
});

test.describe("Reorder (touch)", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: true,
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

  test("handles the multi-step move sequence and persists after reload", async ({ page }) => {
    const initialTitles = await getCardTitles(page);
    expect(initialTitles).toHaveLength(3);
    const expectedTitles = [initialTitles[1], initialTitles[2], initialTitles[0]];

    await dragCardByIndexWithTouch(page, 2, 1, "before");
    await expect
      .poll(() => getCardTitles(page))
      .toEqual([initialTitles[0], initialTitles[2], initialTitles[1]]);

    await dragCardByIndexWithTouch(page, 2, 1, "before");
    await expect.poll(() => getCardTitles(page)).toEqual(initialTitles);

    await dragCardByIndexWithTouch(page, 0, 2, "after");
    await expect.poll(() => getCardTitles(page)).toEqual(expectedTitles);

    await page.reload();
    await expect(page.locator(".music-card")).toHaveCount(3);
    await expect.poll(() => getCardTitles(page)).toEqual(expectedTitles);
  });
});

async function getCardTitles(page: Page): Promise<string[]> {
  return page.locator(".music-card .music-card__title").allTextContents();
}

async function dragCardByIndexWithMouse(
  page: Page,
  fromIndex: number,
  toIndex: number,
  position: "before" | "after",
): Promise<void> {
  const cards = page.locator(".music-card");
  const sourceCard = cards.nth(fromIndex);
  const targetCard = cards.nth(toIndex);

  const sourceBox = await sourceCard.boundingBox();
  const targetBox = await targetCard.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("Missing drag source or target bounding box");
  }

  const startX = sourceBox.x + 12;
  const startY = sourceBox.height / 2;
  const targetY = position === "before" ? 4 : Math.max(4, targetBox.height - 4);

  await sourceCard.hover({ position: { x: startX - sourceBox.x, y: startY } });
  await sourceCard.dragTo(targetCard, {
    sourcePosition: { x: startX - sourceBox.x, y: startY },
    targetPosition: { x: 12, y: targetY },
  });
}

async function dragCardByIndexWithTouch(
  page: Page,
  fromIndex: number,
  toIndex: number,
  position: "before" | "after",
): Promise<void> {
  await dragCardByIndexWithMouse(page, fromIndex, toIndex, position);
}

import { test, expect } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("the alert queue triages a release into the library", async ({ page, request }) => {
  await request.post("/api/__test__/release-alerts", {
    data: {
      artistName: "Nera Coast",
      title: "Glass Harbour",
      firstReleaseDate: "2099-09-18",
      reason: "announced",
    },
  });
  await request.post("/api/__test__/release-alerts", {
    data: {
      artistName: "Shore Unit",
      title: "Moon Pool",
      firstReleaseDate: "2026-05-01",
      reason: "new-release",
    },
  });

  // The taskbar carries the pending count until the queue is opened.
  await page.goto("/");
  await expect(page.locator("#taskbar-alerts-count")).toHaveText("2");

  await page.locator("#taskbar-alerts").click();
  await expect(page).toHaveURL(/\/new-releases$/);

  const cards = page.locator(".alert-card");
  await expect(cards).toHaveCount(2);
  await expect(page.getByText("Glass Harbour")).toBeVisible();
  await expect(page.getByText("Announced")).toBeVisible();

  // Adding files the record in the library and takes the card off the queue.
  const announced = cards.filter({ hasText: "Glass Harbour" });
  await announced.locator('[data-alert-action="add"]').click();
  await expect(cards).toHaveCount(1);
  await expect(page.locator("#alerts-status")).toContainText("Added");

  // An announced record is scheduled rather than dropped into To Listen now.
  const scheduled = await request.get("/api/music-items?hasReminder=true");
  const body = await scheduled.json();
  expect(body.items.some((item: { title: string }) => item.title === "Glass Harbour")).toBe(true);

  // Dismissing clears the rest, and the badge goes with them.
  await cards.first().locator('[data-alert-action="dismiss"]').click();
  await expect(page.locator("#alerts-empty")).toBeVisible();

  await page.goto("/");
  await expect(page.locator("#taskbar-alerts")).toHaveCount(0);
});

test("muting an artist from a card clears their whole queue", async ({ page, request }) => {
  for (const title of ["Wire Garden", "Tape Horizon"]) {
    await request.post("/api/__test__/release-alerts", {
      data: { artistName: "Parallel Park", title, firstReleaseDate: "2026-06-01" },
    });
  }

  await page.goto("/new-releases");
  await expect(page.locator(".alert-card")).toHaveCount(2);

  await page.locator('[data-alert-action="mute"]').first().click();

  await expect(page.locator("#alerts-empty")).toBeVisible();
  await expect(page.locator("#alerts-status")).toContainText("Muted Parallel Park");
});

test("alert cards stay usable at mobile width", async ({ page, request }) => {
  await request.post("/api/__test__/release-alerts", {
    data: {
      artistName: "Delta Static",
      title: "Sleep Dealer",
      firstReleaseDate: "2026-05-01",
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/new-releases");

  const card = page.locator(".alert-card").first();
  await expect(card).toBeVisible();

  // Nothing overflows the viewport, and every action is a real touch target.
  const cardBox = await card.boundingBox();
  expect(cardBox!.width).toBeLessThanOrEqual(390);

  for (const action of ["add", "dismiss", "mute"]) {
    const button = card.locator(`[data-alert-action="${action}"]`);
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(28);
  }
});

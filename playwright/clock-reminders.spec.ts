import { test, expect } from "./fixtures/parallel-test";

test("clock popup lists upcoming scheduled reminders", async ({ page, request }) => {
  const created = await request.post("/api/music-items", {
    data: { title: "Reminder Target", artistName: "Clockwork Artist" },
  });
  expect(created.ok()).toBeTruthy();
  const item = await created.json();

  const reminder = await request.put(`/api/music-items/${item.id}/reminder`, {
    data: { remindAt: "2031-01-15T09:00:00Z" },
  });
  expect(reminder.ok()).toBeTruthy();

  await page.goto("/");
  const clock = page.locator("#taskbar-clock");
  const popup = page.locator("#clock-popup");

  await expect(popup).toBeHidden();
  await clock.click();
  await expect(popup).toBeVisible();
  await expect(clock).toHaveAttribute("aria-expanded", "true");

  const row = popup.locator(".clock-popup__item", { hasText: "Reminder Target" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Clockwork Artist");
  await expect(row).toContainText("15 Jan");

  // Row links to the release page
  await expect(row).toHaveAttribute("href", `/r/${item.id}`);

  // Escape closes
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(clock).toHaveAttribute("aria-expanded", "false");
});

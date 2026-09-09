import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures/parallel-test";

async function createItem(
  request: APIRequestContext,
  title: string,
  fields: Record<string, unknown> = {},
  artistName = "Lady Luck",
): Promise<number> {
  const res = await request.post("/api/music-items", {
    data: { title, artistName },
  });
  expect(res.ok()).toBeTruthy();
  const { id } = (await res.json()) as { id: number };

  if (Object.keys(fields).length > 0) {
    const patched = await request.patch(`/api/music-items/${id}`, { data: fields });
    expect(patched.ok()).toBeTruthy();
  }

  return id;
}

test("pick one rolls and lands on a release page", async ({ page, request }) => {
  for (const n of [1, 2, 3]) {
    await createItem(request, `Roll Candidate ${n}`);
  }

  await page.goto("/");
  await page.locator('[data-filter="to-listen"]').click();
  await expect(page.locator(".music-card").first()).toBeVisible();

  await page.locator("#pick-random-btn").click();
  await page.waitForURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.getByText(/Roll Candidate \d/).first()).toBeVisible();
});

test("pick one rolls within the filter that is applied", async ({ page, request }) => {
  for (const n of [1, 2, 3]) {
    await createItem(request, `Still Queued ${n}`);
  }
  await createItem(request, "Heard Already", { listenStatus: "listened" });

  await page.goto("/");
  await page.locator('[data-filter="listened"]').click();
  await expect(page.locator(".music-card")).toHaveCount(1);

  await page.locator("#pick-random-btn").click();
  await page.waitForURL(/\/r\/\d+/, { timeout: 10_000 });
  // The queue holds three releases the roll could have reached had it ignored
  // the filter; only the listened one is in the list the user is looking at.
  await expect(page.getByText("Heard Already").first()).toBeVisible();
});

test("pick one rolls within a rating range and keeps it between rolls", async ({
  page,
  request,
}) => {
  const artist = "Range Roulette";
  await createItem(request, "One Star Wonder", { rating: 1 }, artist);
  await createItem(request, "Five Star Classic", { rating: 5 }, artist);

  // Search the two down out of the seeded queue, so the pool the roll draws
  // from is exactly these two releases.
  await page.goto("/");
  await page.locator("#browse-search").fill(artist);
  await expect(page.locator(".music-card")).toHaveCount(2);

  // Press-and-hold is a right click on the desktop; both open the range menu.
  await page.locator("#pick-random-btn").click({ button: "right" });
  await expect(page.locator("#pick-range-menu")).toBeVisible();
  await page.locator("#pick-range-min").selectOption("4");
  await page.locator("#pick-range-max").selectOption("5");
  await expect(page.locator("#pick-random-btn")).toHaveAttribute("data-pick-range", "4-5");

  await page.locator("#pick-range-roll").click();
  await page.waitForURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.getByText("Five Star Classic").first()).toBeVisible();

  // Back on the list the range is still set, and the next roll still honours it.
  await page.goBack();
  await page.waitForURL(/pick=4-5/, { timeout: 10_000 });
  await expect(page.locator("#pick-random-btn")).toHaveAttribute("data-pick-range", "4-5");
  await expect(page.locator(".music-card")).toHaveCount(2);
  await expect(page.locator("#pick-random-btn")).toContainText("4–5★");

  await page.locator("#pick-random-btn").click();
  await page.waitForURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.getByText("Five Star Classic").first()).toBeVisible();
});

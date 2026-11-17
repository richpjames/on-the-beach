import { test, expect } from "./fixtures/parallel-test";

// The roll picks from every to-listen item in the worker's database, so a
// leftover from an earlier test on this worker could win the roll. Start
// from a clean list, like the other specs do.
test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("pick one rolls and lands on a release page", async ({ page, request }) => {
  for (const n of [1, 2, 3]) {
    const res = await request.post("/api/music-items", {
      data: { title: `Roll Candidate ${n}`, artistName: "Lady Luck" },
    });
    expect(res.ok()).toBeTruthy();
  }

  await page.goto("/");
  await page.locator('[data-filter="to-listen"]').click();
  await expect(page.locator(".music-card").first()).toBeVisible();

  await page.locator("#pick-random-btn").click();
  await page.waitForURL(/\/r\/\d+/, { timeout: 10_000 });
  await expect(page.getByText(/Roll Candidate \d/).first()).toBeVisible();
});

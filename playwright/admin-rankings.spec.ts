import { expect, test } from "./fixtures/parallel-test";

// The admin rankings field must always show the stored rank: a rejected edit
// reverts to the persisted row, and of two quick saves only the newest
// response may settle the row — a slow earlier one is ignored.

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
  const seeded = await request.post("/api/__test__/link-sources", {
    data: { host: "theguardian.com", displayName: "theguardian.com", rank: 5 },
  });
  expect(seeded.ok()).toBe(true);
});

test("a rank that is not a whole number reverts the input", async ({ page }) => {
  await page.goto("/admin");
  const input = page.locator('input[name="rank-theguardian.com"]');
  await expect(input).toHaveValue("5");

  await input.fill("2.5");
  await input.blur();

  await expect(page.locator("#link-sources-status")).toHaveText("Ranks must be whole numbers.");
  await expect(input).toHaveValue("5");
});

test("a failed save reverts the input to the stored rank", async ({ page }) => {
  await page.route("**/api/link-sources", (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({ status: 500, json: { error: "Failed to save." } });
    }
    return route.continue();
  });

  await page.goto("/admin");
  const input = page.locator('input[name="rank-theguardian.com"]');
  await input.fill("9");
  await input.blur();

  await expect(page.locator("#link-sources-status")).toHaveText("Failed to save.");
  await expect(input).toHaveValue("5");
});

test("of two quick saves, only the newest response settles the row", async ({ page }) => {
  let served = 0;
  await page.route("**/api/link-sources", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const { rank } = route.request().postDataJSON() as { rank: number };
    // The first save (rank 7) answers slowly, the second (rank 9) quickly:
    // the responses land out of order, and the stale one must not win.
    await new Promise((resolve) => setTimeout(resolve, rank === 7 ? 800 : 50));
    served += 1;
    return route.fulfill({ json: { host: "theguardian.com", rank } });
  });

  await page.goto("/admin");
  const input = page.locator('input[name="rank-theguardian.com"]');
  await input.fill("7");
  await input.blur();
  await input.fill("9");
  await input.blur();

  // Both responses have landed; the newer rank must still be the one shown.
  await expect.poll(() => served).toBe(2);
  await expect(input).toHaveValue("9");
  await expect(page.locator("#link-sources-status")).toHaveText(
    "Saved. The new ranking applies to the next lookup.",
  );
});

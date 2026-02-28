import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("mixcloud link uses uploader and title metadata instead of URL slug fallback", async ({
  page,
}) => {
  const mixcloudUrl = "https://www.mixcloud.com/nozwon/light-sleeper-radio-021/";

  await page.goto("/");
  await page.getByPlaceholder("Paste a music link...").fill(mixcloudUrl);
  await page.getByRole("button", { name: "Add" }).click();

  const card = page
    .locator(".music-card", {
      has: page.locator(`a[href="${mixcloudUrl}"]`),
    })
    .first();

  await expect(card).toBeVisible({ timeout: 20_000 });

  await expect(card.locator(".music-card__title")).toContainText(/new rap music january 2026/i);
  await expect(card.locator(".music-card__artist")).toContainText(/andrew/i);

  await expect(card.locator(".music-card__title")).not.toContainText(/light sleeper radio 021/i);
  await expect(card.locator(".music-card__artist")).not.toContainText(/nozwon/i);
});

import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

function isListenedItemsRequest(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  return url.pathname === "/api/music-items" && url.searchParams.get("listenStatus") === "listened";
}

test("adding while Listened is selected does not re-render that tab", async ({ page }) => {
  const title = `Issue66-${Date.now()}`;

  await page.goto("/");

  await Promise.all([
    page.waitForResponse(
      (response) => response.request().method() === "GET" && isListenedItemsRequest(response.url()),
    ),
    page.locator('.filter-btn[data-filter="listened"]').click(),
  ]);

  let listenedRequestsAfterAdd = 0;
  const onRequest = (request: { method(): string; url(): string }) => {
    if (request.method() === "GET" && isListenedItemsRequest(request.url())) {
      listenedRequestsAfterAdd += 1;
    }
  };
  page.on("request", onRequest);

  const addButton = page.getByRole("button", { name: "Add" });
  await addButton.click();
  await page.locator('input[name="title"]').fill(title);

  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/music-items",
  );
  await addButton.click();
  await createResponse;
  await page.waitForTimeout(300);

  page.off("request", onRequest);

  expect(listenedRequestsAfterAdd).toBe(0);
  await expect(page.locator(".music-card", { hasText: title })).toHaveCount(0);

  await page.locator('.filter-btn[data-filter="to-listen"]').click();
  await expect(page.locator(".music-card", { hasText: title })).toHaveCount(1);
});

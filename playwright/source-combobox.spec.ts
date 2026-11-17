import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

// The source picker is a combobox: arrows move the highlight, Enter picks,
// Escape closes, and typing narrows the list. Picking by mouse is covered by
// the link specs; this walks the same flow without touching the mouse.
test("the link source picker works from the keyboard", async ({ page, request }) => {
  const res = await request.post("/api/music-items", {
    data: { title: "Keyboard Picker", artistName: "Combo Box" },
  });
  expect(res.ok()).toBeTruthy();
  const item = await res.json();

  await page.goto(`/r/${item.id}`);
  await page.locator("#edit-btn").click();

  const input = page.locator("#link-source-input");
  const dropdown = page.locator("#source-dropdown");
  await input.focus();
  await expect(dropdown).toBeVisible();
  await expect(input).toHaveAttribute("aria-expanded", "true");

  // Arrows move the highlight; Enter picks the highlighted source.
  const thirdName = await dropdown.locator("[role=option]").nth(2).getAttribute("data-value");
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", "source-option-2");
  await input.press("Enter");
  await expect(input).toHaveValue(thirdName!);
  await expect(dropdown).toBeHidden();
  await expect(input).toHaveAttribute("aria-expanded", "false");

  // Typeahead narrows the list to the one match; Escape closes without picking.
  await input.fill("discogs");
  await expect(dropdown).toBeVisible();
  await expect(dropdown.locator("[role=option]")).toHaveCount(1);
  await input.press("Escape");
  await expect(dropdown).toBeHidden();
  await expect(input).toHaveValue("discogs");
});

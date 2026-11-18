import { expect, test } from "./fixtures/parallel-test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

// The source picker is a combobox: arrows move the highlight (and keep it in
// view), Enter picks, Escape closes, typing narrows the list, and a click
// reopens it while focus is retained. Picking by mouse is covered by the link
// specs; this walks the keyboard flow and the reopen click.
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

  // The input keeps focus after a pick or an Escape, so clicking it again
  // must reopen the list — focus alone would never fire a second time.
  await input.click();
  await expect(dropdown).toBeVisible();
  await input.press("Escape");
  await expect(dropdown).toBeHidden();
  await input.click();
  await expect(dropdown).toBeVisible();

  // Arrows walk to the far end of the list; the highlight stays inside the
  // dropdown's visible height instead of scrolling out of sight.
  const optionCount = await dropdown.locator("[role=option]").count();
  for (let i = 0; i < optionCount - 3; i++) await input.press("ArrowDown");
  const highlightInView = await page.evaluate(() => {
    const field = document.getElementById("link-source-input")!;
    const list = document.getElementById("source-dropdown")!;
    const option = document.getElementById(field.getAttribute("aria-activedescendant")!)!;
    const listBox = list.getBoundingClientRect();
    const optionBox = option.getBoundingClientRect();
    return optionBox.top >= listBox.top && optionBox.bottom <= listBox.bottom;
  });
  expect(highlightInView).toBe(true);

  // Typeahead narrows the list to the one match; Escape closes without picking.
  await input.fill("discogs");
  await expect(dropdown).toBeVisible();
  await expect(dropdown.locator("[role=option]")).toHaveCount(1);
  await input.press("Escape");
  await expect(dropdown).toBeHidden();
  await expect(input).toHaveValue("discogs");
});

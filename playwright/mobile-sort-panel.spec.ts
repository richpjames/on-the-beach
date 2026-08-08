import { expect, test } from "./fixtures/parallel-test";

// On mobile the browse controls live in a dock fixed to the bottom of the
// screen, so the sort panel has to open upward. Anchoring it below the row
// (top: 100%) put it under the taskbar — visible only as a sliver of the
// select — and left it over-constrained (top + bottom both set), collapsing
// its height so the select and direction button spilled out of the frame.
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test("mobile sort panel opens fully on screen", async ({ page, request }) => {
  for (const n of [1, 2, 3]) {
    const res = await request.post("/api/music-items", {
      data: { title: `Release ${n}`, artistName: `Artist ${n}` },
    });
    expect(res.ok()).toBeTruthy();
  }

  await page.goto("/");
  await expect(page.locator(".music-card").first()).toBeVisible();

  await page.locator("#browse-sort-toggle").click();

  const panel = page.locator("#browse-sort-panel");
  await expect(panel).toBeInViewport({ ratio: 1 });

  const select = page.locator("#browse-sort");
  const direction = page.locator("#sort-direction-btn");
  await expect(select).toBeInViewport({ ratio: 1 });
  await expect(direction).toBeInViewport({ ratio: 1 });

  // The panel must actually enclose its controls: a collapsed panel still
  // reports its own box as on-screen while its contents overflow it.
  const panelBox = (await panel.boundingBox())!;
  for (const control of [select, direction]) {
    const box = (await control.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(panelBox.y);
    expect(box.y + box.height).toBeLessThanOrEqual(panelBox.y + panelBox.height);
    expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
  }

  // Sitting above the dock, not behind it.
  const dockBox = (await page.locator(".filter-section").boundingBox())!;
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(dockBox.y);

  // Both controls are still usable once shown.
  await select.selectOption("artist-name");
  await expect(page.locator(".music-card__artist").first()).toHaveText("Artist 3");
  await direction.click();
  await expect(page.locator(".music-card__artist").first()).toHaveText("Artist 1");
});

import { expect, test } from "./fixtures/parallel-test";

// The iOS home-screen shortcuts — the Listen widget tile and the app icon's
// long-press quick action — can't press a button in the page, so they open the
// app at `/?action=listen` instead (see docs/ios-native-app.md and
// native/App/OTBLaunchActions.swift). This is the web half of that contract.
//
// The microphone is faked by the chromium project's launch flags (see
// playwright.config.ts) — the recogniser needs a stream, not a real room.

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("?action=listen starts recording on load", async ({ page }) => {
  await page.goto("/?action=listen");

  const listenButton = page.locator("#add-form-recognize-btn");
  await expect(listenButton).toHaveClass(/is-recording/, { timeout: 10_000 });
  // While recording the button counts down instead of reading "Listen".
  await expect(listenButton).toHaveText(/^\d+s$/);
});

test("the action doesn't stick in the address bar", async ({ page }) => {
  // Otherwise a reload — or coming back from a release page — would start
  // recording all over again.
  await page.goto("/?action=listen");

  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
});

test("a plain visit doesn't start recording", async ({ page }) => {
  await page.goto("/");

  const listenButton = page.locator("#add-form-recognize-btn");
  await expect(listenButton).toHaveText("Listen");
  await expect(listenButton).not.toHaveClass(/is-recording/);
});

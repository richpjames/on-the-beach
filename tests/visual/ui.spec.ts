import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../playwright/fixtures/parallel-test";

// CSS injected before each screenshot to produce stable, deterministic renders.
// Mirrors the percyCSS block from the previous Percy setup.
const VISUAL_CSS = `
  body::before,
  body::after {
    display: none !important;
    content: none !important;
  }

  body {
    padding-bottom: 16px !important;
  }

  #app-version {
    visibility: hidden;
  }

  * {
    caret-color: transparent !important;
  }
`;

type ManualItemInput = {
  title: string;
  artist: string;
  label: string;
  year: string;
  genre: string;
  notes: string;
};

const LONG_LIST_FIXTURES = [
  { title: "Waterline Dub", artist: "Current Ritual" },
  { title: "Moon Pool", artist: "Shore Unit" },
  { title: "Glass Harbour", artist: "Nera Coast" },
  { title: "Wire Garden", artist: "Parallel Park" },
  { title: "Sleep Dealer", artist: "Delta Static" },
  { title: "Signal Bloom", artist: "Ana Sequence" },
  { title: "Cloud Relay", artist: "Marble Phase" },
  { title: "Night Ferry", artist: "Kite Array" },
  { title: "Blue Static", artist: "Harbor Tone" },
  { title: "Slow Current", artist: "Ari Loop" },
  { title: "Channel Glass", artist: "North Index" },
  { title: "Tape Horizon", artist: "Soft Relay" },
];

test.beforeEach(async ({ request }) => {
  await request.post("/api/__test__/reset");
});

test("captures main and release views", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("search or paste a link")).toBeVisible();

  const scanFixturePath = path.join(process.cwd(), "playwright/fixtures/cover-sample.png");
  const uploadedArtworkUrl = "/uploads/sally-oldfield-water-bearer.png";

  await mockCoverScanRoutes(page, scanFixturePath, uploadedArtworkUrl);
  await addItemViaCoverScan(page, scanFixturePath, uploadedArtworkUrl);

  await addManualItem(page, {
    title: "Night Bus Tape",
    artist: "Slope Unit",
    label: "Shoreline Works",
    year: "2023",
    genre: "Dub Techno",
    notes: "Visual fixture manual item",
  });

  await expect(page.locator(".music-card")).toHaveCount(2);
  await captureSnapshot(page, "main-app-view");

  await page
    .locator(".music-card", { hasText: "Water Bearer" })
    .first()
    .locator(".music-card__link")
    .click();
  await page.waitForURL(/\/r\/\d+$/);
  await expect(page.locator(".release-page")).toBeVisible();
  await expect(page.locator("#view-mode")).toBeVisible();

  await captureSnapshot(page, "release-page-view");
});

test("captures add loading dialog", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("search or paste a link")).toBeVisible();

  await page.evaluate(() => {
    const overlay = document.getElementById("add-loading-overlay");
    overlay?.classList.add("is-visible");
    overlay?.setAttribute("aria-hidden", "false");
  });

  await expect(page.locator(".add-loading-dialog")).toBeVisible();
  await captureSnapshot(page, "add-loading-dialog");
});

test("captures main long-list view", async ({ page, request }) => {
  await seedLongList(request);

  await page.goto("/");
  await expect(page.locator(".music-card")).toHaveCount(LONG_LIST_FIXTURES.length);
  await expect(page.locator(".music-card__title").first()).toHaveText(
    LONG_LIST_FIXTURES.at(-1)!.title,
  );

  await captureSnapshot(page, "main-app-long-list-view");
});

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

async function captureSnapshot(page: Page, name: string): Promise<void> {
  await page.addStyleTag({ content: VISUAL_CSS });

  // maxDiffPixelRatio: 0.01 — tune this down (e.g. 0.001) for strict
  // pixel-perfect comparisons, or up (e.g. 0.05) if minor font-rendering
  // differences between machines cause false positives.
  await expect(page).toHaveScreenshot(`${name}.png`, {
    maxDiffPixelRatio: 0.01,
  });
}

// ---------------------------------------------------------------------------
// Data helpers (identical to the previous Percy spec)
// ---------------------------------------------------------------------------

async function seedLongList(request: APIRequestContext): Promise<void> {
  for (const item of LONG_LIST_FIXTURES) {
    const response = await request.post("/api/music-items", {
      data: {
        title: item.title,
        artistName: item.artist,
        itemType: "album",
        listenStatus: "to-listen",
      },
    });

    expect(response.ok()).toBe(true);
  }
}

async function ensureSecondaryVisible(page: Page): Promise<void> {
  const secondary = page.locator(".add-form__secondary");
  if (await secondary.isHidden()) {
    await page.getByRole("button", { name: "Add" }).click();
    await expect(secondary).toBeVisible();
  }
}

async function addManualItem(page: Page, item: ManualItemInput): Promise<void> {
  await ensureSecondaryVisible(page);

  const details = page.locator(".add-form__details");
  const isOpen = await details.evaluate(
    (element) => element instanceof HTMLDetailsElement && element.open,
  );
  if (!isOpen) {
    await details.locator("summary").click();
    await expect(details).toHaveAttribute("open", "");
  }

  const cards = page.locator(".music-card");
  const cardCountBefore = await cards.count();

  await page.locator('input[name="title"]').fill(item.title);
  await page.locator('input[name="artist"]').fill(item.artist);
  await page.locator('input[name="label"]').fill(item.label);
  await page.locator('input[name="year"]').fill(item.year);
  await page.locator('input[name="genre"]').fill(item.genre);
  await page.locator('textarea[name="notes"]').fill(item.notes);

  await page.getByRole("button", { name: "Add" }).click();
  await expect(cards).toHaveCount(cardCountBefore + 1, { timeout: 10_000 });
}

async function mockCoverScanRoutes(
  page: Page,
  fixturePath: string,
  uploadedArtworkUrl: string,
): Promise<void> {
  await page.route("**/api/release/lookup", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    const isSallyOldfieldLookup =
      body &&
      typeof body === "object" &&
      body.artist === "Sally Oldfield" &&
      body.title === "Water Bearer";

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        isSallyOldfieldLookup
          ? {
              year: 1978,
              label: "Bronze",
              country: "GB",
              catalogueNumber: "BRON 511",
              musicbrainzReleaseId: "b4ff2378-f836-4d22-be42-35b6bf168784",
              musicbrainzArtistId: "d0b8d24f-a6c6-4428-b7b8-f131561d1a91",
            }
          : {},
      ),
    });
  });

  await page.route("**/api/release/image", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        artworkUrl: uploadedArtworkUrl,
      }),
    });
  });

  await page.route("**/api/release/scan", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        artist: "Sally Oldfield",
        title: "Water Bearer",
      }),
    });
  });

  await page.route(`**${uploadedArtworkUrl}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      path: fixturePath,
    });
  });
}

async function addItemViaCoverScan(
  page: Page,
  fixturePath: string,
  uploadedArtworkUrl: string,
): Promise<void> {
  const cards = page.locator(".music-card");
  const cardCountBefore = await cards.count();

  await ensureSecondaryVisible(page);

  const details = page.locator(".add-form__details");
  const isOpen = await details.evaluate(
    (element) => element instanceof HTMLDetailsElement && element.open,
  );
  if (!isOpen) {
    await details.locator("summary").click();
    await expect(details).toHaveAttribute("open", "");
  }

  await page.getByRole("button", { name: "Scan release cover" }).click();
  await page.locator("#scan-file-input").setInputFiles(fixturePath);

  await expect(page.locator(".add-form__details")).toHaveAttribute("open", "");
  await expect(page.locator('input[name="artist"]')).toHaveValue("Sally Oldfield");
  await expect(page.locator('input[name="title"]')).toHaveValue("Water Bearer");
  await expect(page.locator('input[name="artworkUrl"]')).toHaveValue(uploadedArtworkUrl);

  await page.getByRole("button", { name: "Add" }).click();
  await expect(cards).toHaveCount(cardCountBefore + 1, { timeout: 10_000 });

  const scannedCard = page.locator(".music-card", { hasText: "Water Bearer" }).first();
  await expect(scannedCard).toBeVisible();
  await expect(scannedCard.locator(".music-card__artwork").first()).toHaveAttribute(
    "src",
    uploadedArtworkUrl,
  );
}

import path from "node:path";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
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

  /* "Spotted" is the day the watcher raised the alert — today, on every run.
     Hidden rather than removed so the fact grid keeps its shape. */
  .alert-details__spotted {
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

const ALERT_FIXTURES = [
  {
    artistName: "Shore Unit",
    title: "Moon Pool",
    firstReleaseDate: "2026-05-01",
    reason: "new-release",
    mbReleaseGroupId: "rg-visual-moon-pool",
  },
  {
    artistName: "Nera Coast",
    title: "Glass Harbour",
    firstReleaseDate: "2099-09-18",
    reason: "announced",
    mbReleaseGroupId: "rg-visual-glass-harbour",
  },
];

// What an opened card renders. MusicBrainz is unreachable under test
// (OTB_DISABLE_EXTERNAL_LOOKUPS), and a live lookup would be a different
// record every time it edited anyway — the panel's layout is what's under test.
const ALERT_DETAIL = {
  detail: {
    musicbrainzUrl: "https://musicbrainz.org/release-group/rg-visual-moon-pool",
    artistMusicbrainzUrl: "https://musicbrainz.org/artist/a-visual-shore-unit",
    coverArtUrl: "https://coverartarchive.org/release-group/rg-visual-moon-pool/front-500",
    disambiguation: "first pressing, with the original sleeve",
    artistCredit: "Shore Unit & The Harbour Board",
    firstReleaseDate: "2026-05-01",
    primaryType: "Album",
    secondaryTypes: ["Live"],
    links: [
      {
        url: "https://example.test/a",
        label: "Bandcamp",
        kind: "free streaming",
        listenable: true,
      },
      { url: "https://example.test/b", label: "Apple Music", kind: "streaming", listenable: true },
      { url: "https://example.test/c", label: "Discogs", kind: "discogs", listenable: false },
      { url: "https://example.test/d", label: "Wikidata", kind: "wikidata", listenable: false },
    ],
    tracks: [
      { number: "A1", title: "Slack Water", lengthMs: 245_000 },
      { number: "A2", title: "Spring Tide", lengthMs: 372_000 },
      { number: "B1", title: "Neap", lengthMs: 198_000 },
      {
        number: "B2",
        title: "A Very Long Track Title That Will Certainly Need Truncating Somewhere",
        lengthMs: 611_000,
      },
    ],
    trackCount: 4,
    totalLengthMs: 1_426_000,
    label: "Harbour Tapes",
    country: "GB",
    format: '12" Vinyl',
    releaseTitle: "Moon Pool",
    releaseDate: "2026-05-01",
  },
  error: null,
};

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

test("captures the listen row", async ({ page, request }) => {
  // A release whose first link is a YouTube page, so "listen here" has a
  // playable embed, plus a review and a database for the named ways out.
  // Seeded straight into the database — the real creation path scrapes the
  // pasted page, and a baseline can't depend on the live web.
  const seeded = await request.post("/api/__test__/music-items", {
    data: {
      title: "Harbour Line",
      artistName: "Tape Anchor",
      links: [
        { sourceName: "youtube", url: "https://www.youtube.com/watch?v=otb-harbour-line" },
        {
          sourceName: "pitchfork",
          url: "https://pitchfork.com/reviews/albums/tape-anchor-harbour-line/",
        },
        { sourceName: "discogs", url: "https://www.discogs.com/release/12345-harbour-line" },
      ],
    },
  });
  expect(seeded.ok()).toBe(true);
  const { id } = (await seeded.json()) as { id: number };

  await page.goto(`/r/${id}`);
  const row = page.locator(".release-page__actions");
  await expect(row).toBeVisible();
  await expect(row.getByText("Pitchfork")).toBeVisible();

  // The play button exists only where the internal player does. On the mobile
  // project's coarse pointer it vanishes once the page mounts, so that wait is
  // also the hydration bar before the screenshot — and the destination it
  // would have used leads the "there" links instead.
  const listenButton = row.locator(".release-page__listen-btn");
  if (test.info().project.name === "visual-mobile") {
    await expect(listenButton).toBeHidden();
  } else {
    await expect(listenButton).toBeVisible();
  }

  // A link button keeps its control styling under the pointer. The generic
  // link hover rule is held to element specificity ("a:where(:hover)") so it
  // can't out-rank the class — at plain specificity it won, and on touch,
  // where :hover sticks after a tap, a tapped link stayed washed-out blue
  // with an underline. The pointer moves away afterwards so the baseline
  // captures the resting chrome, not the hover background.
  const firstLink = row.locator(".release-page__link-btn").first();
  await firstLink.hover();
  await expect
    .poll(() =>
      firstLink.evaluate((el) => {
        const cs = getComputedStyle(el);
        return `${cs.color} ${cs.textDecorationLine}`;
      }),
    )
    .toBe("rgb(0, 0, 0) none");
  await page.mouse.move(0, 0);

  await captureSnapshot(row, "release-page-listen-row", page);
});

// ---------------------------------------------------------------------------
// The player window — one baseline per player
// ---------------------------------------------------------------------------

// Every source that plays in the internal player gets its own baseline: the
// window around the embed is ours (size, titlebar, buttons), and each source
// fills its frame differently. The widgets themselves are third parties the
// test machine may or may not reach, so each is stood in for by a flat page
// that fills the frame the same way the real one does — a solid block for
// the players that stretch, and for Mixcloud a 60px bar over the page's own
// gray, so a wrongly-sized window leaves the same void in the baseline it
// would leave on screen.
type PlayerWindowCase = {
  name: string;
  listenLabel: string;
  seedLinks: Array<{ sourceName: string; url: string; metadata?: Record<string, string> }>;
  iframeSrc: RegExp;
  widgetPattern: string;
  standInHtml: string;
};

function solidStandIn(color: string): string {
  return `<!doctype html><html><body style="margin:0"><div style="position:absolute;inset:0;background:${color}"></div></body></html>`;
}

// The bar's 60px is duplicated here from the window CSS
// (.player-window--bar .player-window__body iframe in src/styles/main.css):
// the window crop (overflow: hidden) and the stand-in must move together if
// Mixcloud ever changes its bar height — no baseline can catch the drift.
const MIXCLOUD_BAR_STAND_IN = `<!doctype html><html><body style="margin:0;background:#e8e8e8"><div style="height:60px;background:#323234"></div></body></html>`;

const PLAYER_WINDOW_CASES: PlayerWindowCase[] = [
  {
    name: "youtube",
    listenLabel: "Listen on YouTube",
    seedLinks: [
      { sourceName: "youtube", url: "https://www.youtube.com/watch?v=otb-player-window" },
    ],
    iframeSrc: /youtube-nocookie\.com\/embed\/otb-player-window/,
    widgetPattern: "**youtube-nocookie.com/embed/**",
    standInHtml: solidStandIn("#111111"),
  },
  {
    name: "bandcamp",
    listenLabel: "Listen on Bandcamp",
    seedLinks: [
      {
        sourceName: "bandcamp",
        url: "https://tapetracks.bandcamp.com/album/harbour-line",
        metadata: { album_id: "4213567", item_type: "album" },
      },
    ],
    iframeSrc: /bandcamp\.com\/EmbeddedPlayer\/album=4213567/,
    widgetPattern: "**bandcamp.com/EmbeddedPlayer/**",
    standInHtml: solidStandIn("#b7c9c2"),
  },
  {
    name: "soundcloud",
    listenLabel: "Listen on SoundCloud",
    seedLinks: [
      {
        sourceName: "soundcloud",
        url: "https://soundcloud.com/tape-anchor/harbour-line",
        metadata: { soundcloud_urn: "soundcloud:tracks:1441376377" },
      },
    ],
    iframeSrc: /w\.soundcloud\.com\/player\/.*1441376377/,
    widgetPattern: "**w.soundcloud.com/player/**",
    standInHtml: solidStandIn("#e0762f"),
  },
  {
    name: "mixcloud",
    listenLabel: "Listen on Mixcloud",
    seedLinks: [
      { sourceName: "mixcloud", url: "https://www.mixcloud.com/nozwon/light-sleeper-radio-021/" },
    ],
    iframeSrc: /mixcloud\.com\/widget\/iframe\/.*feed=%2Fnozwon%2Flight-sleeper-radio-021%2F/,
    widgetPattern: "**mixcloud.com/widget/iframe/**",
    standInHtml: MIXCLOUD_BAR_STAND_IN,
  },
  {
    name: "apple-preview",
    listenLabel: "Listen on Apple Music",
    seedLinks: [
      {
        sourceName: "apple_music",
        url: "https://music.apple.com/gb/album/harbour-line/1234567890",
      },
    ],
    iframeSrc: /embed\.music\.apple\.com\/gb\/album\/harbour-line\/1234567890/,
    widgetPattern: "**embed.music.apple.com/**",
    standInHtml: solidStandIn("#f2f0eb"),
  },
];

for (const playerCase of PLAYER_WINDOW_CASES) {
  test(`captures the player window for ${playerCase.name}`, async ({ page, request }) => {
    // The player window never renders on the mobile projects' coarse pointer
    // — there is no listen button to open it.
    test.skip(
      test.info().project.name === "visual-mobile",
      "the player window doesn't suit a phone",
    );

    const seeded = await request.post("/api/__test__/music-items", {
      data: { title: "Harbour Line", artistName: "Tape Anchor", links: playerCase.seedLinks },
    });
    expect(seeded.ok()).toBe(true);
    const { id } = (await seeded.json()) as { id: number };

    await page.route(playerCase.widgetPattern, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: playerCase.standInHtml }),
    );

    await page.goto(`/r/${id}`);
    const listen = page.getByRole("button", { name: playerCase.listenLabel });
    await expect(listen).toBeVisible();
    await listen.click();

    const iframe = page.locator("#player-body iframe");
    await expect(iframe).toHaveAttribute("src", playerCase.iframeSrc);

    // src is set the moment the iframe mounts; the stand-in page paints
    // inside the frame a beat later, and the capture could beat that paint
    // (route interception makes the gap near-instant, so only CI retries
    // masked it). Waiting on the stand-in's own element inside the frame,
    // not the src outside it, closes the race.
    await expect(iframe.contentFrame().locator("div")).toBeVisible();
    await captureSnapshot(
      page.locator("#now-playing-player"),
      `player-window-${playerCase.name}`,
      page,
    );
  });
}

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

test("captures the new releases queue, closed and open", async ({ page, request }) => {
  for (const alert of ALERT_FIXTURES) {
    const response = await request.post("/api/__test__/release-alerts", { data: alert });
    expect(response.ok()).toBe(true);
  }

  // Cover Art Archive is a third party the test machine may or may not reach;
  // serve the same sleeve every time so the baseline is about our layout.
  const coverPath = path.join(process.cwd(), "playwright/fixtures/cover-sample.png");
  await page.route("**coverartarchive.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", path: coverPath }),
  );
  await page.route("**/api/release-alerts/*/details", (route) =>
    route.fulfill({ json: ALERT_DETAIL }),
  );

  await page.goto("/new-releases");
  const cards = page.locator(".alert-card");
  await expect(cards).toHaveCount(ALERT_FIXTURES.length);
  await expect(page.locator(".alert-card__artwork img").first()).toBeVisible();
  await captureSnapshot(page, "new-releases-queue-view");

  // The card the stub describes, so the panel reads as one record.
  const opened = cards.filter({ hasText: ALERT_DETAIL.detail.releaseTitle });
  await opened.locator('[data-alert-action="details"]').click();
  await expect(page.locator(".alert-details__tracks")).toBeVisible();
  await expect(page.locator(".alert-details__cover img")).toBeVisible();

  // The open card, not the page: the panel runs past the bottom of the window
  // on both viewports, and a viewport screenshot would baseline only its top.
  await captureSnapshot(opened, "new-releases-detail-view", page);
});

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

async function captureSnapshot(
  target: Page | Locator,
  name: string,
  // Styles go on the page; pass it when `target` is an element on that page.
  stylePage?: Page,
): Promise<void> {
  await (stylePage ?? (target as Page)).addStyleTag({ content: VISUAL_CSS });

  // maxDiffPixelRatio: 0.01 — tune this down (e.g. 0.001) for strict
  // pixel-perfect comparisons, or up (e.g. 0.05) if minor font-rendering
  // differences between machines cause false positives.
  await expect(target).toHaveScreenshot(`${name}.png`, {
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

  await page.route("**/api/release/apple-music-lookup/*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: null }),
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

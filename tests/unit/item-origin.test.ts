import { afterEach, afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { createMusicItemsFromUrl } from "../../app/music-item-creator";
import { createMusicItemDirect } from "../../app/music-item-store";
import { musicItemRoutes } from "../../server/routes/music-items";
import { seedPreviewData } from "../../server/preview-seed";
import { db } from "../../adapters/db/index";
import { musicItems } from "../../adapters/db/schema";

// Origin is the system-recorded answer to "how did this release enter the
// list". Each entry route stamps its own value and the client's claim is
// overwritten — these tests pin the stamping at the store, the URL creator,
// the web add route, the PATCH boundary, and the preview seed.

// Same setup as music-item-duplicates.test.ts: the Mistral client reads its
// key when this file's imports evaluate, so the env has to be set at module
// scope, and restored afterwards so it doesn't leak into the next test file.
const ENV_BEFORE = {
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  OTB_DISABLE_EXTERNAL_LOOKUPS: process.env.OTB_DISABLE_EXTERNAL_LOOKUPS,
};
process.env.MISTRAL_API_KEY = "test-key";
process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";

afterAll(() => {
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function mockChatCompletionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl_test_1",
      object: "chat.completion",
      created: 1,
      model: "mistral-small-latest",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

/** Serve the page HTML, then the extractor's JSON, to one scrape. */
function mockScrape(html: string, releasesJson: string) {
  const fetchSpy = spyOn(globalThis, "fetch");
  fetchSpy.mockResolvedValueOnce(
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  fetchSpy.mockResolvedValueOnce(mockChatCompletionResponse(releasesJson));
  return fetchSpy;
}

function mixcloudFixtures(artist: string) {
  // The extractor's candidate id: cand-<n>-<slug(artist)>-<slug(title)>, where
  // a slug is lowercased with runs of non-alphanumerics collapsed to one dash.
  const slug = artist
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const html = `
    <html>
      <head><meta property="og:title" content="${artist}"></head>
      <body>
        <h1>${artist}</h1>
        <p>Radio shows, DJ mix sets and podcasts. Listen to every track.</p>
        <div><a href="/${slug}/show-one/">SHOW ONE</a></div>
        <div><a href="/${slug}/show-two/">SHOW TWO</a></div>
      </body>
    </html>
  `;
  const releasesJson =
    '{"releases":[' +
    `{"artist":"${artist}","title":"SHOW ONE","itemType":"mix"},` +
    `{"artist":"${artist}","title":"SHOW TWO","itemType":"mix"}]}`;
  const selection = {
    selectedCandidateIds: [`cand-1-${slug}-show-one`, `cand-2-${slug}-show-two`],
  };
  return { html, releasesJson, selection, url: `https://www.mixcloud.com/${slug}/` };
}

afterEach(() => {
  mock.restore();
});

describe("origin stamping on the creation functions", () => {
  test("a direct create without a stamp lands as 'unknown'", async () => {
    const { item } = await createMusicItemDirect({ title: "Originless" });

    expect(item.origin).toBe("unknown");
  });

  test("an explicit origin passes through", async () => {
    const { item } = await createMusicItemDirect({ title: "Stamped Direct", origin: "alert" });

    expect(item.origin).toBe("alert");
  });

  test("a URL add is a 'link' unless the route says otherwise", async () => {
    const fixture = mixcloudFixtures("Origin Link Duo");
    mockScrape(fixture.html, fixture.releasesJson);

    const results = await createMusicItemsFromUrl(fixture.url, fixture.selection);

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.item.origin).toBe("link");
    }
  });

  test("the email ingest's override stamps 'email' on URL adds", async () => {
    const fixture = mixcloudFixtures("Origin Email Duo");
    mockScrape(fixture.html, fixture.releasesJson);

    const results = await createMusicItemsFromUrl(fixture.url, {
      ...fixture.selection,
      origin: "email",
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.item.origin).toBe("email");
    }
  });
});

describe("origin stamping on the web add route", () => {
  function makeApp(): Hono {
    const app = new Hono();
    app.route("/api/music-items", musicItemRoutes);
    return app;
  }

  test("a hand-typed add is stamped 'manual', whatever the request claims", async () => {
    // The Apple Music backfill runs un-mocked in the background after a
    // successful create — keep fetch stubbed so nothing reaches the network.
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    const response = await makeApp().request("http://localhost/api/music-items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artistName: "Dot Allison", title: "Afternoon", origin: "alert" }),
    });

    expect(response.status).toBe(201);
    const item = (await response.json()) as { origin: string };
    expect(item.origin).toBe("manual");
  });

  test("origin survives an edit that tries to change it", async () => {
    const { item } = await createMusicItemDirect({ title: "Uneditable Origin" });

    const response = await makeApp().request(`http://localhost/api/music-items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "a present", origin: "email" }),
    });

    expect(response.status).toBe(200);
    const updated = (await response.json()) as { item: { origin: string } };
    expect(updated.item.origin).toBe("unknown");
  });
});

describe("origin stamping on the preview seed", () => {
  test("demo items are stamped 'seed'", async () => {
    // The seed refuses to run unless the list is empty, so clear whatever
    // earlier tests left behind — and clear the demo rows after, so the next
    // file's fixtures start from the same empty library.
    await db.delete(musicItems);

    await seedPreviewData();

    const rows = await db.select({ origin: musicItems.origin }).from(musicItems);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.origin === "seed")).toBe(true);

    await db.delete(musicItems);
  });
});

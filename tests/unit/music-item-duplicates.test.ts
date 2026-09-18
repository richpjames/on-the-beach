import { afterEach, afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { createMusicItemsFromUrl } from "../../server/music-item-creator";
import { createMusicItemDirect, DuplicateItemSelectionError } from "../../server/music-item-store";
import { musicItemRoutes } from "../../server/routes/music-items";

// Same setup as creator-release-links.test.ts: the Mistral client reads its
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

const MIXCLOUD_PROFILE_HTML = `
  <html>
    <head><meta property="og:title" content="Comodo Varan"></head>
    <body>
      <h1>Comodo Varan</h1>
      <p>Radio shows, DJ mix sets and podcasts. Listen to every track.</p>
      <div><a href="/comodovaran3/cabo-verde-dansa-drett/">CABO VERDE : DANSA DRETT</a></div>
      <div><a href="/comodovaran3/fidjus-di-badjo/">FIDJUS DI BADJO</a></div>
    </body>
  </html>
`;

const MIXCLOUD_RELEASES_JSON =
  '{"releases":[' +
  '{"artist":"Comodo Varan","title":"CABO VERDE : DANSA DRETT","itemType":"mix"},' +
  '{"artist":"Comodo Varan","title":"FIDJUS DI BADJO","itemType":"mix"}]}';

const MIXCLOUD_SELECTION = {
  selectedCandidateIds: [
    "cand-1-comodo-varan-cabo-verde-dansa-drett",
    "cand-2-comodo-varan-fidjus-di-badjo",
  ],
};

async function addMixcloudShows(): Promise<void> {
  mockScrape(MIXCLOUD_PROFILE_HTML, MIXCLOUD_RELEASES_JSON);
  await createMusicItemsFromUrl("https://www.mixcloud.com/comodovaran3/", MIXCLOUD_SELECTION);
}

afterEach(() => {
  mock.restore();
});

describe("warn-mode duplicate detection", () => {
  test("direct add matching an existing title and artist is rejected", async () => {
    await createMusicItemDirect({ artistName: "Yerai Cortés", title: "La Guitarra Flamenca" });

    let thrown: unknown;
    try {
      await createMusicItemDirect(
        { artistName: "Yerai Cortés", title: "La Guitarra Flamenca" },
        { warnOnDuplicate: true },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DuplicateItemSelectionError);
    const payload = (thrown as DuplicateItemSelectionError).payload;
    expect(payload.kind).toBe("duplicate_item");
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.title).toBe("La Guitarra Flamenca");
  });

  test("case and whitespace differences still match (normalized comparison)", async () => {
    await createMusicItemDirect({ artistName: "Nina Simone", title: "Little Girl Blue" });

    let thrown: unknown;
    try {
      await createMusicItemDirect(
        { artistName: "  nina simone ", title: "little girl blue" },
        { warnOnDuplicate: true },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DuplicateItemSelectionError);
  });

  test("a different artist with the same title is not a duplicate", async () => {
    await createMusicItemDirect({ artistName: "Artist One", title: "Greatest Hits" });

    const { item } = await createMusicItemDirect(
      { artistName: "Artist Two", title: "Greatest Hits" },
      { warnOnDuplicate: true },
    );

    expect(item.title).toBe("Greatest Hits");
  });

  test("a title without an artist never matches", async () => {
    await createMusicItemDirect({ artistName: "Artist One", title: "Greatest Hits" });

    const { item } = await createMusicItemDirect(
      { title: "Greatest Hits" },
      { warnOnDuplicate: true },
    );

    expect(item.title).toBe("Greatest Hits");
  });

  test("a shared MusicBrainz release id matches even with a different title", async () => {
    await createMusicItemDirect({
      artistName: "Artist One",
      title: "Original Title",
      musicbrainzReleaseId: "mb-release-1",
    });

    let thrown: unknown;
    try {
      await createMusicItemDirect(
        {
          artistName: "Artist Two",
          title: "Retitled Reissue",
          musicbrainzReleaseId: "mb-release-1",
        },
        { warnOnDuplicate: true },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DuplicateItemSelectionError);
    expect((thrown as DuplicateItemSelectionError).payload.items[0]!.title).toBe("Original Title");
  });

  test("forceDuplicate inserts past a matching item", async () => {
    await createMusicItemDirect({ artistName: "Yerai Cortés", title: "La Guitarra Flamenca" });

    const { item, created } = await createMusicItemDirect(
      { artistName: "Yerai Cortés", title: "La Guitarra Flamenca" },
      { warnOnDuplicate: true, forceDuplicate: true },
    );

    expect(created).toBe(true);
    expect(item.title).toBe("La Guitarra Flamenca");
  });

  test("without warnOnDuplicate nothing changes — the duplicate is added silently", async () => {
    await createMusicItemDirect({ artistName: "Yerai Cortés", title: "La Guitarra Flamenca" });

    const { created } = await createMusicItemDirect({
      artistName: "Yerai Cortés",
      title: "La Guitarra Flamenca",
    });

    expect(created).toBe(true);
  });
});

describe("warn-mode duplicate detection on URL adds", () => {
  test("re-adding the same link warns instead of silently returning the existing item", async () => {
    await addMixcloudShows();

    mockScrape(MIXCLOUD_PROFILE_HTML, MIXCLOUD_RELEASES_JSON);
    let thrown: unknown;
    try {
      await createMusicItemsFromUrl("https://www.mixcloud.com/comodovaran3/", MIXCLOUD_SELECTION, {
        warnOnDuplicate: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DuplicateItemSelectionError);
    const payload = (thrown as DuplicateItemSelectionError).payload;
    expect(payload.kind).toBe("duplicate_item");
    expect(payload.url).toBe("https://www.mixcloud.com/comodovaran3/");
    expect(payload.items).toHaveLength(2);
  });

  test("a direct add of a release already filed from a link warns (the cross-path case)", async () => {
    await addMixcloudShows();

    let thrown: unknown;
    try {
      await createMusicItemDirect(
        { artistName: "Comodo Varan", title: "FIDJUS DI BADJO" },
        { warnOnDuplicate: true },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DuplicateItemSelectionError);
    expect((thrown as DuplicateItemSelectionError).payload.items).toHaveLength(1);
    expect((thrown as DuplicateItemSelectionError).payload.items[0]!.title).toBe("FIDJUS DI BADJO");
  });

  test("forceDuplicate on a URL re-add inserts a second copy", async () => {
    await addMixcloudShows();

    mockScrape(MIXCLOUD_PROFILE_HTML, MIXCLOUD_RELEASES_JSON);
    const results = await createMusicItemsFromUrl(
      "https://www.mixcloud.com/comodovaran3/",
      MIXCLOUD_SELECTION,
      { warnOnDuplicate: true, forceDuplicate: true },
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.created)).toBe(true);
  });

  test("an unrelated URL add with no match proceeds without warning", async () => {
    await addMixcloudShows();

    const OTHER_PROFILE_HTML = MIXCLOUD_PROFILE_HTML.replace("Comodo Varan", "Other Artist")
      .replace("/comodovaran3/", "/otherartist/")
      .replace("comodovaran3", "otherartist")
      .replace("CABO VERDE : DANSA DRETT", "OTHER SHOW")
      .replace("FIDJUS DI BADJO", "ANOTHER SHOW");
    const OTHER_RELEASES_JSON =
      '{"releases":[' +
      '{"artist":"Other Artist","title":"OTHER SHOW","itemType":"mix"},' +
      '{"artist":"Other Artist","title":"ANOTHER SHOW","itemType":"mix"}]}';
    mockScrape(OTHER_PROFILE_HTML, OTHER_RELEASES_JSON);

    const results = await createMusicItemsFromUrl(
      "https://www.mixcloud.com/otherartist/",
      {
        selectedCandidateIds: [
          "cand-1-other-artist-other-show",
          "cand-2-other-artist-another-show",
        ],
      },
      { warnOnDuplicate: true },
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.created)).toBe(true);
  });

  test("without warnOnDuplicate a URL re-add still dedupes by link, as before", async () => {
    await addMixcloudShows();

    mockScrape(MIXCLOUD_PROFILE_HTML, MIXCLOUD_RELEASES_JSON);
    const results = await createMusicItemsFromUrl(
      "https://www.mixcloud.com/comodovaran3/",
      MIXCLOUD_SELECTION,
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => !result.created)).toBe(true);
  });
});

describe("POST /api/music-items duplicate handling", () => {
  function makeApp(): Hono {
    const app = new Hono();
    app.route("/api/music-items", musicItemRoutes);
    return app;
  }

  function postItem(body: Record<string, unknown>): Promise<Response> {
    // The Apple Music backfill runs un-mocked in the background after a
    // successful create — keep fetch stubbed so nothing reaches the network.
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    return makeApp().request("http://localhost/api/music-items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("answers a warn-mode duplicate with 409 and the existing items", async () => {
    await createMusicItemDirect({ artistName: "Erykah Badu", title: "Baduizm" });

    const response = await postItem({
      artistName: "Erykah Badu",
      title: "Baduizm",
      warnOnDuplicate: true,
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { kind: string; message: string; items: unknown[] };
    expect(body.kind).toBe("duplicate_item");
    expect(body.items).toHaveLength(1);
  });

  test("forceDuplicate creates the second copy", async () => {
    await createMusicItemDirect({
      artistName: "Alice Coltrane",
      title: "Journey in Satchidananda",
    });

    const response = await postItem({
      artistName: "Alice Coltrane",
      title: "Journey in Satchidananda",
      warnOnDuplicate: true,
      forceDuplicate: true,
    });

    expect(response.status).toBe(201);
    const item = (await response.json()) as { title: string };
    expect(item.title).toBe("Journey In Satchidananda");
  });

  test("without warnOnDuplicate the route keeps its old behaviour", async () => {
    await createMusicItemDirect({ artistName: "Sun Ra", title: "Space Is the Place" });

    const response = await postItem({
      artistName: "Sun Ra",
      title: "Space Is the Place",
    });

    expect(response.status).toBe(201);
  });
});

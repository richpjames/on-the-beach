import { describe, test, expect, spyOn, mock, afterEach, afterAll } from "bun:test";
import { createMusicItemsFromUrl } from "../../server/music-item-creator";

// Same setup as creator-page-source-notes.test.ts: the Mistral client reads its
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

afterEach(() => {
  mock.restore();
});

describe("createMusicItemsFromUrl: links for releases picked off a listing page", () => {
  test("links each Mixcloud show to its own page, not to the profile", async () => {
    mockScrape(MIXCLOUD_PROFILE_HTML, MIXCLOUD_RELEASES_JSON);

    const results = await createMusicItemsFromUrl("https://www.mixcloud.com/comodovaran3/", {
      selectedCandidateIds: [
        "cand-1-comodo-varan-cabo-verde-dansa-drett",
        "cand-2-comodo-varan-fidjus-di-badjo",
      ],
    });

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.item.primary_url)).toEqual([
      "https://www.mixcloud.com/comodovaran3/cabo-verde-dansa-drett/",
      "https://www.mixcloud.com/comodovaran3/fidjus-di-badjo/",
    ]);
    // A Mixcloud show is a Mixcloud link, even though the page it was picked
    // off scraped as an unknown source.
    expect(results.map((result) => result.item.primary_source)).toEqual(["mixcloud", "mixcloud"]);
  });

  test("does not add the same shows again when the profile is re-added", async () => {
    const profileUrl = "https://www.mixcloud.com/nozwon/";
    const html = `
      <html>
        <head><meta property="og:title" content="Nozwon"></head>
        <body>
          <h1>Nozwon</h1>
          <p>Radio shows, DJ mix sets and podcasts. Listen to every track.</p>
          <div><a href="/nozwon/light-sleeper-radio-021/">Light Sleeper Radio 021</a></div>
          <div><a href="/nozwon/light-sleeper-radio-022/">Light Sleeper Radio 022</a></div>
        </body>
      </html>
    `;
    const releasesJson =
      '{"releases":[' +
      '{"artist":"Nozwon","title":"Light Sleeper Radio 021","itemType":"mix"},' +
      '{"artist":"Nozwon","title":"Light Sleeper Radio 022","itemType":"mix"}]}';

    mockScrape(html, releasesJson);
    const first = await createMusicItemsFromUrl(profileUrl, {
      selectedCandidateIds: ["cand-1-nozwon-light-sleeper-radio-021"],
    });
    expect(first[0]!.created).toBe(true);

    mock.restore();
    mockScrape(html, releasesJson);
    const second = await createMusicItemsFromUrl(profileUrl, {
      selectedCandidateIds: ["cand-1-nozwon-light-sleeper-radio-021"],
    });

    expect(second[0]!.created).toBe(false);
    expect(second[0]!.item.id).toBe(first[0]!.item.id);
  });

  test("falls back to the page itself for a release it links to no page for", async () => {
    mockScrape(
      `<html><head><meta property="og:title" content="Winter listening 2026"></head>
        <body><h1>Winter listening 2026</h1>
          <p>Our favourite album releases of the season, on vinyl and cassette.</p>
          <a href="/records/lange-schatten">Weite Ebene — Lange Schatten</a>
        </body></html>`,
      '{"releases":[{"artist":"Weite Ebene","title":"Lange Schatten","itemType":"album"},' +
        '{"artist":"Baie Sud","title":"Quinze Nuits","itemType":"ep"}]}',
    );

    const results = await createMusicItemsFromUrl("https://roundup.example/winter-listening", {
      selectedCandidateIds: ["cand-1-weite-ebene-lange-schatten", "cand-2-baie-sud-quinze-nuits"],
    });

    expect(results.map((result) => result.item.primary_url)).toEqual([
      "https://roundup.example/records/lange-schatten",
      "https://roundup.example/winter-listening",
    ]);
  });

  test("keeps the page's own URL for the release the page is about", async () => {
    mockScrape(
      `<html><head><meta property="og:title" content="Baie Nord — Terre Ferme"></head>
        <body><h1>Terre Ferme</h1>
          <p>New album, out now on vinyl. Listen to every track.</p>
          <a href="/terre-ferme/deuxieme-jour">Deuxième Jour</a>
        </body></html>`,
      '{"releases":[{"artist":"Baie Nord","title":"Terre Ferme","itemType":"album","isPrimary":true,"confidence":0.9},' +
        '{"artist":"Baie Nord","title":"Deuxième Jour","itemType":"album","confidence":0.3}]}',
    );

    const results = await createMusicItemsFromUrl("https://label.example/terre-ferme");

    expect(results).toHaveLength(1);
    expect(results[0]!.item.title).toBe("Terre Ferme");
    expect(results[0]!.item.primary_url).toBe("https://label.example/terre-ferme");
  });
});

import { describe, test, expect, spyOn, mock, afterEach } from "bun:test";
import { createMusicItemsFromUrl, formatPageSourceNote } from "../../server/music-item-creator";

// Unsupported pages go through the Mistral extractor, and freshly created items
// kick off background lookups — keep both off the network.
process.env.MISTRAL_API_KEY = "test-key";
process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";

/** The shape `@mistralai/mistralai` expects back from chat.complete. */
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

function pageHtml(title: string): string {
  return `
    <html>
      <head>
        <meta property="og:title" content="${title}">
      </head>
      <body>
        <h1>${title}</h1>
        <p>Our favourite album releases of the year, on vinyl and cassette.</p>
      </body>
    </html>
  `;
}

/** Serve the page HTML, then the extractor's JSON, to one scrape. */
function mockScrape(title: string, releasesJson: string) {
  const fetchSpy = spyOn(globalThis, "fetch");
  fetchSpy.mockResolvedValueOnce(
    new Response(pageHtml(title), { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  fetchSpy.mockResolvedValueOnce(mockChatCompletionResponse(releasesJson));
  return fetchSpy;
}

afterEach(() => {
  mock.restore();
});

describe("formatPageSourceNote", () => {
  test("names the page and its URL", () => {
    expect(formatPageSourceNote("https://example.com/best-of", "Best of 2026")).toBe(
      "From Best of 2026 (https://example.com/best-of)",
    );
  });

  test("falls back to the bare URL when the page had no title", () => {
    expect(formatPageSourceNote("https://example.com/best-of")).toBe(
      "From https://example.com/best-of",
    );
    expect(formatPageSourceNote("https://example.com/best-of", "   ")).toBe(
      "From https://example.com/best-of",
    );
  });

  test("collapses whitespace and truncates an overlong title", () => {
    const note = formatPageSourceNote(
      "https://example.com/x",
      `The\n  best   albums ${"a".repeat(200)}`,
    );
    expect(note.startsWith("From The best albums ")).toBe(true);
    expect(note.endsWith("… (https://example.com/x)")).toBe(true);
    expect(note.length).toBeLessThan(160);
  });
});

describe("createMusicItemsFromUrl: multi-release page provenance", () => {
  test("stamps the page on every release picked off it", async () => {
    mockScrape(
      "Best albums of 2026",
      '{"releases":[{"artist":"Kalte Sterne","title":"Nachtfahrt","itemType":"album"},{"artist":"Rue Basse","title":"Onze","itemType":"ep"}]}',
    );

    const results = await createMusicItemsFromUrl("https://roundup.example/best-of-2026", {
      selectedCandidateIds: ["cand-1-kalte-sterne-nachtfahrt", "cand-2-rue-basse-onze"],
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.created)).toBe(true);
    for (const result of results) {
      expect(result.item.notes).toBe(
        "From Best albums of 2026 (https://roundup.example/best-of-2026)",
      );
    }
  });

  test("keeps the shared note and appends the page to it", async () => {
    mockScrape(
      "Shop update: new arrivals",
      '{"releases":[{"artist":"Halbe Zeit","title":"Tagwerk","itemType":"album"},{"artist":"Ninth Hour","title":"Slow Tide","itemType":"album"}]}',
    );

    const results = await createMusicItemsFromUrl("https://shop.example/new-arrivals", {
      notes: "Via email from noreply@shop.example",
      selectedCandidateIds: ["cand-1-halbe-zeit-tagwerk", "cand-2-ninth-hour-slow-tide"],
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.item.notes).toBe(
      "Via email from noreply@shop.example — From Shop update: new arrivals (https://shop.example/new-arrivals)",
    );
  });

  test("leaves a single-release page's item unnoted", async () => {
    mockScrape(
      "Marta Vega — Bajamar",
      '{"releases":[{"artist":"Marta Vega","title":"Bajamar","itemType":"album","isPrimary":true}]}',
    );

    const results = await createMusicItemsFromUrl("https://label.example/bajamar");

    expect(results).toHaveLength(1);
    expect(results[0]!.created).toBe(true);
    expect(results[0]!.item.notes).toBeNull();
  });

  test("leaves the page's own release unnoted when it is picked automatically", async () => {
    mockScrape(
      "Ora Lune — Vent Debout",
      '{"releases":[{"artist":"Ora Lune","title":"Vent Debout","itemType":"album","isPrimary":true,"confidence":0.9},{"artist":"Ora Lune","title":"Premier Jour","itemType":"album","confidence":0.3}]}',
    );

    const results = await createMusicItemsFromUrl("https://label.example/vent-debout");

    expect(results).toHaveLength(1);
    expect(results[0]!.item.title).toBe("Vent Debout");
    expect(results[0]!.item.notes).toBeNull();
  });
});

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ogFallbackCandidate,
  scrapeUnknownWebPage,
  stripSiteSuffix,
  UnsupportedMusicLinkError,
} from "../../adapters/web/index";
import { buildCandidateId } from "../../adapters/web/link-extractor";
import { scrapeUrl } from "../../app/scrape";

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

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

/** A music page with a title of its own, from a source we don't model. */
function radioEpisodePage(ogTitle: string, siteName: string): string {
  return `
    <html><head>
      <meta property="og:title" content="${ogTitle}" />
      <meta property="og:site_name" content="${siteName}" />
      <meta property="og:image" content="https://example.com/cover.jpg" />
    </head><body>
      <h1>${ogTitle}</h1>
      <p>Listen back to the show. Tracklist and stream below.</p>
    </body></html>
  `;
}

async function expectUnsupported(promise: Promise<unknown>, message: string): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UnsupportedMusicLinkError);
  expect((thrown as Error).message).toBe(message);
}

describe("stripSiteSuffix", () => {
  test("drops the site name off the end of the title", () => {
    expect(stripSiteSuffix("Late Night Jazz - Worldwide FM", "Worldwide FM")).toBe(
      "Late Night Jazz",
    );
  });

  test("handles pipe and dash separators, case-insensitively", () => {
    expect(stripSiteSuffix("Show | Example Radio", "Example Radio")).toBe("Show");
    expect(stripSiteSuffix("Show – Example Radio", "Example Radio")).toBe("Show");
    expect(stripSiteSuffix("Show — Example Radio", "Example Radio")).toBe("Show");
    expect(stripSiteSuffix("Show - EXAMPLE RADIO", "Example Radio")).toBe("Show");
  });

  test("leaves a title without the suffix alone", () => {
    expect(stripSiteSuffix("Worldwide FM presents Late Night Jazz", "Worldwide FM")).toBe(
      "Worldwide FM presents Late Night Jazz",
    );
    expect(stripSiteSuffix("  Late Night Jazz  ")).toBe("Late Night Jazz");
  });

  test("escapes regex characters in the site name", () => {
    expect(stripSiteSuffix("Guest Mix (Live) - Radio.com", "Radio.com")).toBe("Guest Mix (Live)");
  });

  test("a title that is only the site name strips to nothing", () => {
    expect(stripSiteSuffix("Worldwide FM", "Worldwide FM")).toBe("");
    expect(stripSiteSuffix("- Worldwide FM", "Worldwide FM")).toBe("");
  });
});

describe("ogFallbackCandidate", () => {
  test("files the page itself as a primary mix candidate", () => {
    const candidate = ogFallbackCandidate({
      ogTitle: "Santa Leticia: Underground Pirate Radio From Spain (WOH 2026) - Worldwide FM",
      ogSiteName: "Worldwide FM",
    });
    const title = "Santa Leticia: Underground Pirate Radio From Spain (WOH 2026)";
    expect(candidate).toEqual({
      candidateId: buildCandidateId(undefined, title, 0),
      title,
      itemType: "mix",
      isPrimary: true,
      evidence: "page title",
    });
  });

  test("falls back to the <title> tag when og:title is absent", () => {
    const candidate = ogFallbackCandidate({ title: "Guest Mix 042 - Example Blog" });
    expect(candidate?.title).toBe("Guest Mix 042 - Example Blog");
    expect(candidate?.itemType).toBe("mix");
  });

  test("answers null when the page has no title of its own", () => {
    expect(ogFallbackCandidate({})).toBeNull();
    expect(ogFallbackCandidate({ ogTitle: "Worldwide FM", ogSiteName: "Worldwide FM" })).toBeNull();
    expect(
      ogFallbackCandidate({ ogTitle: " - Worldwide FM", ogSiteName: "Worldwide FM" }),
    ).toBeNull();
  });
});

describe("scrapeUnknownWebPage — OG fallback", () => {
  const originalEnv = { ...process.env };
  const url = "https://example-radio.net/episode/late-night-jazz";

  afterEach(() => {
    mock.restore();
    process.env = { ...originalEnv };
  });

  test("falls back to the page title as a mix when no extraction key is configured", async () => {
    delete process.env.MISTRAL_API_KEY;
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      htmlResponse(radioEpisodePage("Late Night Jazz Session - Example Radio", "Example Radio")),
    );

    const result = await scrapeUnknownWebPage(url, 5000);

    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe("Late Night Jazz Session");
    expect(result!.itemType).toBe("mix");
    expect(result!.imageUrl).toBe("https://example.com/cover.jpg");
    expect(result!.pageTitle).toBe("Late Night Jazz Session - Example Radio");
    expect(result!.releases).toEqual([
      {
        candidateId: buildCandidateId(undefined, "Late Night Jazz Session", 0),
        title: "Late Night Jazz Session",
        itemType: "mix",
        isPrimary: true,
        evidence: "page title",
      },
    ]);
    expect(result!.embedMetadata).toBeUndefined();
    // No key, no extraction call — the page fetch is the only one.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("falls back when the extraction service fails", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      htmlResponse(radioEpisodePage("Late Night Jazz Session - Example Radio", "Example Radio")),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await scrapeUnknownWebPage(url, 5000);

    expect(result!.potentialTitle).toBe("Late Night Jazz Session");
    expect(result!.releases?.[0]?.evidence).toBe("page title");
  });

  test("falls back when the extraction names nothing", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      htmlResponse(radioEpisodePage("Late Night Jazz Session - Example Radio", "Example Radio")),
    );
    fetchSpy.mockResolvedValueOnce(mockChatCompletionResponse('{"releases":[]}'));

    const result = await scrapeUnknownWebPage(url, 5000);

    expect(result!.potentialTitle).toBe("Late Night Jazz Session");
    expect(result!.itemType).toBe("mix");
  });

  test("falls back when the extraction answer is unreadable", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      htmlResponse(radioEpisodePage("Late Night Jazz Session - Example Radio", "Example Radio")),
    );
    fetchSpy.mockResolvedValueOnce(mockChatCompletionResponse("Sorry, I can't help with that."));

    const result = await scrapeUnknownWebPage(url, 5000);

    expect(result!.potentialTitle).toBe("Late Night Jazz Session");
    expect(result!.releases?.[0]?.evidence).toBe("page title");
  });

  test("keeps the extraction's candidates when it names one", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      htmlResponse(radioEpisodePage("Late Night Jazz Session - Example Radio", "Example Radio")),
    );
    fetchSpy.mockResolvedValueOnce(
      mockChatCompletionResponse(
        '{"releases":[{"artist":"DJ Example","title":"Late Night Jazz Session","itemType":"mix","isPrimary":true,"evidence":"episode headline"}]}',
      ),
    );

    const result = await scrapeUnknownWebPage(url, 5000);

    expect(result!.potentialArtist).toBe("DJ Example");
    expect(result!.potentialTitle).toBe("Late Night Jazz Session");
    expect(result!.releases).toEqual([
      {
        candidateId: "cand-1-dj-example-late-night-jazz-session",
        artist: "DJ Example",
        title: "Late Night Jazz Session",
        itemType: "mix",
        isPrimary: true,
        evidence: "episode headline",
      },
    ]);
  });

  test("rejects a titleless music page with the no-key reason", async () => {
    delete process.env.MISTRAL_API_KEY;
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      htmlResponse(radioEpisodePage("Example Radio", "Example Radio")),
    );

    await expectUnsupported(
      scrapeUnknownWebPage(url, 5000),
      "This server can't read unknown links: no extraction key (MISTRAL_API_KEY) is configured",
    );
  });

  test("rejects a titleless music page when the extraction service fails", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      htmlResponse(radioEpisodePage("Example Radio", "Example Radio")),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    // The taxonomy alone reaches the person adding the link — the provider's
    // raw error stays in the server log.
    await expectUnsupported(
      scrapeUnknownWebPage(url, 5000),
      "The extraction service failed while reading this link",
    );
  });

  test("rejects a titleless music page when the answer is unreadable", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      htmlResponse(radioEpisodePage("Example Radio", "Example Radio")),
    );
    fetchSpy.mockResolvedValueOnce(mockChatCompletionResponse("Sorry, I can't help with that."));

    await expectUnsupported(
      scrapeUnknownWebPage(url, 5000),
      "The extraction service returned an unreadable answer for this link",
    );
  });

  test("rejects a titleless music page when the extraction names nothing", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      htmlResponse(radioEpisodePage("Example Radio", "Example Radio")),
    );
    fetchSpy.mockResolvedValueOnce(mockChatCompletionResponse('{"releases":[]}'));

    await expectUnsupported(
      scrapeUnknownWebPage(url, 5000),
      "Couldn't find a release, mix or radio show on this page",
    );
  });

  test("an embed-only page skips the extraction and keeps the player", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    const html = `
      <html><head>
        <meta property="og:title" content="Guest Mix 042 - Example Blog" />
        <meta property="og:site_name" content="Example Blog" />
      </head><body>
        <h1>Welcome to our blog</h1>
        <p>Thanks for stopping by.</p>
        <iframe src="https://www.mixcloud.com/widget/iframe/?feed=%2FDJExample%2Fguest-mix-042%2F"></iframe>
      </body></html>
    `;
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(htmlResponse(html));

    const result = await scrapeUnknownWebPage("https://example-blog.net/guest-mix", 5000);

    expect(result!.potentialTitle).toBe("Guest Mix 042");
    expect(result!.itemType).toBe("mix");
    expect(result!.embedMetadata).toEqual({
      mixcloud_url: "https://www.mixcloud.com/DJExample/guest-mix-042/",
    });
    // The player already says what the page is — no extraction call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("a lone show mention doesn't make a non-music page addable", async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Fresh Bread Every Day - Example Bakery" />
        <meta property="og:site_name" content="Example Bakery" />
      </head><body>
        <h1>Welcome to our bakery</h1>
        <p>Sourdough, croissants and coffee, baked fresh every morning.</p>
        <footer><a href="https://www.mixcloud.com/ExampleBakery/our-interview/">Hear our story on Mixcloud</a></footer>
      </body></html>
    `;
    spyOn(globalThis, "fetch").mockResolvedValueOnce(htmlResponse(html));

    await expectUnsupported(
      scrapeUnknownWebPage("https://example-bakery.com", 5000),
      "Link does not appear to be music-related",
    );
  });

  test("a JSON widget player on a textless page skips the extraction and keeps the player", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    const html = `
      <html><head>
        <meta property="og:title" content="Guest Mix 042 - Example Blog" />
        <meta property="og:site_name" content="Example Blog" />
      </head><body>
        <h1>Welcome to our blog</h1>
        <script>{"player":"https:\\/\\/www.mixcloud.com\\/widget\\/iframe\\/?feed=%2FDJExample%2Fguest-mix-042%2F"}</script>
      </body></html>
    `;
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(htmlResponse(html));

    const result = await scrapeUnknownWebPage("https://example-blog.net/guest-mix", 5000);

    expect(result!.potentialTitle).toBe("Guest Mix 042");
    expect(result!.itemType).toBe("mix");
    expect(result!.embedMetadata).toEqual({
      mixcloud_url: "https://www.mixcloud.com/DJExample/guest-mix-042/",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("an embed-only page with no title says what is missing, not that nothing was found", async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Example Blog" />
        <meta property="og:site_name" content="Example Blog" />
      </head><body>
        <h1>Welcome to our blog</h1>
        <iframe src="https://www.mixcloud.com/widget/iframe/?feed=%2FDJExample%2Fguest-mix-042%2F"></iframe>
      </body></html>
    `;
    spyOn(globalThis, "fetch").mockResolvedValueOnce(htmlResponse(html));

    await expectUnsupported(
      scrapeUnknownWebPage("https://example-blog.net/guest-mix", 5000),
      "This page only carries a Mixcloud player and has no title to name the show",
    );
  });

  test("still rejects pages that aren't about music", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      htmlResponse("<html><body><h1>Spring sale</h1><p>Big discounts on bags.</p></body></html>"),
    );

    await expectUnsupported(
      scrapeUnknownWebPage("https://example.com/sale", 5000),
      "Link does not appear to be music-related",
    );
  });
});

describe("scrapeUrl — a Worldwide FM radio episode", () => {
  // Trimmed from the real episode page: OG tags streamed late in the body, a
  // broken canonical, and the Mixcloud show URL only inside escaped-quote RSC JSON.
  const fixture = readFileSync(
    new URL("../fixtures/worldwidefm-episode.html", import.meta.url),
    "utf8",
  );
  const url =
    "https://www.worldwidefm.net/episode/santa-leticia-underground-pirate-radio-from-spain";
  const title = "Santa Leticia: Underground Pirate Radio From Spain (WOH 2026)";
  const mixcloudUrl =
    "https://www.mixcloud.com/worldwidefm/santa-leticia-underground-pirate-radio-from-spain-woh-2026-22-08-26/";
  const originalEnv = { ...process.env };

  afterEach(() => {
    mock.restore();
    process.env = { ...originalEnv };
  });

  test("adds the episode as a mix with its artwork and Mixcloud player, even with no extraction key", async () => {
    delete process.env.MISTRAL_API_KEY;
    spyOn(globalThis, "fetch").mockResolvedValueOnce(htmlResponse(fixture));

    const result = await scrapeUrl(url, "unknown");

    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe(title);
    expect(result!.itemType).toBe("mix");
    expect(result!.imageUrl).toBe(
      "https://imgix.cosmicjs.com/ba413490-ae9d-11f1-a73f-9d0b2ea70ade-20260822-Santa-Leticia-Underground-Pirate-Radio-From-Spain.jpg",
    );
    expect(result!.pageTitle).toBe(`${title} - Worldwide FM`);
    expect(result!.releases).toEqual([
      {
        candidateId: buildCandidateId(undefined, title, 0),
        title,
        itemType: "mix",
        isPrimary: true,
        evidence: "page title",
      },
    ]);
    expect(result!.embedMetadata).toEqual({ mixcloud_url: mixcloudUrl });
  });

  test("falls back the same way when the extraction runs but names nothing", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(htmlResponse(fixture));
    fetchSpy.mockResolvedValueOnce(mockChatCompletionResponse('{"releases":[]}'));

    const result = await scrapeUrl(url, "unknown");

    expect(result!.potentialTitle).toBe(title);
    expect(result!.itemType).toBe("mix");
    expect(result!.embedMetadata).toEqual({ mixcloud_url: mixcloudUrl });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

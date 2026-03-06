import { describe, test, expect, spyOn, mock } from "bun:test";
import {
  parseOgTags,
  decodeHtmlEntities,
  parseBandcampOg,
  parseSoundcloudOg,
  parseAppleMusicOg,
  parseMixcloudOg,
  parseMixcloudJsonLd,
  parseDefaultOg,
  detectMusicRelatedHtml,
  scrapeUrl,
  UnsupportedMusicLinkError,
} from "../../server/scraper";

function mockChatCompletionResponse(
  content: string | Array<{ type: string; text: string }>,
): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl_test_1",
      object: "chat.completion",
      created: 1,
      model: "mistral-small-latest",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content,
          },
        },
      ],
    }),
    {
      headers: { "content-type": "application/json" },
    },
  );
}

describe("decodeHtmlEntities", () => {
  test("decodes common HTML entities", () => {
    expect(decodeHtmlEntities("Rock &amp; Roll")).toBe("Rock & Roll");
    expect(decodeHtmlEntities("&lt;b&gt;bold&lt;/b&gt;")).toBe("<b>bold</b>");
    expect(decodeHtmlEntities("&quot;quoted&quot;")).toBe('"quoted"');
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
    expect(decodeHtmlEntities("it&#39;s")).toBe("it's");
    expect(decodeHtmlEntities("it&#x27;s")).toBe("it's");
  });

  test("decodes numeric entities", () => {
    expect(decodeHtmlEntities("&#8211;")).toBe("\u2013");
    expect(decodeHtmlEntities("it&#x2019;s")).toBe("it\u2019s");
  });
});

describe("parseOgTags", () => {
  test("extracts og:title and og:image (property before content)", () => {
    const html = `
      <html><head>
        <meta property="og:title" content="My Album" />
        <meta property="og:image" content="https://example.com/cover.jpg" />
      </head></html>
    `;
    const result = parseOgTags(html);
    expect(result.ogTitle).toBe("My Album");
    expect(result.ogImage).toBe("https://example.com/cover.jpg");
  });

  test("extracts og tags with content before property", () => {
    const html = `
      <html><head>
        <meta content="Reversed Title" property="og:title" />
        <meta content="Some description" property="og:description" />
      </head></html>
    `;
    const result = parseOgTags(html);
    expect(result.ogTitle).toBe("Reversed Title");
    expect(result.ogDescription).toBe("Some description");
  });

  test("falls back to <title> when og:title is absent", () => {
    const html = `
      <html><head>
        <title>Fallback Title</title>
      </head></html>
    `;
    const result = parseOgTags(html);
    expect(result.ogTitle).toBeUndefined();
    expect(result.title).toBe("Fallback Title");
  });

  test("decodes HTML entities in content", () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Rock &amp; Roll" />
      </head></html>
    `;
    const result = parseOgTags(html);
    expect(result.ogTitle).toBe("Rock & Roll");
  });

  test("preserves apostrophes in quoted meta content values", () => {
    const html = `
      <html><head>
        <meta property="og:title" content="It's a Beautiful Place" />
      </head></html>
    `;
    const result = parseOgTags(html);
    expect(result.ogTitle).toBe("It's a Beautiful Place");
  });

  test("extracts og:site_name", () => {
    const html = `
      <html><head>
        <meta property="og:site_name" content="Bandcamp" />
        <meta property="og:title" content="Test" />
      </head></html>
    `;
    const result = parseOgTags(html);
    expect(result.ogSiteName).toBe("Bandcamp");
  });

  test("returns empty data for html with no meta tags", () => {
    const result = parseOgTags("<html><head></head></html>");
    expect(result.ogTitle).toBeUndefined();
    expect(result.ogImage).toBeUndefined();
    expect(result.title).toBeUndefined();
  });
});

describe("parseBandcampOg", () => {
  test('splits "Title, by Artist" format', () => {
    const result = parseBandcampOg({
      ogTitle: "Midnight Sun, by Solar Winds",
      ogImage: "https://f4.bcbits.com/img/cover.jpg",
    });
    expect(result.potentialTitle).toBe("Midnight Sun");
    expect(result.potentialArtist).toBe("Solar Winds");
    expect(result.imageUrl).toBe("https://f4.bcbits.com/img/cover.jpg");
  });

  test('handles title without "by" separator', () => {
    const result = parseBandcampOg({
      ogTitle: "Just A Title",
    });
    expect(result.potentialTitle).toBe("Just A Title");
    expect(result.potentialArtist).toBeUndefined();
  });

  test("falls back to <title> tag", () => {
    const result = parseBandcampOg({
      title: "Album, by Band",
    });
    expect(result.potentialTitle).toBe("Album");
    expect(result.potentialArtist).toBe("Band");
  });
});

describe("parseSoundcloudOg", () => {
  test('splits "Track by Artist" format', () => {
    const result = parseSoundcloudOg({
      ogTitle: "Cool Track by DJ Fresh",
      ogImage: "https://i1.sndcdn.com/artworks.jpg",
    });
    expect(result.potentialTitle).toBe("Cool Track");
    expect(result.potentialArtist).toBe("DJ Fresh");
    expect(result.imageUrl).toBe("https://i1.sndcdn.com/artworks.jpg");
  });

  test('splits "Stream Track by Artist on SoundCloud" format', () => {
    const result = parseSoundcloudOg({
      ogTitle: "Stream Remix by Producer on SoundCloud",
    });
    expect(result.potentialTitle).toBe("Remix");
    expect(result.potentialArtist).toBe("Producer");
  });

  test('handles title without "by" separator', () => {
    const result = parseSoundcloudOg({
      ogTitle: "SomeTrack",
    });
    expect(result.potentialTitle).toBe("SomeTrack");
    expect(result.potentialArtist).toBeUndefined();
  });
});

describe("parseAppleMusicOg", () => {
  test("extracts title and artist from description", () => {
    const result = parseAppleMusicOg({
      ogTitle: "Random Access Memories",
      ogDescription: "Daft Punk · 2013 · 13 Songs",
      ogImage: "https://is1-ssl.mzstatic.com/image/cover.jpg",
    });
    expect(result.potentialTitle).toBe("Random Access Memories");
    expect(result.potentialArtist).toBe("Daft Punk");
    expect(result.imageUrl).toBe("https://is1-ssl.mzstatic.com/image/cover.jpg");
  });

  test("extracts title and artist from og:title byline format", () => {
    const result = parseAppleMusicOg({
      ogTitle: "It's a Beautiful Place by Water From Your Eyes on Apple Music",
      ogDescription: "Album · 2025 · 10 Songs",
    });
    expect(result.potentialTitle).toBe("It's a Beautiful Place");
    expect(result.potentialArtist).toBe("Water From Your Eyes");
  });

  test("handles missing description", () => {
    const result = parseAppleMusicOg({
      ogTitle: "Some Album",
    });
    expect(result.potentialTitle).toBe("Some Album");
    expect(result.potentialArtist).toBeUndefined();
  });
});

describe("parseMixcloudOg", () => {
  test('splits "Title by Artist" format and strips Mixcloud suffixes', () => {
    const result = parseMixcloudOg({
      ogTitle: "New Rap Music January 2026 by andrew | Mixcloud",
      ogImage: "https://thumbnail.example/image.jpg",
    });

    expect(result.potentialTitle).toBe("New Rap Music January 2026");
    expect(result.potentialArtist).toBe("andrew");
    expect(result.imageUrl).toBe("https://thumbnail.example/image.jpg");
  });

  test("prefers explicit uploader metadata when available", () => {
    const result = parseMixcloudOg({
      ogTitle: "light sleeper radio 021 by nozwon",
      metaTags: {
        "twitter:audio:artist_name": "andrew",
        "twitter:title": "new rap music january 2026",
      },
    });

    expect(result.potentialArtist).toBe("andrew");
    expect(result.potentialTitle).toBe("new rap music january 2026");
  });

  test("falls back to Twitter image metadata and normalizes to square", () => {
    const result = parseMixcloudOg({
      ogTitle: "light sleeper radio 021 by nozwon",
      metaTags: {
        "twitter:image": "https://thumbnailer.mixcloud.com/unsafe/640x360/extaudio/abc.jpg",
      },
    });

    expect(result.imageUrl).toBe(
      "https://thumbnailer.mixcloud.com/unsafe/640x640/extaudio/abc.jpg",
    );
  });
});

describe("parseMixcloudJsonLd", () => {
  test("extracts title and uploader from JSON-LD scripts", () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {
            "@context":"https://schema.org",
            "@type":"AudioObject",
            "title":"new rap music january 2026",
            "uploader":{"@type":"Person","name":"andrew"}
          }
        </script>
      </head></html>
    `;

    const result = parseMixcloudJsonLd(html);
    expect(result.potentialTitle).toBe("new rap music january 2026");
    expect(result.potentialArtist).toBe("andrew");
  });

  test("extracts image from JSON-LD", () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {
            "@context":"https://schema.org",
            "@type":"AudioObject",
            "image":{"@type":"ImageObject","url":"https://thumbnailer.mixcloud.com/unsafe/300x500/extaudio/abc.jpg"}
          }
        </script>
      </head></html>
    `;

    const result = parseMixcloudJsonLd(html);
    expect(result.imageUrl).toBe(
      "https://thumbnailer.mixcloud.com/unsafe/500x500/extaudio/abc.jpg",
    );
  });
});

describe("parseDefaultOg", () => {
  test("uses og:title as potentialTitle", () => {
    const result = parseDefaultOg({
      ogTitle: "Some Video",
      ogImage: "https://example.com/thumb.jpg",
    });
    expect(result.potentialTitle).toBe("Some Video");
    expect(result.imageUrl).toBe("https://example.com/thumb.jpg");
  });

  test("falls back to title tag", () => {
    const result = parseDefaultOg({
      title: "Page Title",
    });
    expect(result.potentialTitle).toBe("Page Title");
  });

  test("returns undefined for empty data", () => {
    const result = parseDefaultOg({});
    expect(result.potentialTitle).toBeUndefined();
    expect(result.imageUrl).toBeUndefined();
  });
});

describe("detectMusicRelatedHtml", () => {
  test("treats album metadata as music-related", () => {
    const result = detectMusicRelatedHtml(`
      <html><body>
        <h1>New album release</h1>
        <p>Artist: Theo Parrish</p>
      </body></html>
    `);

    expect(result.isMusicRelated).toBe(true);
    expect(result.matchedTerms).toContain("album");
  });

  test("rejects generic pages without music vocabulary", () => {
    const result = detectMusicRelatedHtml(`
      <html><body>
        <h1>Spring sale</h1>
        <p>Read our privacy policy and shipping FAQ.</p>
      </body></html>
    `);

    expect(result.isMusicRelated).toBe(false);
  });
});

describe("scrapeUrl", () => {
  const originalEnv = { ...process.env };

  test("throws for unknown pages with no music-related terms", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html><body><h1>Welcome</h1><p>Contact us</p></body></html>", {
        headers: { "content-type": "text/html" },
      }),
    );

    let thrown: unknown;
    try {
      await scrapeUrl("https://example.com", "unknown");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedMusicLinkError);
    expect((thrown as Error).message).toBe("Link does not appear to be music-related");
    mock.restore();
  });

  test("returns null on fetch failure", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));
    const result = await scrapeUrl("https://example.com", "unknown");
    expect(result).toBeNull();
    mock.restore();
  });

  test("returns null for non-HTML content-type", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("binary data", {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const result = await scrapeUrl("https://example.com/file.zip", "unknown");
    expect(result).toBeNull();
    mock.restore();
  });

  test("parses OG tags from HTML response", async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Test Album, by Test Artist" />
        <meta property="og:image" content="https://example.com/cover.jpg" />
      </head><body></body></html>
    `;
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const result = await scrapeUrl("https://testartist.bandcamp.com/album/test-album", "bandcamp");
    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe("Test Album");
    expect(result!.potentialArtist).toBe("Test Artist");
    expect(result!.imageUrl).toBe("https://example.com/cover.jpg");
    mock.restore();
  });

  test("uses default parser for unknown sources", async () => {
    process.env.MISTRAL_API_KEY = "test-key";

    const html = `
      <html><head>
        <meta property="og:title" content="Spring 2026 release roundup" />
        <meta property="og:image" content="https://example.com/cover.jpg" />
      </head><body>
        <h1>New releases</h1>
        <p>Artist Theo Parrish album In Motion now available on vinyl.</p>
      </body></html>
    `;

    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(html, {
        headers: { "content-type": "text/html" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      mockChatCompletionResponse(
        '{"releases":[{"artist":"Theo Parrish","title":"In Motion","itemType":"album"}]}',
      ),
    );

    const result = await scrapeUrl("https://example.com/music", "unknown");
    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe("In Motion");
    expect(result!.potentialArtist).toBe("Theo Parrish");
    expect(result!.itemType).toBe("album");
    expect(result!.releases).toEqual([
      { artist: "Theo Parrish", title: "In Motion", itemType: "album" },
    ]);
    mock.restore();
    process.env = { ...originalEnv };
  });

  test("respects timeout", async () => {
    spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), 100)),
    );
    const result = await scrapeUrl("https://example.com", "unknown", 50);
    expect(result).toBeNull();
    mock.restore();
  });

  test("uses Mixcloud JSON-LD metadata when present", async () => {
    const html = `
      <html><head>
        <meta property="og:image" content="https://mixcloud.com/cover.jpg" />
        <script type="application/ld+json">
          {
            "@context":"https://schema.org",
            "@type":"AudioObject",
            "title":"new rap music january 2026",
            "uploader":{"@type":"Person","name":"andrew"}
          }
        </script>
      </head><body></body></html>
    `;

    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response("{}", {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const result = await scrapeUrl(
      "https://www.mixcloud.com/nozwon/light-sleeper-radio-021/",
      "mixcloud",
    );
    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe("new rap music january 2026");
    expect(result!.potentialArtist).toBe("andrew");
    expect(result!.imageUrl).toBe("https://mixcloud.com/cover.jpg");
    mock.restore();
  });

  test("uses YouTube oEmbed metadata when available", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "On the Beach (2016 Remaster)",
          author_name: "neilyoungchannel",
          thumbnail_url: "https://i.ytimg.com/vi/C9CkvAQkQLs/hqdefault.jpg",
        }),
        {
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
    );

    const result = await scrapeUrl("https://www.youtube.com/watch?v=C9CkvAQkQLs", "youtube");
    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe("On the Beach (2016 Remaster)");
    expect(result!.potentialArtist).toBe("neilyoungchannel");
    expect(result!.imageUrl).toBe("https://i.ytimg.com/vi/C9CkvAQkQLs/hqdefault.jpg");
    mock.restore();
  });

  test("returns null when YouTube oEmbed fails", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 404 }));

    const result = await scrapeUrl("https://www.youtube.com/watch?v=badid", "youtube");
    expect(result).toBeNull();
    mock.restore();
  });

  test("uses Mixcloud oEmbed metadata when available", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "new rap music january 2026",
          author_name: "andrew",
          thumbnail_url: "https://mixcloud.com/oembed-cover.jpg",
        }),
        {
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
    );

    const result = await scrapeUrl(
      "https://www.mixcloud.com/nozwon/light-sleeper-radio-021/",
      "mixcloud",
    );
    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe("new rap music january 2026");
    expect(result!.potentialArtist).toBe("andrew");
    expect(result!.imageUrl).toBe("https://mixcloud.com/oembed-cover.jpg");
    mock.restore();
  });

  test("retains Mixcloud image from oEmbed when page scrape fails", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          thumbnail_url: "https://thumbnailer.mixcloud.com/unsafe/800x450/extaudio/xyz.jpg",
        }),
        {
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
    );
    fetchSpy.mockRejectedValueOnce(new Error("network error"));

    const result = await scrapeUrl(
      "https://www.mixcloud.com/nozwon/light-sleeper-radio-021/",
      "mixcloud",
    );
    expect(result).not.toBeNull();
    expect(result!.imageUrl).toBe(
      "https://thumbnailer.mixcloud.com/unsafe/800x800/extaudio/xyz.jpg",
    );
    mock.restore();
  });

  test("prefers Apple oEmbed metadata for square artwork without scraping the full page", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "It's a Beautiful Place",
          author_name: "Water From Your Eyes",
          thumbnail_url:
            "https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/example/300x300bb.jpg",
        }),
        {
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
    );

    const result = await scrapeUrl(
      "https://music.apple.com/es/album/its-a-beautiful-place/1811583108?l=en-GB",
      "apple_music",
    );
    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe("It's a Beautiful Place");
    expect(result!.potentialArtist).toBe("Water From Your Eyes");
    expect(result!.imageUrl).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/example/1200x1200bb.jpg",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://music.apple.com/api/oembed?url=https%3A%2F%2Fmusic.apple.com%2Fes%2Falbum%2Fits-a-beautiful-place%2F1811583108%3Fl%3Den-GB",
    );
    mock.restore();
  });

  test("falls back to Apple lookup metadata when oEmbed is unavailable", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }));
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          resultCount: 1,
          results: [
            {
              collectionName: "It's a Beautiful Place",
              artistName: "Water From Your Eyes",
              artworkUrl100:
                "https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/example/100x100bb.jpg",
            },
          ],
        }),
        {
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
    );

    const result = await scrapeUrl(
      "https://music.apple.com/es/album/its-a-beautiful-place/1811583108?l=en-GB",
      "apple_music",
    );

    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe("It's a Beautiful Place");
    expect(result!.potentialArtist).toBe("Water From Your Eyes");
    expect(result!.imageUrl).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/example/1200x1200bb.jpg",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://itunes.apple.com/lookup?id=1811583108");
    mock.restore();
  });

  test("returns multiple releases for unsupported music pages when Mistral extracts them", async () => {
    process.env.MISTRAL_API_KEY = "test-key";

    const html = `
      <html><body>
        <h1>Label release page</h1>
        <p>New album release from Artist One and Artist Two.</p>
        <p>Track listings and vinyl details below.</p>
      </body></html>
    `;

    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      mockChatCompletionResponse(
        '{"releases":[{"artist":"Artist One","title":"First Album","itemType":"album"},{"artist":"Artist Two","title":"Second EP","itemType":"ep"}]}',
      ),
    );

    const result = await scrapeUrl("https://obscuremusic.example/releases", "unknown");
    expect(result).not.toBeNull();
    expect(result!.releases).toEqual([
      { artist: "Artist One", title: "First Album", itemType: "album" },
      { artist: "Artist Two", title: "Second EP", itemType: "ep" },
    ]);
    expect(result!.potentialTitle).toBe("First Album");
    expect(result!.potentialArtist).toBe("Artist One");

    mock.restore();
    process.env = { ...originalEnv };
  });
});

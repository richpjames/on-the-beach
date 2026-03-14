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
  extractBandcampEmbedMetadata,
  extractMixcloudEmbedUrl,
  searchAppleMusic,
  parseNtsOg,
  parseCanonicalUrl,
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
      {
        candidateId: "cand-1-theo-parrish-in-motion",
        artist: "Theo Parrish",
        title: "In Motion",
        itemType: "album",
      },
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
      {
        candidateId: "cand-1-artist-one-first-album",
        artist: "Artist One",
        title: "First Album",
        itemType: "album",
      },
      {
        candidateId: "cand-2-artist-two-second-ep",
        artist: "Artist Two",
        title: "Second EP",
        itemType: "ep",
      },
    ]);
    expect(result!.potentialTitle).toBe("First Album");
    expect(result!.potentialArtist).toBe("Artist One");

    mock.restore();
    process.env = { ...originalEnv };
  });
});

describe("extractBandcampEmbedMetadata", () => {
  test("extracts album_id from bc-page-properties meta tag", () => {
    const html = `<meta name="bc-page-properties" content='{"item_type":"album","item_id":1536701931}'>`;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "1536701931",
      item_type: "album",
    });
  });

  test("extracts album_id from TralbumData JS block as fallback", () => {
    const html = `<script>TralbumData = {"id" : 9876543, "item_type" : "track"}</script>`;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "9876543",
      item_type: "track",
    });
  });

  test("returns null when no ID found", () => {
    expect(extractBandcampEmbedMetadata("<html><body>no id here</body></html>")).toBeNull();
  });

  test("prefers bc-page-properties over TralbumData", () => {
    const html = `
      <meta name="bc-page-properties" content='{"item_type":"album","item_id":111}'>
      <script>TralbumData = {"id" : 999}</script>
    `;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "111",
      item_type: "album",
    });
  });

  test("handles string item_id in bc-page-properties", () => {
    const html = `<meta name="bc-page-properties" content='{"item_type":"album","item_id":"1536701931"}'>`;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "1536701931",
      item_type: "album",
    });
  });

  test("decodes HTML entities in bc-page-properties content", () => {
    const html = `<meta name="bc-page-properties" content="{&quot;item_type&quot;:&quot;album&quot;,&quot;item_id&quot;:1536701931}">`;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "1536701931",
      item_type: "album",
    });
  });

  test("returns null when JSON parses but item_id is absent", () => {
    const html = `<meta name="bc-page-properties" content='{"item_type":"album"}'>`;
    expect(extractBandcampEmbedMetadata(html)).toBeNull();
  });

  test("handles extra attributes between name and content on meta tag", () => {
    const html = `<meta data-react="true" name="bc-page-properties" data-other="x" content='{"item_type":"album","item_id":7777777}'>`;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "7777777",
      item_type: "album",
    });
  });

  test("handles content attribute before name attribute on meta tag", () => {
    const html = `<meta content='{"item_type":"track","item_id":8888888}' name="bc-page-properties">`;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "8888888",
      item_type: "track",
    });
  });

  test("falls back to TralbumData when bc-page-properties has invalid item_id", () => {
    const html = `
      <meta name="bc-page-properties" content='{"item_type":"album"}'>
      <script>TralbumData = {"id" : 9999999, "item_type" : "album"}</script>
    `;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "9999999",
      item_type: "album",
    });
  });

  test("TralbumData fallback works with nested objects", () => {
    const html = `<script>TralbumData = {"nested": {"foo": "bar"}, "id" : 5551234, "item_type" : "album"}</script>`;
    expect(extractBandcampEmbedMetadata(html)).toEqual({
      album_id: "5551234",
      item_type: "album",
    });
  });
});

describe("scrapeUrl bandcamp embedMetadata", () => {
  test("populates embedMetadata when bc-page-properties is present", async () => {
    const html = `<head>
      <meta property="og:title" content="My Album, by Artist" />
      <meta name="bc-page-properties" content='{"item_type":"album","item_id":1234567}'>
    </head>`;
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(html, { headers: { "content-type": "text/html" } }),
    );
    const result = await scrapeUrl("https://artist.bandcamp.com/album/my-album", "bandcamp");
    expect(result?.embedMetadata).toEqual({ album_id: "1234567", item_type: "album" });
    mock.restore();
  });

  test("populates embedMetadata from TralbumData in body when bc-page-properties is absent", async () => {
    const html = `<html><head>
      <meta property="og:title" content="My Album, by Artist" />
    </head><body>
      <script>TralbumData = {"id" : 9876543, "item_type" : "album"}</script>
    </body></html>`;
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(html, { headers: { "content-type": "text/html" } }),
    );
    const result = await scrapeUrl("https://artist.bandcamp.com/album/my-album", "bandcamp");
    expect(result?.embedMetadata).toEqual({ album_id: "9876543", item_type: "album" });
    mock.restore();
  });
});

function mockItunesResponse(results: object[]): Response {
  return new Response(JSON.stringify({ resultCount: results.length, results }), {
    headers: { "content-type": "application/json" },
  });
}

describe("searchAppleMusic", () => {
  test("returns URL for exact title and artist match", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockItunesResponse([
        {
          collectionName: "Blue Lines",
          artistName: "Massive Attack",
          collectionViewUrl: "https://music.apple.com/gb/album/blue-lines/123",
        },
      ]),
    );
    const result = await searchAppleMusic("Blue Lines", "Massive Attack");
    expect(result).toBe("https://music.apple.com/gb/album/blue-lines/123");
    mock.restore();
  });

  test("matches when item title has Wikipedia-style disambiguator", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockItunesResponse([
        {
          collectionName: "Michael Nyman",
          artistName: "Michael Nyman",
          collectionViewUrl: "https://music.apple.com/gb/album/michael-nyman/456",
        },
      ]),
    );
    // DB title is "Michael Nyman (1981 album)" — Apple Music has "Michael Nyman"
    const result = await searchAppleMusic("Michael Nyman (1981 album)", "Michael Nyman");
    expect(result).toBe("https://music.apple.com/gb/album/michael-nyman/456");
    mock.restore();
  });

  test("falls back to first artist-matching result when title does not match", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockItunesResponse([
        {
          collectionName: "Something Else Entirely",
          artistName: "Boards of Canada",
          collectionViewUrl: "https://music.apple.com/album/boc/789",
        },
      ]),
    );
    const result = await searchAppleMusic("Music Has the Right to Children", "Boards of Canada");
    expect(result).toBe("https://music.apple.com/album/boc/789");
    mock.restore();
  });

  test("returns null when iTunes API returns no results", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(mockItunesResponse([]));
    const result = await searchAppleMusic("Obscure Album", "Unknown Artist");
    expect(result).toBeNull();
    mock.restore();
  });

  test("returns null when fetch fails", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));
    const result = await searchAppleMusic("Some Album", "Some Artist");
    expect(result).toBeNull();
    mock.restore();
  });

  test("returns null when response is not ok", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 500 }));
    const result = await searchAppleMusic("Some Album", "Some Artist");
    expect(result).toBeNull();
    mock.restore();
  });

  test("uses trackViewUrl when collectionViewUrl is absent", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockItunesResponse([
        {
          trackName: "A Song",
          artistName: "Artist",
          trackViewUrl: "https://music.apple.com/track/999",
        },
      ]),
    );
    const result = await searchAppleMusic("A Song", "Artist");
    expect(result).toBe("https://music.apple.com/track/999");
    mock.restore();
  });
});

describe("parseNtsOg", () => {
  test("strips '| NTS Radio' suffix from title", () => {
    const og = { ogTitle: "Tropic Of Cancer - 6th March 2026 | NTS Radio" };
    const result = parseNtsOg(og);
    expect(result.potentialTitle).toBe("Tropic Of Cancer - 6th March 2026");
  });

  test("strips '| NTS' suffix from title", () => {
    const og = { ogTitle: "Hessle Audio | NTS" };
    const result = parseNtsOg(og);
    expect(result.potentialTitle).toBe("Hessle Audio");
  });

  test("strips 'on NTS Radio' suffix from title", () => {
    const og = { ogTitle: "Tropic Of Cancer on NTS Radio" };
    const result = parseNtsOg(og);
    expect(result.potentialTitle).toBe("Tropic Of Cancer");
  });

  test("sets itemType to mix", () => {
    const og = { ogTitle: "Some Show | NTS Radio" };
    const result = parseNtsOg(og);
    expect(result.itemType).toBe("mix");
  });

  test("returns og:image as imageUrl", () => {
    const og = {
      ogTitle: "Some Show | NTS Radio",
      ogImage: "https://nts.live/images/show.jpg",
    };
    const result = parseNtsOg(og);
    expect(result.imageUrl).toBe("https://nts.live/images/show.jpg");
  });

  test("handles title with no NTS suffix", () => {
    const og = { ogTitle: "Tropic Of Cancer - 6th March 2026" };
    const result = parseNtsOg(og);
    expect(result.potentialTitle).toBe("Tropic Of Cancer - 6th March 2026");
    expect(result.itemType).toBe("mix");
  });
});

describe("parseCanonicalUrl", () => {
  test("extracts canonical URL from link tag (rel before href)", () => {
    const html = `<link rel="canonical" href="https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026" />`;
    expect(parseCanonicalUrl(html)).toBe(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );
  });

  test("extracts canonical URL from link tag (href before rel)", () => {
    const html = `<link href="https://www.nts.live/shows/my-show/episodes/ep-1" rel="canonical" />`;
    expect(parseCanonicalUrl(html)).toBe("https://www.nts.live/shows/my-show/episodes/ep-1");
  });

  test("returns undefined when no canonical tag is present", () => {
    const html = `<head><title>No canonical here</title></head>`;
    expect(parseCanonicalUrl(html)).toBeUndefined();
  });
});

describe("extractMixcloudEmbedUrl", () => {
  test("extracts Mixcloud URL from widget iframe src", () => {
    const html = `<iframe width="100%" height="60" src="https://www.mixcloud.com/widget/iframe/?hide_cover=1&feed=%2FWorldwideFM%2Fbreakfast-club-coco-coco-maria-24-02-2026%2F" frameborder="0"></iframe>`;
    expect(extractMixcloudEmbedUrl(html)).toBe(
      "https://www.mixcloud.com/WorldwideFM/breakfast-club-coco-coco-maria-24-02-2026/",
    );
  });

  test("appends trailing slash when feed lacks one", () => {
    const html = `<iframe src="https://www.mixcloud.com/widget/iframe/?feed=%2FArtist%2Fshow-name"></iframe>`;
    expect(extractMixcloudEmbedUrl(html)).toBe("https://www.mixcloud.com/Artist/show-name/");
  });

  test("returns null when no Mixcloud iframe is present", () => {
    const html = `<iframe src="https://www.youtube.com/embed/abc123"></iframe>`;
    expect(extractMixcloudEmbedUrl(html)).toBeNull();
  });

  test("returns null when Mixcloud iframe has no feed parameter", () => {
    const html = `<iframe src="https://www.mixcloud.com/widget/iframe/?hide_cover=1"></iframe>`;
    expect(extractMixcloudEmbedUrl(html)).toBeNull();
  });

  test("returns null for empty HTML", () => {
    expect(extractMixcloudEmbedUrl("")).toBeNull();
  });

  test("handles double-quoted src attribute", () => {
    const html = `<iframe src="https://www.mixcloud.com/widget/iframe/?feed=%2FDJ%2Fmy-mix%2F"></iframe>`;
    expect(extractMixcloudEmbedUrl(html)).toBe("https://www.mixcloud.com/DJ/my-mix/");
  });
});

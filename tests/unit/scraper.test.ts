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
  scrapeUrl,
} from "../../server/scraper";

describe("decodeHtmlEntities", () => {
  test("decodes common HTML entities", () => {
    expect(decodeHtmlEntities("Rock &amp; Roll")).toBe("Rock & Roll");
    expect(decodeHtmlEntities("&lt;b&gt;bold&lt;/b&gt;")).toBe("<b>bold</b>");
    expect(decodeHtmlEntities("&quot;quoted&quot;")).toBe('"quoted"');
    expect(decodeHtmlEntities("it&#39;s")).toBe("it's");
    expect(decodeHtmlEntities("it&#x27;s")).toBe("it's");
  });

  test("decodes numeric entities", () => {
    expect(decodeHtmlEntities("&#8211;")).toBe("\u2013");
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

describe("scrapeUrl", () => {
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
    const html = `
      <html><head>
        <meta property="og:title" content="Some Music" />
      </head></html>
    `;
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(html, {
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await scrapeUrl("https://example.com/music", "unknown");
    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe("Some Music");
    mock.restore();
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
});

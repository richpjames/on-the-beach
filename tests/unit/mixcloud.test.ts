import { describe, test, expect, spyOn, mock } from "bun:test";
import { scrapeUrl } from "../../app/scrape";
import {
  extractMixcloudEmbedUrl,
  mixcloudWidgetSrc,
  parseMixcloudJsonLd,
  parseMixcloudOg,
} from "../../adapters/mixcloud/index";

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

  test("finds the one show a page links to, without an iframe", () => {
    const html = `<p>Listen on <a href="https://www.mixcloud.com/DJ/my-mix/">Mixcloud</a>.</p>`;
    expect(extractMixcloudEmbedUrl(html)).toBe("https://www.mixcloud.com/DJ/my-mix/");
  });

  test("finds a show URL written in prose, trailing punctuation and all", () => {
    expect(extractMixcloudEmbedUrl(`<p>Listen at https://www.mixcloud.com/DJ/my-mix/.</p>`)).toBe(
      "https://www.mixcloud.com/DJ/my-mix/",
    );
    expect(
      extractMixcloudEmbedUrl(`<p>See https://www.mixcloud.com/DJ/my-mix/, plus more.</p>`),
    ).toBe("https://www.mixcloud.com/DJ/my-mix/");
    expect(extractMixcloudEmbedUrl(`<p>(https://www.mixcloud.com/DJ/my-mix/)</p>`)).toBe(
      "https://www.mixcloud.com/DJ/my-mix/",
    );
  });

  test("ignores entity-encoded query suffixes on a show link", () => {
    const html = `<a href="https://www.mixcloud.com/DJ/my-mix/?commentId=1&amp;utm_source=x">show</a>`;
    expect(extractMixcloudEmbedUrl(html)).toBe("https://www.mixcloud.com/DJ/my-mix/");
  });

  test("finds a widget player streamed as escaped JSON, without an iframe tag", () => {
    const html = `<script>self.__next_f.push([1,"{\\"player\\":\\"https:\\/\\/www.mixcloud.com\\/widget\\/iframe\\/?feed=%2FDJ%2Fmy-mix%2F\\"}"])</script>`;
    expect(extractMixcloudEmbedUrl(html)).toBe("https://www.mixcloud.com/DJ/my-mix/");
  });

  test("finds a JSON widget feed that follows other parameters", () => {
    const html = `<script>{"embed":"https://www.mixcloud.com/widget/iframe/?hide_cover=1&feed=%2FDJ%2Fmy-mix%2F"}</script>`;
    expect(extractMixcloudEmbedUrl(html)).toBe("https://www.mixcloud.com/DJ/my-mix/");
  });

  test("appends the trailing slash to a JSON widget feed that lacks one", () => {
    const html = `<script>{"embed":"https://www.mixcloud.com/widget/iframe/?feed=%2FDJ%2Fmy-mix"}</script>`;
    expect(extractMixcloudEmbedUrl(html)).toBe("https://www.mixcloud.com/DJ/my-mix/");
  });

  test("ignores a JSON widget feed that is malformed or names no show", () => {
    expect(
      extractMixcloudEmbedUrl(
        `<script>{"embed":"https://www.mixcloud.com/widget/iframe/?feed=%2FDJ%2Fmy-mix%2"}</script>`,
      ),
    ).toBeNull();
    expect(
      extractMixcloudEmbedUrl(
        `<script>{"embed":"https://www.mixcloud.com/widget/iframe/?feed=%2FDJ%2F"}</script>`,
      ),
    ).toBeNull();
  });

  test("finds a show URL inside escaped-quote JSON, as SPAs stream it", () => {
    const html = `<script>self.__next_f.push([1,"{\\"url\\":\\"https://www.mixcloud.com/worldwidefm/santa-leticia-woh-2026-22-08-26/\\",\\"player\\":\\"https://www.mixcloud.com/worldwidefm/santa-leticia-woh-2026-22-08-26/\\"}"])</script>`;
    expect(extractMixcloudEmbedUrl(html)).toBe(
      "https://www.mixcloud.com/worldwidefm/santa-leticia-woh-2026-22-08-26/",
    );
  });

  test("finds a show URL whose slashes are escaped too", () => {
    const html = `<script>var data = {"url":"https:\\/\\/www.mixcloud.com\\/DJ\\/my-mix\\/"};</script>`;
    expect(extractMixcloudEmbedUrl(html)).toBe("https://www.mixcloud.com/DJ/my-mix/");
  });

  test("counts the same show once however often it is named", () => {
    const html = `
      <a href="https://www.mixcloud.com/WorldwideFM/my-show/">My Show</a>
      <script>{"player":"https://www.mixcloud.com/worldwidefm/my-show/"}</script>
      <a href="https://www.mixcloud.com/worldwidefm/my-show/?commentId=123">comment</a>
    `;
    expect(extractMixcloudEmbedUrl(html)).toBe("https://www.mixcloud.com/WorldwideFM/my-show/");
  });

  test("returns null when the page names several different shows", () => {
    const html = `
      <a href="https://www.mixcloud.com/DJ/first-mix/">First</a>
      <a href="https://www.mixcloud.com/DJ/second-mix/">Second</a>
    `;
    expect(extractMixcloudEmbedUrl(html)).toBeNull();
  });

  test("ignores profile pages, deep pages and Mixcloud's own pages", () => {
    expect(
      extractMixcloudEmbedUrl(`<a href="https://www.mixcloud.com/DJ/">Profile</a>`),
    ).toBeNull();
    expect(
      extractMixcloudEmbedUrl(
        `<a href="https://www.mixcloud.com/DJ/my-mix/comments/">Comments</a>`,
      ),
    ).toBeNull();
    expect(
      extractMixcloudEmbedUrl(`<a href="https://www.mixcloud.com/discover/jazz/">Discover</a>`),
    ).toBeNull();
  });

  test("a show plus its own comments page is still one show", () => {
    const html = `
      <a href="https://www.mixcloud.com/DJ/my-mix/">My Mix</a>
      <a href="https://www.mixcloud.com/DJ/my-mix/comments/">Comments</a>
    `;
    expect(extractMixcloudEmbedUrl(html)).toBe("https://www.mixcloud.com/DJ/my-mix/");
  });
});

describe("mixcloudWidgetSrc", () => {
  test("points the widget at the show's path", () => {
    expect(mixcloudWidgetSrc("https://www.mixcloud.com/nozwon/light-sleeper-radio-021/")).toBe(
      "https://www.mixcloud.com/widget/iframe/?hide_cover=1&hide_artwork=1&feed=%2Fnozwon%2Flight-sleeper-radio-021%2F",
    );
  });

  test("returns null without a Mixcloud URL to embed", () => {
    expect(mixcloudWidgetSrc(null)).toBeNull();
    expect(mixcloudWidgetSrc(undefined)).toBeNull();
    expect(mixcloudWidgetSrc("")).toBeNull();
    expect(mixcloudWidgetSrc("not a url")).toBeNull();
    expect(mixcloudWidgetSrc("https://soundcloud.com/nozwon/a-mix")).toBeNull();
  });
});

describe("scrapeUrl: mixcloud", () => {
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

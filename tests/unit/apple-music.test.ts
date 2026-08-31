import { describe, test, expect, spyOn, mock, beforeEach, afterEach } from "bun:test";
import { scrapeUrl } from "../../server/scraper";
import { parseAppleMusicOg, searchAppleMusic } from "../../server/apple-music";

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

function mockItunesResponse(results: object[]): Response {
  return new Response(JSON.stringify({ resultCount: results.length, results }), {
    headers: { "content-type": "application/json" },
  });
}

describe("searchAppleMusic", () => {
  // Both lookup paths behind searchAppleMusic no-op under
  // OTB_DISABLE_EXTERNAL_LOOKUPS, so a stray copy of the flag — left in the
  // shared process by whichever test file `bun test` happened to run first —
  // makes every assertion here read `undefined`. Guarantee it's off for these
  // tests rather than depending on file order.
  let flagBefore: string | undefined;

  beforeEach(() => {
    flagBefore = process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  });

  afterEach(() => {
    if (flagBefore === undefined) delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    else process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = flagBefore;
  });

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
    expect(result?.url).toBe("https://music.apple.com/gb/album/blue-lines/123");
    mock.restore();
  });

  test("returns the cover artwork, upscaled to 1200x1200, alongside the URL", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockItunesResponse([
        {
          collectionName: "Blue Lines",
          artistName: "Massive Attack",
          collectionViewUrl: "https://music.apple.com/gb/album/blue-lines/123",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/abc/100x100bb.jpg",
        },
      ]),
    );
    const result = await searchAppleMusic("Blue Lines", "Massive Attack");
    expect(result).toEqual({
      url: "https://music.apple.com/gb/album/blue-lines/123",
      artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/Music/abc/1200x1200bb.jpg",
    });
    mock.restore();
  });

  test("returns a null artworkUrl when the iTunes result has no artwork", async () => {
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
    expect(result?.artworkUrl).toBeNull();
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
    expect(result?.url).toBe("https://music.apple.com/gb/album/michael-nyman/456");
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
    expect(result?.url).toBe("https://music.apple.com/album/boc/789");
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
    expect(result?.url).toBe("https://music.apple.com/track/999");
    mock.restore();
  });

  test("strips uo and i query params from iTunes API URLs", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockItunesResponse([
        {
          collectionName: "Blue Lines",
          artistName: "Massive Attack",
          collectionViewUrl: "https://music.apple.com/gb/album/blue-lines/123?uo=4",
        },
      ]),
    );
    const result = await searchAppleMusic("Blue Lines", "Massive Attack");
    expect(result?.url).toBe("https://music.apple.com/gb/album/blue-lines/123");
    mock.restore();
  });

  test("strips track-specific ?i= param from trackViewUrl", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockItunesResponse([
        {
          trackName: "A Song",
          artistName: "Artist",
          trackViewUrl: "https://music.apple.com/us/album/name/456?i=789&uo=4",
        },
      ]),
    );
    const result = await searchAppleMusic("A Song", "Artist");
    expect(result?.url).toBe("https://music.apple.com/us/album/name/456");
    mock.restore();
  });
});

describe("scrapeUrl: apple_music", () => {
  const URL = "https://music.apple.com/gb/album/random-access-memories/123456789";

  /** Apple's oEmbed endpoint — the first rung of the ladder. */
  function oEmbedResponse(body: object, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  /** The iTunes lookup-by-id endpoint — the second rung. */
  function lookupResponse(results: object[], status = 200): Response {
    return new Response(JSON.stringify({ results }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  test("returns oEmbed metadata alone when it is already complete", async () => {
    // Complete = artist + title + image. The ladder should stop here and never
    // reach for the lookup or the page.
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      oEmbedResponse({
        title: "Random Access Memories",
        author_name: "Daft Punk",
        thumbnail_url: "https://is1-ssl.mzstatic.com/image/600x600bb.jpg",
      }),
    );

    const result = await scrapeUrl(URL, "apple_music");

    expect(result).not.toBeNull();
    expect(result!.potentialTitle).toBe("Random Access Memories");
    expect(result!.potentialArtist).toBe("Daft Punk");
    // Artwork is upscaled on the way through.
    expect(result!.imageUrl).toBe("https://is1-ssl.mzstatic.com/image/1200x1200bb.jpg");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    mock.restore();
  });

  test("falls back to the iTunes lookup when oEmbed is incomplete", async () => {
    // oEmbed answers, but without an artist it isn't complete, so the ladder
    // continues to the lookup rather than returning early.
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      oEmbedResponse({
        title: "Random Access Memories",
        thumbnail_url: "https://is1-ssl.mzstatic.com/image/600x600bb.jpg",
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      lookupResponse([
        {
          collectionName: "Random Access Memories (Deluxe)",
          artistName: "Daft Punk",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/100x100bb.jpg",
        },
      ]),
    );

    const result = await scrapeUrl(URL, "apple_music");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
    // The lookup backfills the field oEmbed left out.
    expect(result!.potentialArtist).toBe("Daft Punk");
    // Precedence: the merge order is (oEmbed, lookup, page OG) and `firstDefined`
    // takes the first non-empty value, so oEmbed wins every field it supplied.
    // The lookup's "(Deluxe)" title loses. This pins that ordering — it matters
    // most for deep-linked tracks (`?i=`), where the lookup returns the track's
    // *album* via collectionName while oEmbed returns the song's own title.
    expect(result!.potentialTitle).toBe("Random Access Memories");
    expect(result!.imageUrl).toBe("https://is1-ssl.mzstatic.com/image/1200x1200bb.jpg");
    mock.restore();
  });
});

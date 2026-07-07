import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import { searchAppleMusicCatalog } from "../../server/apple-music-catalog";
import { searchAppleMusic } from "../../server/scraper";
import { resetDeveloperTokenCache } from "../../server/apple-music-token";

const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

function configure(): void {
  process.env.APPLE_MUSIC_TEAM_ID = "TEAM123456";
  process.env.APPLE_MUSIC_KEY_ID = "KEY7654321";
  process.env.APPLE_MUSIC_PRIVATE_KEY = privatePem;
  process.env.APPLE_MUSIC_STOREFRONT = "gb";
  resetDeveloperTokenCache();
}

function unconfigure(): void {
  delete process.env.APPLE_MUSIC_TEAM_ID;
  delete process.env.APPLE_MUSIC_KEY_ID;
  delete process.env.APPLE_MUSIC_PRIVATE_KEY;
  delete process.env.APPLE_MUSIC_STOREFRONT;
  delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  resetDeveloperTokenCache();
}

interface CatalogItem {
  name: string;
  artistName: string;
  url: string;
}

function catalogResponse(albums: CatalogItem[], songs: CatalogItem[] = []): Response {
  const toData = (items: CatalogItem[]) => ({
    data: items.map((attributes) => ({ attributes })),
  });
  return new Response(
    JSON.stringify({ results: { albums: toData(albums), songs: toData(songs) } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("searchAppleMusicCatalog", () => {
  beforeEach(unconfigure);
  afterEach(() => {
    unconfigure();
    mock.restore();
  });

  test("returns null when Apple Music is not configured (no fetch)", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const result = await searchAppleMusicCatalog("Blue Lines", "Massive Attack");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns null under OTB_DISABLE_EXTERNAL_LOOKUPS even when configured", async () => {
    configure();
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const fetchSpy = spyOn(globalThis, "fetch");
    const result = await searchAppleMusicCatalog("Blue Lines", "Massive Attack");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("queries the catalogue with a bearer token and returns an exact match", async () => {
    configure();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      catalogResponse([
        {
          name: "Blue Lines",
          artistName: "Massive Attack",
          url: "https://music.apple.com/gb/album/blue-lines/123",
        },
      ]),
    );

    const result = await searchAppleMusicCatalog("Blue Lines", "Massive Attack");
    expect(result).toBe("https://music.apple.com/gb/album/blue-lines/123");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://api.music.apple.com/v1/catalog/gb/search");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Bearer .+/);
  });

  test("matches a Wikipedia-style disambiguated title", async () => {
    configure();
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      catalogResponse([
        {
          name: "Michael Nyman",
          artistName: "Michael Nyman",
          url: "https://music.apple.com/gb/album/michael-nyman/456",
        },
      ]),
    );
    const result = await searchAppleMusicCatalog("Michael Nyman (1981 album)", "Michael Nyman");
    expect(result).toBe("https://music.apple.com/gb/album/michael-nyman/456");
  });

  test("prefers albums over songs", async () => {
    configure();
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      catalogResponse(
        [
          {
            name: "Discovery",
            artistName: "Daft Punk",
            url: "https://music.apple.com/gb/album/discovery/1",
          },
        ],
        [
          {
            name: "Discovery",
            artistName: "Daft Punk",
            url: "https://music.apple.com/gb/song/x/2",
          },
        ],
      ),
    );
    const result = await searchAppleMusicCatalog("Discovery", "Daft Punk");
    expect(result).toBe("https://music.apple.com/gb/album/discovery/1");
  });

  test("returns null when nothing matches the artist", async () => {
    configure();
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      catalogResponse([
        {
          name: "Blue Lines",
          artistName: "Someone Else",
          url: "https://music.apple.com/gb/album/blue-lines/999",
        },
      ]),
    );
    const result = await searchAppleMusicCatalog("Blue Lines", "Massive Attack");
    // Pass 3 falls back to the first artist-matching result; there is none here,
    // and the title matches but the artist does not, so passes 1/2 also skip it.
    expect(result).toBeNull();
  });

  test("returns null on an empty catalogue result", async () => {
    configure();
    spyOn(globalThis, "fetch").mockResolvedValueOnce(catalogResponse([], []));
    const result = await searchAppleMusicCatalog("Nothing", "Nobody");
    expect(result).toBeNull();
  });

  test("returns null when the API responds non-OK", async () => {
    configure();
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 500 }));
    const result = await searchAppleMusicCatalog("Blue Lines", "Massive Attack");
    expect(result).toBeNull();
  });

  test("returns null when fetch rejects", async () => {
    configure();
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    const result = await searchAppleMusicCatalog("Blue Lines", "Massive Attack");
    expect(result).toBeNull();
  });
});

describe("searchAppleMusic orchestration", () => {
  beforeEach(unconfigure);
  afterEach(() => {
    unconfigure();
    mock.restore();
  });

  test("prefers the catalogue API over iTunes when configured", async () => {
    configure();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      catalogResponse([
        {
          name: "Blue Lines",
          artistName: "Massive Attack",
          url: "https://music.apple.com/gb/album/blue-lines/from-catalog",
        },
      ]),
    );

    const result = await searchAppleMusic("Blue Lines", "Massive Attack");
    expect(result).toBe("https://music.apple.com/gb/album/blue-lines/from-catalog");
    // Only the catalogue endpoint was hit — no iTunes fallback fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("api.music.apple.com");
  });

  test("falls back to the iTunes search when the catalogue finds nothing", async () => {
    configure();
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(catalogResponse([], []))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                collectionName: "Blue Lines",
                artistName: "Massive Attack",
                collectionViewUrl: "https://music.apple.com/gb/album/blue-lines/from-itunes",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const result = await searchAppleMusic("Blue Lines", "Massive Attack");
    expect(result).toBe("https://music.apple.com/gb/album/blue-lines/from-itunes");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toContain("itunes.apple.com");
  });
});

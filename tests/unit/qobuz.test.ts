import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseQobuzUrl, scrapeQobuz } from "../../adapters/qobuz/scrape";
import { searchQobuz } from "../../adapters/qobuz/search";
import { resetQobuzAuthCache } from "../../adapters/qobuz/index";

function unconfigure(): void {
  delete process.env.QOBUZ_APP_ID;
  delete process.env.QOBUZ_EMAIL;
  delete process.env.QOBUZ_PASSWORD;
  delete process.env.QOBUZ_USER_AUTH_TOKEN;
  delete process.env.QOBUZ_STOREFRONT;
  delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  resetQobuzAuthCache();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ALBUM = {
  id: "5099749522428",
  title: "Kind Of Blue",
  artist: { id: 6760, name: "Miles Davis" },
  label: { id: 4592, name: "Columbia" },
  genre: { name: "Jazz" },
  image: {
    small: "https://static.qobuz.com/images/covers/28/24/5099749522428_230.jpg",
    large: "https://static.qobuz.com/images/covers/28/24/5099749522428_600.jpg",
  },
  released_at: -327459600,
  release_date_original: "1959-08-17",
  release_type: "album",
  url: "https://www.qobuz.com/fr-fr/album/kind-of-blue-miles-davis/5099749522428",
};

function searchResponse(items: Array<Record<string, unknown>>): Response {
  return jsonResponse({ query: "kind of blue", albums: { items, total: items.length } });
}

beforeEach(unconfigure);
afterEach(() => {
  unconfigure();
  mock.restore();
});

describe("parseQobuzUrl", () => {
  test("reads the kind and id out of a store URL", () => {
    expect(
      parseQobuzUrl("https://www.qobuz.com/us-en/album/kind-of-blue-miles-davis/5099749522428"),
    ).toEqual({ kind: "album", id: "5099749522428" });
  });

  test("interpreter pages are artists", () => {
    expect(parseQobuzUrl("https://www.qobuz.com/fr-fr/interpreter/miles-davis/6760")).toEqual({
      kind: "artist",
      id: "6760",
    });
  });

  test("reads player share links", () => {
    expect(parseQobuzUrl("https://play.qobuz.com/album/5099749522428")).toEqual({
      kind: "album",
      id: "5099749522428",
    });
    expect(parseQobuzUrl("https://play.qobuz.com/track/13176083")).toEqual({
      kind: "track",
      id: "13176083",
    });
  });

  test("a store artist URL parses the same as an interpreter one", () => {
    expect(parseQobuzUrl("https://www.qobuz.com/us-en/artist/miles-davis/6760")).toEqual({
      kind: "artist",
      id: "6760",
    });
  });

  test("pages that name no resource we model parse to null", () => {
    expect(parseQobuzUrl("https://www.qobuz.com/us-en/label/columbia/4592")).toBeNull();
    expect(parseQobuzUrl("https://www.qobuz.com/us-en/album/")).toBeNull();
    expect(parseQobuzUrl("https://example.com/album/x/123")).toBeNull();
    expect(parseQobuzUrl("not a url")).toBeNull();
  });
});

describe("scrapeQobuz", () => {
  test("scrapes an album through album/get, anonymously", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(ALBUM));

    const result = await scrapeQobuz(
      "https://www.qobuz.com/us-en/album/kind-of-blue-miles-davis/5099749522428",
      5000,
    );

    expect(result).toEqual({
      potentialArtist: "Miles Davis",
      potentialTitle: "Kind Of Blue",
      itemType: "album",
      imageUrl: "https://static.qobuz.com/images/covers/28/24/5099749522428_max.jpg",
      label: "Columbia",
      genre: "Jazz",
      releaseDate: "1959-08-17",
      year: 1959,
      canonicalUrl: "https://www.qobuz.com/gb-en/album/kind-of-blue-miles-davis/5099749522428",
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://www.qobuz.com/api.json/0.2/album/get?");
    expect(url).toContain("album_id=5099749522428");
    expect(url).toContain("app_id=");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-App-Id"]).toBeTruthy();
    expect(headers["X-User-Auth-Token"]).toBeUndefined();
  });

  test("scrapes a player share link the same way", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(ALBUM));
    const result = await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);
    expect(result?.potentialTitle).toBe("Kind Of Blue");
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("album_id=5099749522428");
  });

  test("rewrites the canonical URL to the configured storefront", async () => {
    process.env.QOBUZ_STOREFRONT = "us-en";
    spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(ALBUM));
    const result = await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);
    expect(result?.canonicalUrl).toBe(
      "https://www.qobuz.com/us-en/album/kind-of-blue-miles-davis/5099749522428",
    );
  });

  test("scrapes a track through track/get, with the album's cover", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        id: 13176083,
        title: "So What",
        performer: { name: "Miles Davis" },
        release_date_original: "1959-08-17",
        album: {
          id: "5099749522428",
          title: "Kind Of Blue",
          label: { name: "Columbia" },
          image: ALBUM.image,
        },
      }),
    );

    const result = await scrapeQobuz("https://play.qobuz.com/track/13176083", 5000);
    expect(result).toMatchObject({
      potentialArtist: "Miles Davis",
      potentialTitle: "So What",
      itemType: "track",
      imageUrl: "https://static.qobuz.com/images/covers/28/24/5099749522428_max.jpg",
      label: "Columbia",
      releaseDate: "1959-08-17",
    });
    expect(result?.canonicalUrl).toBeUndefined();
  });

  test("scrapes an artist page to the artist alone", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        id: 6760,
        name: "Miles Davis",
        image: {
          large: "https://static.qobuz.com/images/artists/covers/large/33a9c9bc.jpg",
        },
      }),
    );

    const result = await scrapeQobuz(
      "https://www.qobuz.com/us-en/interpreter/miles-davis/6760",
      5000,
    );
    expect(result).toEqual({
      potentialArtist: "Miles Davis",
      imageUrl: "https://static.qobuz.com/images/artists/covers/large/33a9c9bc.jpg",
    });
  });

  test("scrapes a playlist as a mix", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        id: 4458346,
        name: "Lucinda Williams",
        image: {
          rectangle: "https://static.qobuz.com/images/playlists/4458346_rectangle.jpg",
          covers: ["https://static.qobuz.com/images/covers/lb/z8/g0xt6qab8z8lb_300.jpg"],
        },
      }),
    );

    const result = await scrapeQobuz("https://play.qobuz.com/playlist/4458346", 5000);
    expect(result).toEqual({
      potentialTitle: "Lucinda Williams",
      itemType: "mix",
      imageUrl: "https://static.qobuz.com/images/playlists/4458346_rectangle.jpg",
    });
  });

  test("falls back to the first cover when a playlist has no rectangle", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        id: 4458346,
        name: "Lucinda Williams",
        image: { covers: ["https://static.qobuz.com/images/covers/lb/z8/g0xt6qab8z8lb_300.jpg"] },
      }),
    );
    const result = await scrapeQobuz("https://play.qobuz.com/playlist/4458346", 5000);
    expect(result?.imageUrl).toBe(
      "https://static.qobuz.com/images/covers/lb/z8/g0xt6qab8z8lb_max.jpg",
    );
  });

  test("derives the year from released_at when no full date is named", async () => {
    const { release_date_original: _omitted, ...noDate } = ALBUM;
    spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(noDate));
    const result = await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);
    expect(result?.releaseDate).toBeUndefined();
    expect(result?.year).toBe(1959);
  });

  test("a URL naming no resource we model costs no fetch", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const result = await scrapeQobuz("https://www.qobuz.com/us-en/label/columbia/4592", 5000);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns null when the API responds non-OK", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 500 }));
    const result = await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);
    expect(result).toBeNull();
  });

  test("returns null when fetch rejects", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    const result = await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);
    expect(result).toBeNull();
  });
});

describe("searchQobuz", () => {
  const HIT = {
    id: "5099749522428",
    title: "Kind Of Blue",
    artist: { name: "Miles Davis" },
    label: { name: "Columbia" },
    image: ALBUM.image,
    url: "https://www.qobuz.com/fr-fr/album/kind-of-blue-miles-davis/5099749522428",
  };

  test("returns null under OTB_DISABLE_EXTERNAL_LOOKUPS (no fetch)", async () => {
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const fetchSpy = spyOn(globalThis, "fetch");
    const result = await searchQobuz("Kind Of Blue", "Miles Davis");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("searches the album catalogue and returns an exact match", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(searchResponse([HIT]));

    const result = await searchQobuz("Kind Of Blue", "Miles Davis");
    expect(result).toEqual({
      url: "https://www.qobuz.com/gb-en/album/kind-of-blue-miles-davis/5099749522428",
      artworkUrl: "https://static.qobuz.com/images/covers/28/24/5099749522428_max.jpg",
      label: "Columbia",
    });

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain("catalog/search?");
    expect(url).toContain("type=albums");
    expect(url).toContain("query=Miles+Davis+Kind+Of+Blue");
  });

  test("matches a Wikipedia-style disambiguated title", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([{ ...HIT, title: "Kind Of Blue (1959 album)" }]),
    );
    // The query is the bare title; the result carries the disambiguator.
    const result = await searchQobuz("Kind Of Blue", "Miles Davis");
    expect(result?.url).toContain("/album/kind-of-blue-miles-davis/5099749522428");
  });

  test("returns null when the artist does not match", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([{ ...HIT, artist: { name: "Someone Else" } }]),
    );
    const result = await searchQobuz("Kind Of Blue", "Miles Davis");
    expect(result).toBeNull();
  });

  test("returns null when only the artist matches — their other release is not this one", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([{ ...HIT, title: "Bitches Brew" }]),
    );
    const result = await searchQobuz("Kind Of Blue", "Miles Davis");
    expect(result).toBeNull();
  });

  test("returns null on an empty catalogue result", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(searchResponse([]));
    const result = await searchQobuz("Nothing", "Nobody");
    expect(result).toBeNull();
  });

  test("returns null when the API responds non-OK", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 500 }));
    const result = await searchQobuz("Kind Of Blue", "Miles Davis");
    expect(result).toBeNull();
  });

  test("returns null when fetch rejects", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    const result = await searchQobuz("Kind Of Blue", "Miles Davis");
    expect(result).toBeNull();
  });
});

describe("Qobuz account authentication", () => {
  test("an env-supplied token rides along without a login", async () => {
    process.env.QOBUZ_USER_AUTH_TOKEN = "token-from-browser";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(ALBUM));

    await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-User-Auth-Token"]).toBe(
      "token-from-browser",
    );
  });

  test("email and password log in once, and the token is cached", async () => {
    process.env.QOBUZ_EMAIL = "listener@example.com";
    process.env.QOBUZ_PASSWORD = "secret";
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ user_auth_token: "login-token" }))
      .mockResolvedValueOnce(jsonResponse(ALBUM))
      .mockResolvedValueOnce(jsonResponse(ALBUM));

    await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);
    await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("user/login?");
    expect(fetchSpy.mock.calls[0]?.[0]).toContain(encodeURIComponent("listener@example.com"));
    for (const call of fetchSpy.mock.calls.slice(1)) {
      const [, init] = call as [string, RequestInit];
      expect((init.headers as Record<string, string>)["X-User-Auth-Token"]).toBe("login-token");
    }
  });

  test("a failed login still asks anonymously", async () => {
    process.env.QOBUZ_EMAIL = "listener@example.com";
    process.env.QOBUZ_PASSWORD = "wrong";
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(ALBUM));

    const result = await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);
    expect(result?.potentialTitle).toBe("Kind Of Blue");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-User-Auth-Token"]).toBeUndefined();
  });

  test("a 401 on a cached token re-logs in and retries once", async () => {
    process.env.QOBUZ_EMAIL = "listener@example.com";
    process.env.QOBUZ_PASSWORD = "secret";
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ user_auth_token: "stale-token" }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ user_auth_token: "fresh-token" }))
      .mockResolvedValueOnce(jsonResponse(ALBUM));

    const result = await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);
    expect(result?.potentialTitle).toBe("Kind Of Blue");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const [, init] = fetchSpy.mock.calls[3] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-User-Auth-Token"]).toBe("fresh-token");
  });

  test("a 401 on an env-supplied token is not retried", async () => {
    process.env.QOBUZ_USER_AUTH_TOKEN = "expired";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 401 }),
    );
    const result = await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("concurrent requests share one login", async () => {
    process.env.QOBUZ_EMAIL = "listener@example.com";
    process.env.QOBUZ_PASSWORD = "secret";
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      return url.includes("user/login")
        ? jsonResponse({ user_auth_token: "login-token" })
        : jsonResponse(ALBUM);
    });

    const results = await Promise.all([
      scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000),
      scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000),
      scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000),
    ]);

    expect(results.every((r) => r?.potentialTitle === "Kind Of Blue")).toBe(true);
    const loginCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("user/login"));
    expect(loginCalls).toHaveLength(1);
  });

  test("a failed login is remembered — the next request asks anonymously without retrying", async () => {
    process.env.QOBUZ_EMAIL = "listener@example.com";
    process.env.QOBUZ_PASSWORD = "wrong";
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      return url.includes("user/login") ? new Response(null, { status: 401 }) : jsonResponse(ALBUM);
    });

    await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);
    const second = await scrapeQobuz("https://play.qobuz.com/album/5099749522428", 5000);

    expect(second?.potentialTitle).toBe("Kind Of Blue");
    const loginCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("user/login"));
    expect(loginCalls).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

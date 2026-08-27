import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  DiscogsHttpError,
  fetchDiscogsRelease,
  parseDiscogsRelease,
  searchReleases,
} from "../../server/discogs";

function makeDiscogsResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MASTER_FIXTURE = {
  id: 1033558,
  title: "Rotten Riddims Vol. 1",
  year: 2014,
  artists: [{ name: "Dot Rotten", id: 1234 }],
  genres: ["Electronic"],
  styles: ["Grime", "UK Funky"],
  images: [
    {
      type: "primary",
      uri: "https://img.discogs.com/cover.jpg",
      uri150: "https://img.discogs.com/cover150.jpg",
    },
    { type: "secondary", uri: "https://img.discogs.com/back.jpg" },
  ],
};

const RELEASE_FIXTURE = {
  id: 5678,
  title: "Some EP",
  year: 2016,
  artists: [{ name: "Test Artist (2)" }],
  genres: ["Electronic"],
  styles: ["Techno"],
  country: "UK",
  labels: [{ name: "Test Label", catno: "TL001" }],
  formats: [{ name: "Vinyl", qty: "1", descriptions: ["EP", '12"'] }],
  images: [
    { type: "secondary", uri: "https://img.discogs.com/secondary.jpg" },
    { type: "primary", uri: "https://img.discogs.com/primary.jpg" },
  ],
};

describe("parseDiscogsRelease", () => {
  test("parses master release data", () => {
    const result = parseDiscogsRelease(MASTER_FIXTURE);
    expect(result).toEqual({
      potentialTitle: "Rotten Riddims Vol. 1",
      potentialArtist: "Dot Rotten",
      imageUrl: "https://img.discogs.com/cover.jpg",
      itemType: "album",
      year: 2014,
      genre: "Grime",
    });
  });

  test("strips disambiguation suffix from artist name", () => {
    const data = { title: "Test", artists: [{ name: "Test Artist (2)" }] };
    const result = parseDiscogsRelease(data);
    expect(result?.potentialArtist).toBe("Test Artist");
  });

  test("picks primary image when available", () => {
    const result = parseDiscogsRelease(RELEASE_FIXTURE);
    expect(result?.imageUrl).toBe("https://img.discogs.com/primary.jpg");
  });

  test("falls back to first image when no primary image", () => {
    const data = {
      title: "Test",
      images: [
        { type: "secondary", uri: "https://img.discogs.com/first.jpg" },
        { type: "secondary", uri: "https://img.discogs.com/second.jpg" },
      ],
    };
    const result = parseDiscogsRelease(data);
    expect(result?.imageUrl).toBe("https://img.discogs.com/first.jpg");
  });

  test("infers EP itemType from formats", () => {
    const result = parseDiscogsRelease(RELEASE_FIXTURE);
    expect(result?.itemType).toBe("ep");
  });

  test("infers single itemType from formats", () => {
    const data = {
      title: "Test",
      formats: [{ name: "Vinyl", descriptions: ["Single", '7"'] }],
    };
    const result = parseDiscogsRelease(data);
    expect(result?.itemType).toBe("single");
  });

  test("infers compilation itemType from formats", () => {
    const data = {
      title: "Test",
      formats: [{ name: "CD", descriptions: ["Compilation"] }],
    };
    const result = parseDiscogsRelease(data);
    expect(result?.itemType).toBe("compilation");
  });

  test("defaults to album when formats is absent", () => {
    const data = { title: "Test", artists: [{ name: "Artist" }] };
    const result = parseDiscogsRelease(data);
    expect(result?.itemType).toBe("album");
  });

  test("prefers styles over genres for genre field", () => {
    const data = {
      title: "Test",
      genres: ["Electronic"],
      styles: ["Grime"],
    };
    const result = parseDiscogsRelease(data);
    expect(result?.genre).toBe("Grime");
  });

  test("falls back to genre when styles is empty", () => {
    const data = {
      title: "Test",
      genres: ["Electronic"],
      styles: [],
    };
    const result = parseDiscogsRelease(data);
    expect(result?.genre).toBe("Electronic");
  });

  test("omits year when year is 0 or missing", () => {
    expect(parseDiscogsRelease({ title: "Test", year: 0 })?.year).toBeUndefined();
    expect(parseDiscogsRelease({ title: "Test" })?.year).toBeUndefined();
  });

  test("returns null for non-object input", () => {
    expect(parseDiscogsRelease(null)).toBeNull();
    expect(parseDiscogsRelease("string")).toBeNull();
    expect(parseDiscogsRelease([])).toBeNull();
  });

  test("returns null when no title, artist, or image", () => {
    expect(parseDiscogsRelease({ year: 2020 })).toBeNull();
  });
});

describe("fetchDiscogsRelease", () => {
  afterEach(() => {
    mock.restore();
  });

  test("fetches master release from correct API endpoint", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeDiscogsResponse(MASTER_FIXTURE),
    );

    await fetchDiscogsRelease(
      "https://www.discogs.com/master/1033558-Dot-Rotten-Rotten-Riddims-Vol-1",
      5000,
    );

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.discogs.com/masters/1033558");
  });

  test("fetches regular release from correct API endpoint", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeDiscogsResponse(RELEASE_FIXTURE),
    );

    await fetchDiscogsRelease("https://www.discogs.com/release/5678-Some-Release", 5000);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.discogs.com/releases/5678");
  });

  test("sends correct User-Agent header", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeDiscogsResponse(MASTER_FIXTURE),
    );

    await fetchDiscogsRelease("https://www.discogs.com/master/1033558", 5000);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("User-Agent")).toContain("on-the-beach");
  });

  test("returns parsed metadata on success", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(makeDiscogsResponse(MASTER_FIXTURE));

    const result = await fetchDiscogsRelease("https://www.discogs.com/master/1033558", 5000);

    expect(result).toEqual({
      potentialTitle: "Rotten Riddims Vol. 1",
      potentialArtist: "Dot Rotten",
      imageUrl: "https://img.discogs.com/cover.jpg",
      itemType: "album",
      year: 2014,
      genre: "Grime",
    });
  });

  test("returns null for non-discogs URL", async () => {
    const result = await fetchDiscogsRelease("https://bandcamp.com/album/foo", 5000);
    expect(result).toBeNull();
  });

  test("returns null on non-200 response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeDiscogsResponse({ message: "Not Found" }, 404),
    );

    const result = await fetchDiscogsRelease("https://www.discogs.com/master/1033558", 5000);
    expect(result).toBeNull();
  });

  test("returns null when fetch throws", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));

    const result = await fetchDiscogsRelease("https://www.discogs.com/master/1033558", 5000);
    expect(result).toBeNull();
  });

  test("resolves sell/item URL via marketplace listing", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeDiscogsResponse({ release: { id: 5678 } }))
      .mockResolvedValueOnce(makeDiscogsResponse(RELEASE_FIXTURE));

    const result = await fetchDiscogsRelease("https://www.discogs.com/sell/item/4090403029", 5000);

    const [listingUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(listingUrl).toBe("https://api.discogs.com/marketplace/listings/4090403029");

    const [releaseUrl] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(releaseUrl).toBe("https://api.discogs.com/releases/5678");

    expect(result).toEqual({
      potentialTitle: "Some EP",
      potentialArtist: "Test Artist",
      imageUrl: "https://img.discogs.com/primary.jpg",
      itemType: "ep",
      year: 2016,
      genre: "Techno",
    });
  });

  test("resolves shop/item URL via marketplace listing", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeDiscogsResponse({ release: { id: 5678 } }))
      .mockResolvedValueOnce(makeDiscogsResponse(RELEASE_FIXTURE));

    const result = await fetchDiscogsRelease("https://www.discogs.com/shop/item/4334240712", 5000);

    const [listingUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(listingUrl).toBe("https://api.discogs.com/marketplace/listings/4334240712");

    const [releaseUrl] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(releaseUrl).toBe("https://api.discogs.com/releases/5678");

    expect(result?.potentialTitle).toBe("Some EP");
  });

  test("returns null when sell/item listing cannot be resolved", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeDiscogsResponse({ message: "Not Found" }, 404),
    );

    const result = await fetchDiscogsRelease("https://www.discogs.com/sell/item/9999999", 5000);
    expect(result).toBeNull();
  });
});

describe("searchReleases", () => {
  // The request gate is zeroed for the whole suite in tests/unit/preload.ts.
  afterEach(() => {
    mock.restore();
  });

  function searchResponse(results: unknown[]): Response {
    return makeDiscogsResponse({ results });
  }

  test("splits the packed 'Artist - Title' field", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([{ id: 1, master_id: 10, title: "The Earons - Land of Hunger" }]),
    );

    const [candidate] = await searchReleases({ artist: "The Earons" });

    expect(candidate?.artist).toBe("The Earons");
    expect(candidate?.title).toBe("Land of Hunger");
  });

  test("strips the disambiguation suffix from the artist half", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([{ id: 2, title: "Bana (2) - Eroticorythmotropicalomanie Vol. 3" }]),
    );

    const [candidate] = await searchReleases({ artist: "Bana" });

    expect(candidate?.artist).toBe("Bana");
  });

  test("coerces master_id 0 to null so 'no master' is unambiguous", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([{ id: 3, master_id: 0, title: "Determine - Never Know" }]),
    );

    const [candidate] = await searchReleases({ artist: "Determine" });

    // 0 is Discogs' way of saying the release has no master. Left as 0 it looks
    // like a valid id; the release id is the work-level key in that case.
    expect(candidate?.masterId).toBeNull();
    expect(candidate?.releaseId).toBe(3);
  });

  test("keeps a real master id", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([{ id: 4, master_id: 608159, title: "Dorival Caymmi - Caymmi" }]),
    );

    const [candidate] = await searchReleases({ artist: "Dorival Caymmi" });

    expect(candidate?.masterId).toBe(608159);
  });

  test("parses label, catalogue number, year and country", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([
        {
          id: 5,
          title: "Ernesto Lecuona - Lecuona Plays For Two",
          year: "1955",
          country: "US",
          label: ["RCA Victor", "RCA"],
          catno: "LPM-1058",
        },
      ]),
    );

    const [candidate] = await searchReleases({ catno: "LPM-1058" });

    expect(candidate?.year).toBe(1955);
    expect(candidate?.country).toBe("US");
    expect(candidate?.label).toBe("RCA Victor");
    expect(candidate?.catalogueNumber).toBe("LPM-1058");
  });

  test("passes structured query fields through to the API", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(searchResponse([]));

    await searchReleases(
      { artist: "Barry Brown", releaseTitle: "Vibes", track: "Dub", catno: "SP 01" },
      3,
    );

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("artist=Barry+Brown");
    expect(url).toContain("release_title=Vibes");
    expect(url).toContain("track=Dub");
    expect(url).toContain("catno=SP+01");
    expect(url).toContain("per_page=3");
    expect(url).toContain("type=release");
  });

  test("throws DiscogsHttpError on a non-2xx so a miss is not confused with a failure", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(makeDiscogsResponse({}, 429));

    // Returning [] here would record a throttled request as "record absent",
    // which is exactly how an earlier fixture pass invented three false misses.
    await expect(searchReleases({ artist: "x" })).rejects.toThrow(DiscogsHttpError);
  });

  test("skips malformed results rather than failing the whole search", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([null, { title: "no id here" }, { id: 9, title: "Olu - Living Free" }]),
    );

    const candidates = await searchReleases({ artist: "Olu" });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.releaseId).toBe(9);
  });

  test("returns an empty list when Discogs has no results", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(searchResponse([]));

    expect(await searchReleases({ q: "nothing" })).toEqual([]);
  });
});

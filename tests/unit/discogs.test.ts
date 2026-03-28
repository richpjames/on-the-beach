import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fetchDiscogsRelease, parseDiscogsRelease } from "../../server/discogs";

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

  test("returns null when sell/item listing cannot be resolved", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeDiscogsResponse({ message: "Not Found" }, 404),
    );

    const result = await fetchDiscogsRelease("https://www.discogs.com/sell/item/9999999", 5000);
    expect(result).toBeNull();
  });
});

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { lookupRelease, findSuggestedRelease } from "../../server/musicbrainz";

function makeMbArtistSearchResponse(artists: unknown[]): Response {
  return new Response(JSON.stringify({ artists }), {
    headers: { "content-type": "application/json" },
  });
}

function makeMbArtistReleasesResponse(releases: unknown[]): Response {
  return new Response(JSON.stringify({ releases, "release-count": releases.length }), {
    headers: { "content-type": "application/json" },
  });
}

describe("findSuggestedRelease", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns the release closest in year to sourceYear", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Amber", date: "1994" },
        { id: "r2", title: "Tri Repetae", date: "1995" },
        { id: "r3", title: "Chiastic Slide", date: "1997" },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(["amber"]),
      sourceYear: 1996,
    });

    expect(result?.title).toBe("Tri Repetae");
  });

  test("excludes titles already in trackedTitles (normalised)", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Amber", date: "1994" },
        { id: "r2", title: "Tri Repetae", date: "1995" },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(["amber", "tri repetae"]),
      sourceYear: 1994,
    });

    expect(result).toBeNull();
  });

  test("falls back to artist name search when no mbArtistId", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeMbArtistSearchResponse([{ id: "found-artist-uuid", name: "Autechre" }]),
      )
      .mockResolvedValueOnce(
        makeMbArtistReleasesResponse([{ id: "r1", title: "Amber", date: "1994" }]),
      );

    const result = await findSuggestedRelease({
      mbArtistId: null,
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1994,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result?.title).toBe("Amber");
  });

  test("returns null when artist name search finds no artists", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(makeMbArtistSearchResponse([]));

    const result = await findSuggestedRelease({
      mbArtistId: null,
      artistName: "Unknown Artist",
      trackedTitles: new Set(),
      sourceYear: 2000,
    });

    expect(result).toBeNull();
  });

  test("falls back to most recent release when sourceYear is null", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Amber", date: "1994" },
        { id: "r2", title: "Tri Repetae", date: "1995" },
        { id: "r3", title: "Chiastic Slide", date: "1997" },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: null,
    });

    expect(result?.title).toBe("Chiastic Slide");
  });

  test("ranks undated releases last instead of treating them as a perfect year match", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Undated Compilation" },
        { id: "r2", title: "Dead Men Don't Smoke Marijuana", date: "1994" },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "S. E. Rogie",
      trackedTitles: new Set(),
      sourceYear: 2022,
    });

    expect(result?.title).toBe("Dead Men Don't Smoke Marijuana");
  });

  test("excludes titles close to tracked ones (edition variants, punctuation)", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Amber (Deluxe Edition)", date: "2014" },
        { id: "r2", title: "Tri Repetae++", date: "1996" },
        { id: "r3", title: "Confield", date: "2001" },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(["amber", "tri repetae"]),
      sourceYear: 1995,
    });

    expect(result?.title).toBe("Confield");
  });

  test("returns null when every candidate is close to a tracked title", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Amber [2009 Remaster]", date: "2009" },
        { id: "r2", title: "Amber (Deluxe Edition)", date: "2014" },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(["amber"]),
      sourceYear: 1994,
    });

    expect(result).toBeNull();
  });

  test("prefers longer releases by default, even when a shorter one is closer in year", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Anvil Vapre", date: "1995", media: [{ "track-count": 4 }] },
        { id: "r2", title: "Chiastic Slide", date: "1997", media: [{ "track-count": 9 }] },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1995,
    });

    expect(result?.title).toBe("Chiastic Slide");
  });

  test("prefers shorter releases when lengthPreference is 'shorter'", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Anvil Vapre", date: "1995", media: [{ "track-count": 4 }] },
        { id: "r2", title: "Chiastic Slide", date: "1997", media: [{ "track-count": 9 }] },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1997,
      lengthPreference: "shorter",
    });

    expect(result?.title).toBe("Anvil Vapre");
  });

  test("breaks length-bucket ties by year proximity", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Incunabula", date: "1993", media: [{ "track-count": 9 }] },
        { id: "r2", title: "LP5", date: "1998", media: [{ "track-count": 11 }] },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1999,
    });

    expect(result?.title).toBe("LP5");
  });

  test("ranks releases without track data below sized ones", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        { id: "r1", title: "Mystery Comp", date: "1995" },
        {
          id: "r2",
          title: "Tri Repetae",
          date: "1995",
          media: [{ "track-count": 5 }, { "track-count": 5 }],
        },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1995,
    });

    // Track counts sum across media (5 + 5 = 10) and a sized release always
    // beats one MusicBrainz has no media data for.
    expect(result?.title).toBe("Tri Repetae");
  });

  test("requests media with the artist's releases", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([]),
    );

    await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1995,
    });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("inc=releases%2Bmedia");
  });

  test("throws on fetch error so callers can distinguish failure from no-candidates", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));

    expect(
      findSuggestedRelease({
        mbArtistId: "artist-uuid",
        artistName: "Autechre",
        trackedTitles: new Set(),
        sourceYear: 1995,
      }),
    ).rejects.toThrow("network error");
  });

  test("throws on a non-2xx MusicBrainz response (e.g. rate limiting)", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("rate limited", { status: 503 }));

    expect(
      findSuggestedRelease({
        mbArtistId: "artist-uuid",
        artistName: "Autechre",
        trackedTitles: new Set(),
        sourceYear: 1995,
      }),
    ).rejects.toThrow("503");
  });
});

function makeMbResponse(releases: unknown[]): Response {
  return new Response(JSON.stringify({ releases }), {
    headers: { "content-type": "application/json" },
  });
}

describe("lookupRelease", () => {
  afterEach(() => {
    mock.restore();
  });

  test("logs the search terms and parsed result", async () => {
    const infoSpy = spyOn(console, "info").mockImplementation(() => {});
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbResponse([
        {
          id: "release-uuid-123",
          date: "1997-05-21",
          country: "GB",
          "artist-credit": [{ artist: { id: "artist-uuid-456" } }],
          "label-info": [
            {
              "catalog-number": "CDPUSH45",
              label: { name: "Parlophone" },
            },
          ],
        },
      ]),
    );

    await lookupRelease("Radiohead", "OK Computer", "1997");

    expect(infoSpy).toHaveBeenCalledWith("[musicbrainz] Searching releases", {
      artist: "Radiohead",
      title: "OK Computer",
      year: "1997",
      query: "artist:Radiohead AND release:OK Computer AND date:1997",
    });
    expect(infoSpy).toHaveBeenCalledWith("[musicbrainz] Search result", {
      artist: "Radiohead",
      title: "OK Computer",
      year: "1997",
      query: "artist:Radiohead AND release:OK Computer AND date:1997",
      releaseCount: 1,
      result: {
        year: 1997,
        label: "Parlophone",
        country: "GB",
        catalogueNumber: "CDPUSH45",
        musicbrainzReleaseId: "release-uuid-123",
        musicbrainzArtistId: "artist-uuid-456",
      },
    });
  });

  test("returns parsed fields from the first matching release", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbResponse([
        {
          title: "OK Computer",
          date: "1997-05-21",
          country: "GB",
          "label-info": [
            {
              "catalog-number": "CDPUSH45",
              label: { name: "Parlophone" },
            },
          ],
        },
      ]),
    );

    const result = await lookupRelease("Radiohead", "OK Computer");
    expect(result).toEqual({
      year: 1997,
      label: "Parlophone",
      country: "GB",
      catalogueNumber: "CDPUSH45",
      musicbrainzReleaseId: null,
      musicbrainzArtistId: null,
    });
  });

  test("returns null when releases array is empty", async () => {
    const infoSpy = spyOn(console, "info").mockImplementation(() => {});
    spyOn(globalThis, "fetch").mockResolvedValueOnce(makeMbResponse([]));

    const result = await lookupRelease("Unknown", "Unknown");
    expect(result).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith("[musicbrainz] Search returned no releases", {
      artist: "Unknown",
      title: "Unknown",
      year: null,
      query: "artist:Unknown AND release:Unknown",
    });
  });

  test("returns null on non-200 response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 }),
    );

    const result = await lookupRelease("Radiohead", "OK Computer");
    expect(result).toBeNull();
  });

  test("returns null when fetch throws", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));

    const result = await lookupRelease("Radiohead", "OK Computer");
    expect(result).toBeNull();
  });

  test("handles missing label-info gracefully", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbResponse([
        {
          title: "Some Release",
          date: "2010",
          country: "US",
        },
      ]),
    );

    const result = await lookupRelease("Some Artist", "Some Release");
    expect(result).toEqual({
      year: 2010,
      label: null,
      country: "US",
      catalogueNumber: null,
      musicbrainzReleaseId: null,
      musicbrainzArtistId: null,
    });
  });

  test("sends a valid User-Agent header", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(makeMbResponse([]));

    await lookupRelease("Artist", "Title");
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("User-Agent")).toContain("on-the-beach");
  });

  test("returns release ID and artist ID from response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbResponse([
        {
          id: "release-uuid-123",
          date: "2001",
          country: "DE",
          "artist-credit": [{ artist: { id: "artist-uuid-456" } }],
          "label-info": [],
        },
      ]),
    );

    const result = await lookupRelease("Artist", "Title");
    expect(result?.musicbrainzReleaseId).toBe("release-uuid-123");
    expect(result?.musicbrainzArtistId).toBe("artist-uuid-456");
  });

  test("accepts year hint and includes it in the query", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(makeMbResponse([]));

    await lookupRelease("Radiohead", "OK Computer", "1997");
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("date%3A1997");
  });

  test("returns null musicbrainzReleaseId when release has no id field", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbResponse([{ date: "2001", country: "US", "label-info": [] }]),
    );

    const result = await lookupRelease("Artist", "Title");
    expect(result?.musicbrainzReleaseId).toBeNull();
    expect(result?.musicbrainzArtistId).toBeNull();
  });
});

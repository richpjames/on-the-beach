import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  lookupRelease,
  findSuggestedRelease,
  fetchReleaseGroupIdForRelease,
  fetchArtistReleaseGroups,
  searchArtistCandidates,
  MusicBrainzHttpError,
} from "../../server/musicbrainz";

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

// `bun test` runs every file in one process, so `globalThis.fetch` can arrive
// here still spied on — with responses another file queued and never spent. A
// `mockResolvedValueOnce` set below would then queue *behind* those, and the
// first request in this file gets served someone else's body: that's how
// "returns the release closest in year to sourceYear" came to see zero releases
// on CI (a `{ artists: [...] }` shape has no `releases` key) while passing
// locally, where the file order put it first. Start every test from an
// unmocked fetch rather than trusting whatever ran before.
beforeEach(() => {
  mock.restore();
});

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

  test("requests media and release groups with the artist's releases", async () => {
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
    expect(url).toContain("inc=releases%2Bmedia%2Brelease-groups");
  });

  test("carries the release group's MBID so artwork can be looked up at group level", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        {
          id: "r1",
          title: "Tri Repetae",
          date: "1995",
          "release-group": { id: "rg1", "primary-type": "Album" },
        },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1995,
    });

    expect(result?.musicbrainzReleaseGroupId).toBe("rg1");
  });

  test("takes itemType from the release group — releases have no primary type", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([
        {
          id: "r1",
          title: "Anvil Vapre",
          date: "1995",
          "release-group": { id: "rg1", "primary-type": "EP" },
        },
      ]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1995,
    });

    expect(result?.itemType).toBe("ep");
  });

  test("leaves the release group MBID null when MusicBrainz omits the group", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistReleasesResponse([{ id: "r1", title: "Tri Repetae", date: "1995" }]),
    );

    const result = await findSuggestedRelease({
      mbArtistId: "artist-uuid",
      artistName: "Autechre",
      trackedTitles: new Set(),
      sourceYear: 1995,
    });

    expect(result?.musicbrainzReleaseGroupId).toBeNull();
    expect(result?.itemType).toBe("album");
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

describe("fetchReleaseGroupIdForRelease", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns the release's parent group MBID", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "r1", "release-group": { id: "rg1" } }), {
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await fetchReleaseGroupIdForRelease("r1");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/release/r1?");
    expect(url).toContain("inc=release-groups");
    expect(result).toBe("rg1");
  });

  test("returns null when the release carries no group", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "r1" }), {
        headers: { "content-type": "application/json" },
      }),
    );

    expect(await fetchReleaseGroupIdForRelease("r1")).toBeNull();
  });

  test("throws on a non-2xx response so the caller can retry later", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("rate limited", { status: 503 }));

    expect(fetchReleaseGroupIdForRelease("r1")).rejects.toThrow("503");
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

// ---------------------------------------------------------------------------
// Release groups & artist search (artist watch)
// ---------------------------------------------------------------------------

function makeReleaseGroupResponse(groups: unknown[]): Response {
  return new Response(JSON.stringify({ "release-groups": groups }), {
    headers: { "content-type": "application/json" },
  });
}

function releaseGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `rg-${Math.random().toString(36).slice(2)}`,
    title: "A Record",
    "primary-type": "Album",
    "secondary-types": [],
    "first-release-date": "2026-06-01",
    ...overrides,
  };
}

describe("fetchArtistReleaseGroups", () => {
  afterEach(() => {
    mock.restore();
  });

  test("parses a page of release groups", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeReleaseGroupResponse([
        releaseGroup({
          id: "rg-1",
          title: "On the Beach",
          "secondary-types": ["Live"],
          "first-release-date": "1974-07-19",
        }),
      ]),
    );

    const groups = await fetchArtistReleaseGroups("artist-uuid");

    expect(groups).toEqual([
      {
        id: "rg-1",
        title: "On the Beach",
        primaryType: "Album",
        secondaryTypes: ["Live"],
        firstReleaseDate: "1974-07-19",
      },
    ]);
  });

  test("keeps a missing first-release-date as null rather than inventing one", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeReleaseGroupResponse([releaseGroup({ "first-release-date": "" })]),
    );

    const groups = await fetchArtistReleaseGroups("artist-uuid");

    expect(groups[0].firstReleaseDate).toBeNull();
  });

  test("paginates only when a page comes back full", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeReleaseGroupResponse(Array.from({ length: 100 }, () => releaseGroup())),
      )
      .mockResolvedValueOnce(makeReleaseGroupResponse([releaseGroup()]));

    const groups = await fetchArtistReleaseGroups("artist-uuid");

    expect(groups).toHaveLength(101);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toContain("offset=100");
  });

  test("throws with the status so the caller can tell a 503 from a miss", async () => {
    // A partial fetch must never be written as a baseline: every group it
    // missed would alert as new on the next successful poll.
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 503 }));

    let caught: unknown;
    try {
      await fetchArtistReleaseGroups("artist-uuid");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MusicBrainzHttpError);
    expect((caught as MusicBrainzHttpError).status).toBe(503);
  });
});

describe("searchArtistCandidates", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns the fields a human needs to tell two artists apart", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistSearchResponse([
        {
          id: "us-band",
          name: "Nirvana",
          score: 100,
          disambiguation: "90s US grunge band",
          country: "US",
          type: "Group",
          "life-span": { begin: "1987", end: "1994" },
        },
      ]),
    );

    const candidates = await searchArtistCandidates("Nirvana");

    expect(candidates).toEqual([
      {
        id: "us-band",
        name: "Nirvana",
        score: 100,
        disambiguation: "90s US grunge band",
        country: "US",
        type: "Group",
        lifeSpanBegin: "1987",
        lifeSpanEnd: "1994",
      },
    ]);
  });

  test("skips malformed entries rather than failing the whole search", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeMbArtistSearchResponse([{ name: "No Id" }, { id: "ok", name: "Real", score: 90 }]),
    );

    const candidates = await searchArtistCandidates("Whoever");

    expect(candidates.map((candidate) => candidate.id)).toEqual(["ok"]);
  });
});

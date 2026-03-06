import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { lookupRelease } from "../../server/musicbrainz";

function makeMbResponse(releases: unknown[]): Response {
  return new Response(JSON.stringify({ releases }), {
    headers: { "content-type": "application/json" },
  });
}

describe("lookupRelease", () => {
  afterEach(() => {
    mock.restore();
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
    spyOn(globalThis, "fetch").mockResolvedValueOnce(makeMbResponse([]));

    const result = await lookupRelease("Unknown", "Unknown");
    expect(result).toBeNull();
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

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createReleaseRoutes } from "../../server/routes/release";

const mockExtractReleaseInfo = mock();
const mockSaveImage = mock();
const mockLookupRelease = mock();
const mockFetchCoverArt = mock();
const mockSearchAppleMusic = mock();
const mockFetchItemForLookup = mock();
const mockGetExistingAppleMusicLink = mock();
const mockSaveAppleMusicLink = mock();

function makeApp(): Hono {
  const app = new Hono();
  app.route(
    "/api/release",
    createReleaseRoutes(
      mockExtractReleaseInfo,
      mockSaveImage,
      mockLookupRelease,
      mockFetchCoverArt,
      mockSearchAppleMusic,
      mockFetchItemForLookup,
      mockGetExistingAppleMusicLink,
      mockSaveAppleMusicLink,
    ),
  );
  return app;
}

describe("POST /api/release/scan", () => {
  beforeEach(() => {
    mockExtractReleaseInfo.mockReset();
    mockSaveImage.mockReset();
    mockSaveImage.mockResolvedValue("/uploads/mock.jpg");
    mockLookupRelease.mockReset();
    mockFetchCoverArt.mockReset();
    mockFetchCoverArt.mockResolvedValue(null);
  });

  test("returns 400 when imageBase64 is missing", async () => {
    const app = makeApp();

    const res = await app.request("http://localhost/api/release/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("imageBase64");
    expect(mockExtractReleaseInfo).not.toHaveBeenCalled();
  });

  test("returns 400 for invalid JSON body", async () => {
    const app = makeApp();

    const res = await app.request("http://localhost/api/release/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{this-is-not-json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON payload");
    expect(mockExtractReleaseInfo).not.toHaveBeenCalled();
  });

  test("returns 200 with parsed fields on success", async () => {
    mockExtractReleaseInfo.mockResolvedValueOnce({
      artist: "Boards of Canada",
      title: "Geogaddi",
    });

    const app = makeApp();

    const res = await app.request("http://localhost/api/release/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: "YWJjZA==" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      artist: "Boards of Canada",
      title: "Geogaddi",
    });
    expect(mockExtractReleaseInfo).toHaveBeenCalledWith("YWJjZA==");
  });

  test("returns enriched fields when scan function returns them", async () => {
    mockExtractReleaseInfo.mockResolvedValueOnce({
      artist: "Radiohead",
      title: "OK Computer",
      year: 1997,
      label: "Parlophone",
      country: "GB",
      catalogueNumber: "CDPUSH45",
    });

    const app = makeApp();

    const res = await app.request("http://localhost/api/release/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: "YWJjZA==" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      artist: "Radiohead",
      title: "OK Computer",
      year: 1997,
      label: "Parlophone",
      country: "GB",
      catalogueNumber: "CDPUSH45",
    });
  });

  test("returns 503 when vision extraction fails", async () => {
    mockExtractReleaseInfo.mockResolvedValueOnce(null);

    const app = makeApp();

    const res = await app.request("http://localhost/api/release/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: "YWJjZA==" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Scan unavailable");
  });
});

describe("POST /api/release/image", () => {
  beforeEach(() => {
    mockExtractReleaseInfo.mockReset();
    mockSaveImage.mockReset();
    mockSaveImage.mockResolvedValue("/uploads/mock.jpg");
    mockLookupRelease.mockReset();
    mockFetchCoverArt.mockReset();
    mockFetchCoverArt.mockResolvedValue(null);
  });

  test("returns 400 when imageBase64 is missing", async () => {
    const app = makeApp();

    const res = await app.request("http://localhost/api/release/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("imageBase64");
    expect(mockSaveImage).not.toHaveBeenCalled();
  });

  test("returns 201 with artwork url on success", async () => {
    const app = makeApp();

    const res = await app.request("http://localhost/api/release/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: "YWJjZA==" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ artworkUrl: "/uploads/mock.jpg" });
    expect(mockSaveImage).toHaveBeenCalledWith("YWJjZA==");
  });

  test("returns 500 when image save fails", async () => {
    mockSaveImage.mockRejectedValueOnce(new Error("disk full"));
    const app = makeApp();

    const res = await app.request("http://localhost/api/release/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: "YWJjZA==" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to save image");
  });
});

describe("POST /api/release/lookup", () => {
  beforeEach(() => {
    mockExtractReleaseInfo.mockReset();
    mockSaveImage.mockReset();
    mockLookupRelease.mockReset();
    mockFetchCoverArt.mockReset();
    mockFetchCoverArt.mockResolvedValue(null);
  });

  test("returns 400 when artist is missing", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "OK Computer" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when title is missing", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Radiohead" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns empty object when lookup returns null", async () => {
    mockLookupRelease.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Unknown", title: "Unknown" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test("returns enriched fields on successful lookup", async () => {
    mockLookupRelease.mockResolvedValueOnce({
      year: 1997,
      label: "Parlophone",
      country: "GB",
      catalogueNumber: "CDPUSH45",
      musicbrainzReleaseId: "release-uuid",
      musicbrainzArtistId: "artist-uuid",
    });
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Radiohead", title: "OK Computer" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.year).toBe(1997);
    expect(body.label).toBe("Parlophone");
    expect(body.musicbrainzReleaseId).toBe("release-uuid");
  });

  test("includes artworkUrl when cover art is found", async () => {
    mockLookupRelease.mockResolvedValueOnce({
      year: 2001,
      label: null,
      country: null,
      catalogueNumber: null,
      musicbrainzReleaseId: "release-uuid",
      musicbrainzArtistId: null,
    });
    mockFetchCoverArt.mockResolvedValueOnce("/uploads/cover.jpg");
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Some Artist", title: "Some Title" }),
    });
    const body = await res.json();
    expect(body.artworkUrl).toBe("/uploads/cover.jpg");
  });

  test("passes year hint to lookupRelease when provided", async () => {
    mockLookupRelease.mockResolvedValueOnce(null);
    const app = makeApp();
    await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Radiohead", title: "OK Computer", year: "1997" }),
    });
    expect(mockLookupRelease).toHaveBeenCalledWith("Radiohead", "OK Computer", "1997");
  });

  test("returns empty object when lookup throws", async () => {
    mockLookupRelease.mockRejectedValueOnce(new Error("timeout"));
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: "Radiohead", title: "OK Computer" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

describe("POST /api/release/apple-music-lookup/:id", () => {
  beforeEach(() => {
    mockSearchAppleMusic.mockReset();
    mockFetchItemForLookup.mockReset();
    mockGetExistingAppleMusicLink.mockReset();
    mockSaveAppleMusicLink.mockReset();
    mockGetExistingAppleMusicLink.mockResolvedValue(null);
    mockSaveAppleMusicLink.mockResolvedValue(undefined);
  });

  test("returns 400 for non-numeric id", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/apple-music-lookup/abc", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 when item not found", async () => {
    mockFetchItemForLookup.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/apple-music-lookup/99", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("returns skipped when item already has a playable source", async () => {
    mockFetchItemForLookup.mockResolvedValue({
      title: "Blue Lines",
      artistName: "Massive Attack",
      primarySource: "spotify",
    });
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/apple-music-lookup/1", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(mockSearchAppleMusic).not.toHaveBeenCalled();
  });

  test("returns existing Apple Music link without searching again", async () => {
    mockFetchItemForLookup.mockResolvedValue({
      title: "Blue Lines",
      artistName: "Massive Attack",
      primarySource: "discogs",
    });
    mockGetExistingAppleMusicLink.mockResolvedValue(
      "https://music.apple.com/gb/album/blue-lines/123",
    );
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/apple-music-lookup/1", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("https://music.apple.com/gb/album/blue-lines/123");
    expect(mockSearchAppleMusic).not.toHaveBeenCalled();
  });

  test("searches Apple Music and saves link when no playable source", async () => {
    mockFetchItemForLookup.mockResolvedValue({
      title: "Blue Lines",
      artistName: "Massive Attack",
      primarySource: null,
    });
    mockSearchAppleMusic.mockResolvedValue("https://music.apple.com/gb/album/blue-lines/456");
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/apple-music-lookup/1", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("https://music.apple.com/gb/album/blue-lines/456");
    expect(mockSearchAppleMusic).toHaveBeenCalledWith("Blue Lines", "Massive Attack");
    expect(mockSaveAppleMusicLink).toHaveBeenCalledWith(
      1,
      "https://music.apple.com/gb/album/blue-lines/456",
    );
  });

  test("returns null url when Apple Music search finds nothing", async () => {
    mockFetchItemForLookup.mockResolvedValue({
      title: "Obscure Album",
      artistName: "Unknown Artist",
      primarySource: null,
    });
    mockSearchAppleMusic.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/apple-music-lookup/2", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBeNull();
    expect(mockSaveAppleMusicLink).not.toHaveBeenCalled();
  });

  test("searches when primary source is discogs (non-playable)", async () => {
    mockFetchItemForLookup.mockResolvedValue({
      title: "Some Album",
      artistName: "Some Artist",
      primarySource: "discogs",
    });
    mockSearchAppleMusic.mockResolvedValue("https://music.apple.com/album/123");
    const app = makeApp();
    await app.request("http://localhost/api/release/apple-music-lookup/3", { method: "POST" });
    expect(mockSearchAppleMusic).toHaveBeenCalled();
  });

  test("skips search when primary source is bandcamp (playable)", async () => {
    mockFetchItemForLookup.mockResolvedValue({
      title: "Some Album",
      artistName: "Some Artist",
      primarySource: "bandcamp",
      primaryUrl: null,
    });
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/apple-music-lookup/3", {
      method: "POST",
    });
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(mockSearchAppleMusic).not.toHaveBeenCalled();
  });

  test("skips search when primary URL is Apple Music even if primarySource is null", async () => {
    mockFetchItemForLookup.mockResolvedValue({
      title: "The Band (Remastered)",
      artistName: "The Band",
      primarySource: null,
      primaryUrl: "https://music.apple.com/es/album/the-band-remastered/1440846597",
    });
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/apple-music-lookup/4", {
      method: "POST",
    });
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(mockSearchAppleMusic).not.toHaveBeenCalled();
  });

  test("skips search when primary URL is Apple Music with unusual format not matched by parseUrl", async () => {
    mockFetchItemForLookup.mockResolvedValue({
      title: "Some Song",
      artistName: "Some Artist",
      primarySource: null,
      primaryUrl: "https://music.apple.com/us/song/some-song/123456789",
    });
    const app = makeApp();
    const res = await app.request("http://localhost/api/release/apple-music-lookup/5", {
      method: "POST",
    });
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(mockSearchAppleMusic).not.toHaveBeenCalled();
  });
});

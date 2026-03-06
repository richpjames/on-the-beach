import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createReleaseRoutes } from "../../server/routes/release";

const mockExtractReleaseInfo = mock();
const mockSaveImage = mock();
const mockLookupRelease = mock();
const mockFetchCoverArt = mock();

function makeApp(): Hono {
  const app = new Hono();
  app.route(
    "/api/release",
    createReleaseRoutes(
      mockExtractReleaseInfo,
      mockSaveImage,
      mockLookupRelease,
      mockFetchCoverArt,
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

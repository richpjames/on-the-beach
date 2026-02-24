import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createReleaseRoutes } from "../../server/routes/release";

const mockExtractAlbumInfo = mock();
const mockSaveImage = mock();

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/release", createReleaseRoutes(mockExtractAlbumInfo, mockSaveImage));
  return app;
}

describe("POST /api/release/scan", () => {
  beforeEach(() => {
    mockExtractAlbumInfo.mockReset();
    mockSaveImage.mockReset();
    mockSaveImage.mockResolvedValue("/uploads/mock.jpg");
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
    expect(mockExtractAlbumInfo).not.toHaveBeenCalled();
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
    expect(mockExtractAlbumInfo).not.toHaveBeenCalled();
  });

  test("returns 200 with parsed fields on success", async () => {
    mockExtractAlbumInfo.mockResolvedValueOnce({
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
    expect(mockExtractAlbumInfo).toHaveBeenCalledWith("YWJjZA==");
  });

  test("returns 503 when vision extraction fails", async () => {
    mockExtractAlbumInfo.mockResolvedValueOnce(null);

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
    mockExtractAlbumInfo.mockReset();
    mockSaveImage.mockReset();
    mockSaveImage.mockResolvedValue("/uploads/mock.jpg");
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

import { afterEach, describe, expect, spyOn, test, mock } from "bun:test";
import { fetchAndSaveCoverArt } from "../../server/cover-art-archive";

describe("fetchAndSaveCoverArt", () => {
  afterEach(() => {
    mock.restore();
  });

  test("fetches from CAA and returns saved path", async () => {
    const imageBytes = new Uint8Array([1, 2, 3]);
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(imageBytes, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    const mockSave = mock().mockResolvedValueOnce("/uploads/abc.jpg");

    const result = await fetchAndSaveCoverArt("release-uuid-123", mockSave);

    expect(result).toBe("/uploads/abc.jpg");
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  test("fetches from the correct CAA URL", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    const mockSave = mock().mockResolvedValueOnce("/uploads/abc.jpg");

    await fetchAndSaveCoverArt("release-uuid-123", mockSave);

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("https://coverartarchive.org/release/release-uuid-123/front-500");
  });

  test("returns null on non-200 response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    const mockSave = mock();

    const result = await fetchAndSaveCoverArt("bad-id", mockSave);

    expect(result).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
  });

  test("returns null when fetch throws", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));
    const mockSave = mock();

    const result = await fetchAndSaveCoverArt("release-uuid-123", mockSave);

    expect(result).toBeNull();
  });

  test("returns null when content-type is not an image", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const mockSave = mock();

    const result = await fetchAndSaveCoverArt("release-uuid-123", mockSave);

    expect(result).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
  });
});

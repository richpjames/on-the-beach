import { describe, expect, test } from "bun:test";
import { parseAppleMusicCatalogUrl, isPlayableAppleMusicUrl } from "../../shared/apple-music";

describe("parseAppleMusicCatalogUrl", () => {
  test("parses an album URL with a storefront", () => {
    expect(parseAppleMusicCatalogUrl("https://music.apple.com/gb/album/blue-lines/123")).toEqual({
      kind: "album",
      id: "123",
    });
  });

  test("parses an album URL without a storefront", () => {
    expect(parseAppleMusicCatalogUrl("https://music.apple.com/album/boc/789")).toEqual({
      kind: "album",
      id: "789",
    });
  });

  test("treats an album ?i= deep-link as a song", () => {
    expect(
      parseAppleMusicCatalogUrl("https://music.apple.com/gb/album/blue-lines/123?i=456"),
    ).toEqual({ kind: "song", id: "456" });
  });

  test("parses a song URL", () => {
    expect(parseAppleMusicCatalogUrl("https://music.apple.com/us/song/foo/789")).toEqual({
      kind: "song",
      id: "789",
    });
  });

  test("parses a playlist URL", () => {
    expect(
      parseAppleMusicCatalogUrl("https://music.apple.com/gb/playlist/foo/pl.u-abc123"),
    ).toEqual({ kind: "playlist", id: "pl.u-abc123" });
  });

  test("parses a music-video URL", () => {
    expect(parseAppleMusicCatalogUrl("https://music.apple.com/gb/music-video/foo/555")).toEqual({
      kind: "musicVideo",
      id: "555",
    });
  });

  test("rejects a non-Apple-Music host", () => {
    expect(parseAppleMusicCatalogUrl("https://open.spotify.com/album/x")).toBeNull();
  });

  test("rejects a non-playable Apple Music path (artist)", () => {
    expect(parseAppleMusicCatalogUrl("https://music.apple.com/gb/artist/foo/111")).toBeNull();
  });

  test("rejects a playlist without a pl. id", () => {
    expect(parseAppleMusicCatalogUrl("https://music.apple.com/gb/playlist/foo/12345")).toBeNull();
  });

  test("rejects an album with a non-numeric id", () => {
    expect(parseAppleMusicCatalogUrl("https://music.apple.com/gb/album/foo/not-an-id")).toBeNull();
  });

  test("rejects malformed input", () => {
    expect(parseAppleMusicCatalogUrl("not a url")).toBeNull();
  });

  test("isPlayableAppleMusicUrl reflects parseability", () => {
    expect(isPlayableAppleMusicUrl("https://music.apple.com/gb/album/blue-lines/123")).toBe(true);
    expect(isPlayableAppleMusicUrl("https://example.com")).toBe(false);
  });
});

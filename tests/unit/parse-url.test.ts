import { describe, test, expect } from "bun:test";
import { parseUrl } from "../../src/repository/utils";

describe("parseUrl - youtube", () => {
  test("identifies youtube watch link and preserves video ID in normalizedUrl", () => {
    const result = parseUrl("https://www.youtube.com/watch?v=C9CkvAQkQLs");

    expect(result.source).toBe("youtube");
    expect(result.normalizedUrl).toBe("https://www.youtube.com/watch?v=C9CkvAQkQLs");
  });

  test("normalizes youtu.be shortlinks to full watch URL", () => {
    const result = parseUrl("https://youtu.be/C9CkvAQkQLs");

    expect(result.source).toBe("youtube");
    expect(result.normalizedUrl).toBe("https://www.youtube.com/watch?v=C9CkvAQkQLs");
  });
});

describe("parseUrl - apple music", () => {
  test("identifies apple music album link and extracts title", () => {
    const result = parseUrl("https://music.apple.com/es/album/el-poder-verde/1810282984?l=en-GB");

    expect(result.source).toBe("apple_music");
    expect(result.potentialTitle).toBe("el poder verde");
  });

  test("strips query params from normalized URL", () => {
    const result = parseUrl("https://music.apple.com/es/album/el-poder-verde/1810282984?l=en-GB");

    expect(result.normalizedUrl).toBe("https://music.apple.com/es/album/el-poder-verde/1810282984");
  });

  test("extracts title from playlist link", () => {
    const result = parseUrl(
      "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb",
    );

    expect(result.source).toBe("apple_music");
    expect(result.potentialTitle).toBe("todays hits");
  });

  test("identifies artist link and extracts artist name", () => {
    const result = parseUrl("https://music.apple.com/us/artist/the-beatles/136975");

    expect(result.source).toBe("apple_music");
    expect(result.potentialArtist).toBe("the beatles");
  });

  test("identifies music video link and extracts title", () => {
    const result = parseUrl("https://music.apple.com/us/music-video/bad-guy/1461695557");

    expect(result.source).toBe("apple_music");
    expect(result.potentialTitle).toBe("bad guy");
  });

  test("identifies station link", () => {
    const result = parseUrl("https://music.apple.com/us/station/pure-dance/ra.978194965");

    expect(result.source).toBe("apple_music");
  });
});

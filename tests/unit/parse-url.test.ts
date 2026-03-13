import { describe, test, expect } from "bun:test";
import { parseUrl, extractYouTubePlaylistId } from "../../src/repository/utils";

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

  test("normalizes mobile m.youtube.com links to full watch URL", () => {
    const result = parseUrl("https://m.youtube.com/watch?v=C9CkvAQkQLs");

    expect(result.source).toBe("youtube");
    expect(result.normalizedUrl).toBe("https://www.youtube.com/watch?v=C9CkvAQkQLs");
  });

  test("identifies youtube playlist link", () => {
    const result = parseUrl("https://www.youtube.com/playlist?list=PLE31AAD9114F343C4");

    expect(result.source).toBe("youtube");
    expect(result.normalizedUrl).toBe("https://www.youtube.com/playlist?list=PLE31AAD9114F343C4");
  });

  test("normalizes youtube playlist link by stripping extra params", () => {
    const result = parseUrl("https://www.youtube.com/playlist?list=PLE31AAD9114F343C4&si=abc123");

    expect(result.source).toBe("youtube");
    expect(result.normalizedUrl).toBe("https://www.youtube.com/playlist?list=PLE31AAD9114F343C4");
  });
});

describe("extractYouTubePlaylistId", () => {
  test("extracts playlist ID from standard playlist URL", () => {
    expect(
      extractYouTubePlaylistId("https://www.youtube.com/playlist?list=PLE31AAD9114F343C4"),
    ).toBe("PLE31AAD9114F343C4");
  });

  test("returns null for a video watch URL", () => {
    expect(extractYouTubePlaylistId("https://www.youtube.com/watch?v=C9CkvAQkQLs")).toBeNull();
  });

  test("returns null for non-youtube URLs", () => {
    expect(extractYouTubePlaylistId("https://soundcloud.com/artist/track")).toBeNull();
  });
});

describe("parseUrl - nts", () => {
  test("identifies NTS episode link", () => {
    const result = parseUrl(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );

    expect(result.source).toBe("nts");
  });

  test("strips query params from normalized URL", () => {
    const result = parseUrl(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026?some=param",
    );

    expect(result.normalizedUrl).toBe(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );
  });

  test("extracts show slug as potentialArtist", () => {
    const result = parseUrl(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );

    expect(result.potentialArtist).toBe("tropic of cancer");
  });

  test("extracts episode slug as potentialTitle", () => {
    const result = parseUrl(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );

    expect(result.potentialTitle).toBe("tropic of cancer 6th march 2026");
  });

  test("identifies NTS show index page (no episode)", () => {
    const result = parseUrl("https://www.nts.live/shows/tropic-of-cancer");

    expect(result.source).toBe("nts");
    expect(result.potentialArtist).toBe("tropic of cancer");
  });

  test("matches nts.live URLs without www prefix", () => {
    const result = parseUrl(
      "https://nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );

    expect(result.source).toBe("nts");
  });
});

describe("parseUrl - apple music", () => {
  test("identifies apple music release link and extracts title", () => {
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

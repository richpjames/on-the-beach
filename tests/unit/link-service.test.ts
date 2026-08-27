import { describe, expect, test } from "bun:test";
import { linkService, serviceFromUrl } from "../../src/ui/domain/link-service";

describe("serviceFromUrl", () => {
  test("recognises the services a release can link to", () => {
    expect(serviceFromUrl("https://phewjapan.bandcamp.com/album/paper-masks")).toBe("bandcamp");
    expect(serviceFromUrl("https://open.spotify.com/album/1234")).toBe("spotify");
    expect(serviceFromUrl("https://soundcloud.com/artist/track")).toBe("soundcloud");
    expect(serviceFromUrl("https://www.youtube.com/watch?v=abc")).toBe("youtube");
    expect(serviceFromUrl("https://youtu.be/abc")).toBe("youtube");
    expect(serviceFromUrl("https://music.apple.com/gb/album/x/123")).toBe("apple_music");
    expect(serviceFromUrl("https://www.discogs.com/release/123")).toBe("discogs");
    expect(serviceFromUrl("https://tidal.com/browse/album/123")).toBe("tidal");
    expect(serviceFromUrl("https://www.deezer.com/gb/album/123")).toBe("deezer");
    expect(serviceFromUrl("https://www.mixcloud.com/host/show/")).toBe("mixcloud");
    expect(serviceFromUrl("https://www.nts.live/shows/some-show")).toBe("nts");
    expect(serviceFromUrl("https://pitchfork.com/reviews/albums/slug/")).toBe("pitchfork");
  });

  test("a hand-typed link without a protocol still resolves", () => {
    expect(serviceFromUrl("phewjapan.bandcamp.com/album/paper-masks")).toBe("bandcamp");
  });

  test("apple.com outside music.apple.com is not Apple Music", () => {
    expect(serviceFromUrl("https://www.apple.com/uk/music/")).toBe("unknown");
    expect(serviceFromUrl("https://itunes.apple.com/gb/album/x/123")).toBe("apple_music");
  });

  test("anywhere else, and anything unparseable, is unknown", () => {
    expect(serviceFromUrl("https://example.com/record")).toBe("unknown");
    expect(serviceFromUrl("not a url at all")).toBe("unknown");
    expect(serviceFromUrl(null)).toBe("unknown");
    expect(serviceFromUrl("")).toBe("unknown");
  });

  test("a lookalike hostname doesn't borrow the mark", () => {
    expect(serviceFromUrl("https://notbandcamp.com/album/x")).toBe("unknown");
    expect(serviceFromUrl("https://bandcamp.com.evil.test/album/x")).toBe("unknown");
  });
});

describe("linkService", () => {
  test("the recorded source name wins — it's what was chosen for the link", () => {
    expect(linkService("https://example.com/thing", "bandcamp")).toBe("bandcamp");
    // A physical copy has no URL of its own to go by.
    expect(linkService(null, "physical")).toBe("physical");
  });

  test("falls back to the URL when the source name says nothing useful", () => {
    expect(linkService("https://open.spotify.com/album/1234", "unknown")).toBe("spotify");
    expect(linkService("https://open.spotify.com/album/1234", null)).toBe("spotify");
    expect(linkService("https://open.spotify.com/album/1234", "some-new-source")).toBe("spotify");
  });
});

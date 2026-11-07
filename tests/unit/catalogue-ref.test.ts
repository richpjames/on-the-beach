import { describe, expect, test } from "bun:test";
import { parseDiscogsRef, parseMusicBrainzReleaseRef } from "../../domain/catalogue-ref";

// The edit form's catalogue-match fields accept whatever a person would paste:
// a Discogs or MusicBrainz page URL, or just the number. These tests pin every
// accepted shape and the refusals that must alert instead of storing junk.

const MBID = "2f59e6b5-6c3f-4a2b-b47f-9b0f1d3e4f5a";

describe("parseDiscogsRef", () => {
  test("a release URL gives the release id", () => {
    expect(parseDiscogsRef("https://www.discogs.com/release/4419535-Salsa-Bestial")).toEqual({
      releaseId: 4419535,
    });
  });

  test("a master URL gives the master id only — it can't name the pressing", () => {
    expect(parseDiscogsRef("https://www.discogs.com/master/706722")).toEqual({ masterId: 706722 });
  });

  test("a bare number is the release id", () => {
    expect(parseDiscogsRef("4419535")).toEqual({ releaseId: 4419535 });
    expect(parseDiscogsRef("  4419535  ")).toEqual({ releaseId: 4419535 });
  });

  test("anything else is refused, not guessed", () => {
    expect(parseDiscogsRef("https://www.discogs.com/artist/135874")).toBeNull();
    expect(parseDiscogsRef("salsa bestial")).toBeNull();
    expect(parseDiscogsRef("")).toBeNull();
  });
});

describe("parseMusicBrainzReleaseRef", () => {
  test("a release URL gives the MBID, lowercased", () => {
    expect(
      parseMusicBrainzReleaseRef(`https://musicbrainz.org/release/${MBID.toUpperCase()}`),
    ).toBe(MBID);
  });

  test("a bare MBID is accepted and lowercased", () => {
    expect(parseMusicBrainzReleaseRef(MBID.toUpperCase())).toBe(MBID);
  });

  test("a release-group URL is refused — the group isn't the pressing", () => {
    expect(parseMusicBrainzReleaseRef(`https://musicbrainz.org/release-group/${MBID}`)).toBeNull();
  });

  test("anything else is refused", () => {
    expect(parseMusicBrainzReleaseRef("mb-release-1")).toBeNull();
    expect(parseMusicBrainzReleaseRef("")).toBeNull();
  });
});

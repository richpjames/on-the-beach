import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  checkReleaseLink,
  pickExternalLink,
  type ReleaseLinkDeps,
} from "../../server/release-link-check";
import type { MbUrlRelation } from "../../server/musicbrainz";
import type { ServiceSearchResult } from "../../server/scraper";

const QUERY = {
  title: "Ordinary Record",
  artistName: "Ordinary Artist",
  mbReleaseGroupId: "rg-1",
};

function makeDeps(overrides: Partial<ReleaseLinkDeps> = {}): ReleaseLinkDeps {
  return {
    getService: async () => "apple_music",
    searchService: async () => null,
    fetchExternalLinks: async () => [],
    ...overrides,
  };
}

const APPLE_HIT: ServiceSearchResult = {
  url: "https://music.apple.com/gb/album/ordinary-record/1",
  artworkUrl: "https://example.test/cover.jpg",
};

// The gate is a no-op with external lookups switched off (see the module note),
// and every other test file in the suite leaves it set.
beforeEach(() => {
  delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
});

afterEach(() => {
  mock.restore();
});

describe("pickExternalLink", () => {
  test("prefers a streaming relation over a database one", () => {
    const relations: MbUrlRelation[] = [
      { type: "discogs", url: "https://www.discogs.com/master/1" },
      { type: "streaming", url: "https://open.spotify.com/album/1" },
    ];
    expect(pickExternalLink(relations)?.url).toBe("https://open.spotify.com/album/1");
  });

  test("still returns a relation type we don't rank — any external link is evidence", () => {
    const relations: MbUrlRelation[] = [{ type: "wikidata", url: "https://www.wikidata.org/Q1" }];
    expect(pickExternalLink(relations)?.url).toBe("https://www.wikidata.org/Q1");
  });

  test("returns null when there are no relations at all", () => {
    expect(pickExternalLink([])).toBeNull();
  });
});

describe("checkReleaseLink", () => {
  test("the provider of choice answering is the whole check", async () => {
    const fetchExternalLinks = mock(async () => []);
    const outcome = await checkReleaseLink(
      QUERY,
      makeDeps({ searchService: async () => APPLE_HIT, fetchExternalLinks }),
    );

    expect(outcome.kind).toBe("found");
    if (outcome.kind !== "found") return;
    expect(outcome.link.via).toBe("provider");
    expect(outcome.link.url).toBe(APPLE_HIT.url);
    expect(outcome.link.sourceName).toBe("apple_music");
    expect(outcome.link.foundBy).toBe("Apple Music");
    // The cover art comes free with the match, and MusicBrainz isn't troubled.
    expect(outcome.link.artworkUrl).toBe(APPLE_HIT.artworkUrl);
    expect(fetchExternalLinks).not.toHaveBeenCalled();
  });

  test("falls back to the release group's external links", async () => {
    const outcome = await checkReleaseLink(
      QUERY,
      makeDeps({
        fetchExternalLinks: async () => [
          { type: "free streaming", url: "https://ordinary.bandcamp.com/album/ordinary-record" },
        ],
      }),
    );

    expect(outcome.kind).toBe("found");
    if (outcome.kind !== "found") return;
    expect(outcome.link.via).toBe("musicbrainz");
    expect(outcome.link.sourceName).toBe("bandcamp");
    expect(outcome.link.foundBy).toBe("MusicBrainz");
    expect(outcome.link.providerSearched).toBe(true);
  });

  test("an external link on no service we model still counts, with no source", async () => {
    const outcome = await checkReleaseLink(
      QUERY,
      makeDeps({
        fetchExternalLinks: async () => [
          { type: "official homepage", url: "https://label.test/1" },
        ],
      }),
    );

    expect(outcome.kind).toBe("found");
    if (outcome.kind !== "found") return;
    expect(outcome.link.sourceName).toBeNull();
  });

  test("neither source has anything", async () => {
    const outcome = await checkReleaseLink(QUERY, makeDeps());
    expect(outcome).toEqual({ kind: "none", service: "apple_music", providerSearched: true });
  });

  test("a release with no release group id falls back to nothing", async () => {
    const fetchExternalLinks = mock(async () => []);
    const outcome = await checkReleaseLink(
      { ...QUERY, mbReleaseGroupId: null },
      makeDeps({ fetchExternalLinks }),
    );

    expect(outcome.kind).toBe("none");
    expect(fetchExternalLinks).not.toHaveBeenCalled();
  });

  test("a MusicBrainz failure is not an absence", async () => {
    const outcome = await checkReleaseLink(
      QUERY,
      makeDeps({
        fetchExternalLinks: async () => {
          throw new Error("MusicBrainz returned 503");
        },
      }),
    );

    expect(outcome).toEqual({ kind: "failed", message: "MusicBrainz returned 503" });
  });

  test("a provider failure is survivable while MusicBrainz still answers", async () => {
    const outcome = await checkReleaseLink(
      QUERY,
      makeDeps({
        searchService: async () => {
          throw new Error("itunes timed out");
        },
        fetchExternalLinks: async () => [
          { type: "streaming", url: "https://open.spotify.com/album/1" },
        ],
      }),
    );

    expect(outcome.kind).toBe("found");
    if (outcome.kind !== "found") return;
    expect(outcome.link.providerSearched).toBe(false);
  });

  test("a provider failure with nothing on MusicBrainz is a failure, not a refusal", async () => {
    const outcome = await checkReleaseLink(
      QUERY,
      makeDeps({
        searchService: async () => {
          throw new Error("itunes timed out");
        },
      }),
    );

    expect(outcome).toEqual({ kind: "failed", message: "itunes timed out" });
  });

  test("nothing is asked when external lookups are switched off", async () => {
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const searchService = mock(async () => null);
    const fetchExternalLinks = mock(async () => []);

    const outcome = await checkReleaseLink(QUERY, makeDeps({ searchService, fetchExternalLinks }));

    expect(outcome).toEqual({ kind: "unchecked" });
    expect(searchService).not.toHaveBeenCalled();
    expect(fetchExternalLinks).not.toHaveBeenCalled();
  });
});

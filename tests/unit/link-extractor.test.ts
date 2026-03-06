import { describe, expect, test } from "bun:test";
import {
  parseReleaseCandidatesJson,
  pickPrimaryReleaseCandidate,
} from "../../server/link-extractor";

describe("parseReleaseCandidatesJson", () => {
  test("parses multiple releases from JSON", () => {
    const result = parseReleaseCandidatesJson(`
      {
        "releases": [
          { "artist": "Artist One", "title": "First Album", "itemType": "album" },
          { "artist": "Artist Two", "title": "Second EP", "itemType": "ep" }
        ]
      }
    `);

    expect(result).toEqual([
      {
        candidateId: "cand-1-artist-one-first-album",
        artist: "Artist One",
        title: "First Album",
        itemType: "album",
      },
      {
        candidateId: "cand-2-artist-two-second-ep",
        artist: "Artist Two",
        title: "Second EP",
        itemType: "ep",
      },
    ]);
  });

  test("uses artist as title for self-titled releases when title is null", () => {
    const result = parseReleaseCandidatesJson(`
      {
        "releases": [
          { "artist": "Burial", "title": null, "itemType": "album" }
        ]
      }
    `);

    expect(result).toEqual([
      {
        candidateId: "cand-1-burial-burial",
        artist: "Burial",
        title: "Burial",
        itemType: "album",
      },
    ]);
  });

  test("deduplicates repeated releases and ignores invalid entries", () => {
    const result = parseReleaseCandidatesJson(`
      {
        "releases": [
          { "artist": "Theo Parrish", "title": "In Motion", "itemType": "album" },
          { "artist": "Theo Parrish", "title": "In Motion", "itemType": "album" },
          { "artist": null, "title": null, "itemType": "album" }
        ]
      }
    `);

    expect(result).toEqual([
      {
        candidateId: "cand-1-theo-parrish-in-motion",
        artist: "Theo Parrish",
        title: "In Motion",
        itemType: "album",
      },
    ]);
  });
});

describe("pickPrimaryReleaseCandidate", () => {
  test("picks the obvious product-page release when url slug matches it strongly", () => {
    const result = pickPrimaryReleaseCandidate(
      "https://ripgrooves.com/products/katie-webster-the-swamp-boogie-queen-cd-mint-m",
      [
        {
          candidateId: "cand-1",
          artist: "Katie Webster",
          title: "The Swamp Boogie Queen",
          itemType: "album",
          confidence: 0.84,
        },
        {
          candidateId: "cand-2",
          artist: "B.B. King",
          title: "Live in Cook County Jail",
          itemType: "album",
          confidence: 0.41,
        },
      ],
    );

    expect(result?.candidateId).toBe("cand-1");
  });

  test("returns null when several releases are peer candidates", () => {
    const result = pickPrimaryReleaseCandidate(
      "https://mailchi.mp/27f45c3c5d8f/the-meditationsnewsletter-17475884",
      [
        {
          candidateId: "cand-1",
          artist: "Artist One",
          title: "Release One",
          itemType: "album",
          confidence: 0.56,
        },
        {
          candidateId: "cand-2",
          artist: "Artist Two",
          title: "Release Two",
          itemType: "album",
          confidence: 0.54,
        },
      ],
    );

    expect(result).toBeNull();
  });
});

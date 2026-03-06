import { describe, expect, test } from "bun:test";
import { parseReleaseCandidatesJson } from "../../server/link-extractor";

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
      { artist: "Artist One", title: "First Album", itemType: "album" },
      { artist: "Artist Two", title: "Second EP", itemType: "ep" },
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

    expect(result).toEqual([{ artist: "Burial", title: "Burial", itemType: "album" }]);
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

    expect(result).toEqual([{ artist: "Theo Parrish", title: "In Motion", itemType: "album" }]);
  });
});

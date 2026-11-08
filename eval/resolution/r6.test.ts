import { describe, expect, test } from "bun:test";
import { parseR6Answer } from "./r6";

describe("parseR6Answer", () => {
  test("abstain", () => {
    expect(parseR6Answer("abstain")).toEqual({ provider: null, index: null });
  });

  test("discogs:0", () => {
    expect(parseR6Answer("discogs:0")).toEqual({ provider: "discogs", index: 0 });
  });

  test("musicbrainz:3", () => {
    expect(parseR6Answer("MusicBrainz:3")).toEqual({ provider: "musicbrainz", index: 3 });
  });

  test("refusal", () => {
    expect(parseR6Answer("I don't know")).toEqual({ provider: null, index: null });
  });

  test("out of bounds", () => {
    expect(parseR6Answer("discogs:5")).toEqual({ provider: "discogs", index: null });
  });
});

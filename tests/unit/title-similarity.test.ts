import { describe, expect, test } from "bun:test";
import {
  normalizeTitleForMatch,
  titlesMatchClosely,
  titleMatchesAny,
} from "../../server/title-similarity";

describe("normalizeTitleForMatch", () => {
  test("lowercases and collapses punctuation to spaces", () => {
    expect(normalizeTitleForMatch("Tri Repetae++")).toBe("tri repetae");
    expect(normalizeTitleForMatch("R&B  Mixtape!")).toBe("r b mixtape");
  });

  test("strips diacritics", () => {
    expect(normalizeTitleForMatch("Björk Début")).toBe("bjork debut");
  });

  test("strips trailing bracketed qualifiers, stacked", () => {
    expect(normalizeTitleForMatch("Amber (Deluxe Edition)")).toBe("amber");
    expect(normalizeTitleForMatch("OK Computer [2009 Remaster] (Bonus)")).toBe("ok computer");
  });

  test("keeps leading and mid-title brackets", () => {
    expect(normalizeTitleForMatch("(What's the Story) Morning Glory?")).toBe(
      "what s the story morning glory",
    );
  });

  test("keeps content of a title that is nothing but brackets", () => {
    expect(normalizeTitleForMatch("(Untitled)")).toBe("untitled");
  });
});

describe("titlesMatchClosely", () => {
  test("matches identical titles regardless of case and punctuation", () => {
    expect(titlesMatchClosely("Selected Ambient Works 85–92", "selected ambient works 85-92")).toBe(
      true,
    );
  });

  test("matches an edition variant against the plain title", () => {
    expect(titlesMatchClosely("Amber", "Amber (Deluxe Edition)")).toBe(true);
    expect(titlesMatchClosely("Tri Repetae", "Tri Repetae++")).toBe(true);
  });

  test("matches a word-boundary extension", () => {
    expect(titlesMatchClosely("Tri Repetae", "Tri Repetae Plus")).toBe(true);
  });

  test("does not match a non-word-boundary extension", () => {
    expect(titlesMatchClosely("Amber", "Ambergris")).toBe(false);
  });

  test("does not extend very short titles", () => {
    expect(titlesMatchClosely("II", "II and Beyond the Infinite")).toBe(false);
  });

  test("matches small typo-scale differences", () => {
    expect(titlesMatchClosely("Chiastic Slide", "Chiastic Slides")).toBe(true);
  });

  test("does not match genuinely different titles", () => {
    expect(titlesMatchClosely("Amber", "Confield")).toBe(false);
    expect(titlesMatchClosely("Incunabula", "Oversteps")).toBe(false);
  });
});

describe("titleMatchesAny", () => {
  test("finds a close match anywhere in the collection", () => {
    const library = new Set(["confield", "amber", "draft 7.30"]);
    expect(titleMatchesAny("Amber (Reissue)", library)).toBe(true);
    expect(titleMatchesAny("Oversteps", library)).toBe(false);
  });
});

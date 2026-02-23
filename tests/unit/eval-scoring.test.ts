import { describe, expect, test } from "bun:test";
import { levenshteinSimilarity, scoreResult } from "../../eval/scoring";

describe("levenshteinSimilarity", () => {
  test("identical strings return 1.0", () => {
    expect(levenshteinSimilarity("Radiohead", "Radiohead")).toBe(1.0);
  });

  test("completely different strings return low score", () => {
    expect(levenshteinSimilarity("abc", "xyz")).toBeLessThan(0.2);
  });

  test("case-insensitive comparison", () => {
    expect(levenshteinSimilarity("RADIOHEAD", "radiohead")).toBe(1.0);
  });

  test("similar strings return high score", () => {
    const score = levenshteinSimilarity("Radiohead", "Radioheed");
    expect(score).toBeGreaterThan(0.8);
  });

  test("empty strings return 1.0", () => {
    expect(levenshteinSimilarity("", "")).toBe(1.0);
  });

  test("one empty string returns 0.0", () => {
    expect(levenshteinSimilarity("abc", "")).toBe(0.0);
  });
});

describe("scoreResult", () => {
  test("exact match scores 1 on all metrics", () => {
    const scores = scoreResult(
      { artist: "Radiohead", title: "OK Computer" },
      { artist: "Radiohead", title: "OK Computer" },
    );
    expect(scores).toEqual({
      artistExact: 1,
      titleExact: 1,
      artistFuzzy: 1.0,
      titleFuzzy: 1.0,
    });
  });

  test("case-insensitive exact match", () => {
    const scores = scoreResult(
      { artist: "RADIOHEAD", title: "ok computer" },
      { artist: "Radiohead", title: "OK Computer" },
    );
    expect(scores.artistExact).toBe(1);
    expect(scores.titleExact).toBe(1);
  });

  test("null actual when expected non-null scores 0", () => {
    const scores = scoreResult(
      { artist: null, title: null },
      { artist: "Radiohead", title: "OK Computer" },
    );
    expect(scores.artistExact).toBe(0);
    expect(scores.titleExact).toBe(0);
    expect(scores.artistFuzzy).toBe(0);
    expect(scores.titleFuzzy).toBe(0);
  });
});

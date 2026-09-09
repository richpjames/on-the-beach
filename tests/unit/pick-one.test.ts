import { describe, expect, test } from "bun:test";
import {
  FULL_PICK_RANGE,
  formatPickRange,
  makePickRange,
  matchesPickRange,
  parsePickRange,
  PICK_RATING_STEPS,
  pickRangeAriaLabel,
  pickRangeLabel,
  ratingStars,
  snapRating,
} from "../../src/ui/logic/pick-one";

describe("PICK_RATING_STEPS", () => {
  test("covers every half star from 5 down to 0.5", () => {
    expect(PICK_RATING_STEPS).toHaveLength(10);
    expect(PICK_RATING_STEPS[0]).toBe(5);
    expect(PICK_RATING_STEPS.at(-1)).toBe(0.5);
    expect(FULL_PICK_RANGE).toEqual({ min: 0.5, max: 5 });
  });
});

describe("snapRating", () => {
  test("snaps onto the half-star scale", () => {
    expect(snapRating(2.2)).toBe(2);
    expect(snapRating(2.6)).toBe(2.5);
  });

  test("clamps a value off the end of the scale back onto it", () => {
    expect(snapRating(0)).toBe(0.5);
    expect(snapRating(9)).toBe(5);
  });

  test("rejects what isn't a number at all", () => {
    expect(snapRating(Number.NaN)).toBeNull();
  });
});

describe("makePickRange", () => {
  test("keeps a range the user gave in order", () => {
    expect(makePickRange(3, 4.5)).toEqual({ min: 3, max: 4.5 });
  });

  test("orders a range given backwards", () => {
    expect(makePickRange(5, 2)).toEqual({ min: 2, max: 5 });
  });

  test("collapses to a single rating when both ends match", () => {
    expect(makePickRange(4, 4)).toEqual({ min: 4, max: 4 });
  });

  test("falls back to the end that is a rating", () => {
    expect(makePickRange(Number.NaN, 3)).toEqual({ min: 3, max: 3 });
    expect(makePickRange(Number.NaN, Number.NaN)).toBeNull();
  });
});

describe("matchesPickRange", () => {
  test("no range takes anything, unrated included", () => {
    expect(matchesPickRange(null, null)).toBe(true);
    expect(matchesPickRange(1, null)).toBe(true);
  });

  test("a range is inclusive at both ends", () => {
    const range = { min: 3, max: 4.5 };
    expect(matchesPickRange(3, range)).toBe(true);
    expect(matchesPickRange(4, range)).toBe(true);
    expect(matchesPickRange(4.5, range)).toBe(true);
    expect(matchesPickRange(2.5, range)).toBe(false);
    expect(matchesPickRange(5, range)).toBe(false);
  });

  test("an unrated release never falls inside a range", () => {
    expect(matchesPickRange(null, FULL_PICK_RANGE)).toBe(false);
  });
});

describe("formatPickRange / parsePickRange", () => {
  test("round-trips a range", () => {
    const range = { min: 2.5, max: 4 };
    expect(formatPickRange(range)).toBe("2.5-4");
    expect(parsePickRange(formatPickRange(range))).toEqual(range);
  });

  test("writes a single rating without a range", () => {
    expect(formatPickRange({ min: 4, max: 4 })).toBe("4");
    expect(parsePickRange("4")).toEqual({ min: 4, max: 4 });
  });

  test("no range serialises to nothing", () => {
    expect(formatPickRange(null)).toBeNull();
  });

  test("reads a hand-edited param leniently, then gives up", () => {
    expect(parsePickRange("5-3")).toEqual({ min: 3, max: 5 });
    expect(parsePickRange("3-99")).toEqual({ min: 3, max: 5 });
    expect(parsePickRange("nonsense")).toBeNull();
    expect(parsePickRange("3-")).toBeNull();
    expect(parsePickRange("1-2-3")).toBeNull();
    expect(parsePickRange("")).toBeNull();
    expect(parsePickRange(null)).toBeNull();
  });
});

describe("labels", () => {
  test("stars read as half steps", () => {
    expect(ratingStars(3)).toBe("★★★");
    expect(ratingStars(3.5)).toBe("★★★½");
  });

  test("the button label shows the window, or nothing when there is none", () => {
    expect(pickRangeLabel(null)).toBeNull();
    expect(pickRangeLabel({ min: 4, max: 4 })).toBe("4★");
    expect(pickRangeLabel({ min: 3, max: 4.5 })).toBe("3–4.5★");
  });

  test("screen readers hear it in words", () => {
    expect(pickRangeAriaLabel(null)).toBe("any rating");
    expect(pickRangeAriaLabel({ min: 1, max: 1 })).toBe("1 star");
    expect(pickRangeAriaLabel({ min: 4, max: 4 })).toBe("4 stars");
    expect(pickRangeAriaLabel({ min: 3, max: 5 })).toBe("3 to 5 stars");
  });
});

import { describe, expect, it } from "bun:test";

import {
  isValidStarCount,
  isValidStoredRating,
  starRatingToStored,
  storedToStarRating,
} from "../../domain/rating";

describe("star count validation", () => {
  it("accepts whole and two-decimal counts from 1 to 100", () => {
    expect(isValidStarCount(1)).toBeTrue();
    expect(isValidStarCount(5)).toBeTrue();
    expect(isValidStarCount(10)).toBeTrue();
    expect(isValidStarCount(100)).toBeTrue();
    expect(isValidStarCount(7.5)).toBeTrue();
    expect(isValidStarCount(7.25)).toBeTrue();
  });

  it("rejects out-of-range, over-precise and non-numeric counts", () => {
    expect(isValidStarCount(0)).toBeFalse();
    expect(isValidStarCount(100.5)).toBeFalse();
    expect(isValidStarCount(7.333)).toBeFalse();
    expect(isValidStarCount(Number.NaN)).toBeFalse();
    expect(isValidStarCount("5")).toBeFalse();
    expect(isValidStarCount(null)).toBeFalse();
  });
});

describe("stored rating validation", () => {
  it("accepts null and finite 0–100 numbers", () => {
    expect(isValidStoredRating(null)).toBeTrue();
    expect(isValidStoredRating(0)).toBeTrue();
    expect(isValidStoredRating(87.5)).toBeTrue();
    expect(isValidStoredRating(100)).toBeTrue();
  });

  it("rejects values outside the stored scale", () => {
    expect(isValidStoredRating(-1)).toBeFalse();
    expect(isValidStoredRating(100.01)).toBeFalse();
    expect(isValidStoredRating(Number.POSITIVE_INFINITY)).toBeFalse();
    expect(isValidStoredRating("90")).toBeFalse();
  });
});

describe("star/stored conversion", () => {
  it("converts star values to out-of-100 with two decimals", () => {
    expect(starRatingToStored(4.5, 5)).toBe(90);
    expect(starRatingToStored(5, 5)).toBe(100);
    expect(starRatingToStored(0.5, 5)).toBe(10);
    expect(starRatingToStored(2.5, 3)).toBe(83.33);
    expect(starRatingToStored(9.5, 10)).toBe(95);
  });

  it("clamps star values beyond the scale instead of storing over 100", () => {
    expect(starRatingToStored(11, 10)).toBe(100);
    expect(starRatingToStored(-1, 5)).toBe(0);
  });

  it("keeps accuracy across scale changes — 5 stars to 2 and back up to 10", () => {
    // Rated 4.5 of 5…
    const stored = starRatingToStored(4.5, 5);
    expect(stored).toBe(90);

    // …viewed as 2 stars, the nearest paintable half-step is the full 2…
    expect(storedToStarRating(stored, 2)).toBe(2);

    // …and back on a 10-star scale it is exactly 9 again — nothing was lost.
    expect(storedToStarRating(stored, 10)).toBe(9);

    // A rating that only a finer scale can express keeps its precision too:
    // 1.5 of 3 stores as 50 and returns as 1 of 2, 2.5 of 5, 5 of 10.
    const fine = starRatingToStored(1.5, 3);
    expect(fine).toBe(50);
    expect(storedToStarRating(fine, 2)).toBe(1);
    expect(storedToStarRating(fine, 5)).toBe(2.5);
    expect(storedToStarRating(fine, 10)).toBe(5);
  });

  it("snaps stored values to paintable half-steps", () => {
    // 83.33 (2.5 of 3) is 4.1666… of 5 — nearest half-step is 4
    expect(storedToStarRating(83.33, 5)).toBe(4);
    // …and 8.333 of 10 — nearest half-step 8.5
    expect(storedToStarRating(83.33, 10)).toBe(8.5);
  });

  it("paints unrated, too-small and non-finite values as empty", () => {
    expect(storedToStarRating(null, 5)).toBeNull();
    expect(storedToStarRating(Number.NaN, 5)).toBeNull();
    // 2 out of 100 can't light even half a star on a 5-star scale…
    expect(storedToStarRating(2, 5)).toBeNull();
    // …though on a 100-star scale it is a lightable 2 stars.
    expect(storedToStarRating(2, 100)).toBe(2);
  });

  it("always paints a full rating as the whole scale", () => {
    expect(storedToStarRating(100, 5)).toBe(5);
    expect(storedToStarRating(100, 10)).toBe(10);
    expect(storedToStarRating(100, 7.5)).toBe(7.5);
  });
});

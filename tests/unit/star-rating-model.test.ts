import { describe, expect, it } from "bun:test";

import { ratingForPointer, starFill } from "../../src/ui/components/star-rating-model";

describe("starFill", () => {
  it("paints stars at or below the rating as full", () => {
    expect(starFill(3, 1)).toBe("full");
    expect(starFill(3, 3)).toBe("full");
  });

  it("paints the boundary star as half on a half-step rating", () => {
    expect(starFill(3.5, 4)).toBe("half");
    expect(starFill(3.5, 3)).toBe("full");
    expect(starFill(3.5, 5)).toBe("empty");
  });

  it("paints nothing when there is no rating", () => {
    expect(starFill(null, 1)).toBe("empty");
  });
});

describe("ratingForPointer", () => {
  it("returns a half star when the pointer is in the left half", () => {
    expect(ratingForPointer(4, 0)).toBe(3.5);
    expect(ratingForPointer(4, 0.3)).toBe(3.5);
    expect(ratingForPointer(4, 0.49)).toBe(3.5);
  });

  it("returns the whole star when the pointer is in the right half", () => {
    expect(ratingForPointer(4, 0.5)).toBe(4);
    expect(ratingForPointer(4, 0.8)).toBe(4);
    expect(ratingForPointer(4, 1)).toBe(4);
  });

  it("keeps the lowest half-star in range on the first star", () => {
    expect(ratingForPointer(1, 0)).toBe(0.5);
    expect(ratingForPointer(1, 1)).toBe(1);
  });
});

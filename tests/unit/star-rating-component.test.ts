import { describe, expect, it } from "bun:test";

import { normalizeStarRating, renderStarRatingControl } from "../../src/ui/components/star-rating";

describe("star rating component", () => {
  it("renders a bounded module root with rating metadata", () => {
    const html = renderStarRatingControl({
      itemId: 42,
      rating: 3,
    });

    expect(html).toContain("data-rating-stars");
    expect(html).toContain('data-item-id="42"');
    expect(html).toContain('data-rating-value="3"');
  });

  it("renders five stars and marks active stars up to the selected rating", () => {
    const html = renderStarRatingControl({
      itemId: 1,
      rating: 4,
    });

    expect(html.match(/data-rating-star="/g)?.length).toBe(5);
    expect(html.match(/is-active-full/g)?.length).toBe(4);
    expect(html).not.toContain("is-active-half");
  });

  it("renders a half-active star for half-step ratings", () => {
    const html = renderStarRatingControl({
      itemId: 1,
      rating: 3.5,
    });

    expect(html.match(/is-active-full/g)?.length).toBe(3);
    expect(html.match(/is-active-half/g)?.length).toBe(1);
  });

  it("normalizes out-of-range and non-finite values", () => {
    expect(normalizeStarRating(null)).toBeNull();
    expect(normalizeStarRating(Number.NaN)).toBeNull();
    expect(normalizeStarRating(0)).toBeNull();
    expect(normalizeStarRating(6)).toBeNull();
  });

  it("rounds ratings to the nearest half-step in the supported range", () => {
    expect(normalizeStarRating(2.2)).toBe(2);
    expect(normalizeStarRating(2.6)).toBe(2.5);
    expect(normalizeStarRating(4.5)).toBe(4.5);
    expect(normalizeStarRating(0.5)).toBe(0.5);
  });
});

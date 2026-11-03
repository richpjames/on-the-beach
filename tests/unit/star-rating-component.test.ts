import { describe, expect, it } from "bun:test";

import { normalizeStarRating, renderStarRatingControl } from "../../src/ui/components/star-rating";
import { starGlyphValues } from "../../src/ui/components/star-rating-model";

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

  it("renders as many stars as the configured scale", () => {
    const html = renderStarRatingControl({
      itemId: 1,
      rating: 7.5,
      starCount: 10,
    });

    expect(html.match(/data-rating-star="/g)?.length).toBe(10);
    expect(html.match(/is-active-full/g)?.length).toBe(7);
    expect(html.match(/is-active-half/g)?.length).toBe(1);
  });

  it("stamps the configured scale on the control", () => {
    // scaleOf reads this attribute; without it a sub-5 (or fractional)
    // control would resolve to the default 5-star scale.
    const html = renderStarRatingControl({
      itemId: 1,
      rating: 2,
      starCount: 3,
    });

    expect(html).toContain('data-star-count="3"');
    expect(renderStarRatingControl({ itemId: 1, rating: 2 })).toContain('data-star-count="5"');
  });

  it("gives a fractional scale a top glyph worth the fraction", () => {
    // 7.5 stars paints 8 glyphs; the highest is worth 7.5, not 8.
    expect(starGlyphValues(7.5)).toEqual([7.5, 6.5, 5.5, 4.5, 3.5, 2.5, 1.5, 0.5]);
    expect(starGlyphValues(5)).toEqual([5, 4, 3, 2, 1]);
  });

  it("normalizes out-of-range and non-finite values", () => {
    expect(normalizeStarRating(null)).toBeNull();
    expect(normalizeStarRating(Number.NaN)).toBeNull();
    expect(normalizeStarRating(0)).toBeNull();
    expect(normalizeStarRating(6)).toBeNull();
    // A value only a bigger scale can hold
    expect(normalizeStarRating(6, 10)).toBe(6);
    expect(normalizeStarRating(11, 10)).toBeNull();
  });

  it("rounds ratings to the nearest half-step in the supported range", () => {
    expect(normalizeStarRating(2.2)).toBe(2);
    expect(normalizeStarRating(2.6)).toBe(2.5);
    expect(normalizeStarRating(4.5)).toBe(4.5);
    expect(normalizeStarRating(0.5)).toBe(0.5);
    expect(normalizeStarRating(9.7, 10)).toBe(9.5);
  });
});

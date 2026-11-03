import { MAX_STAR_COUNT } from "../../../domain/rating";

export { MAX_STAR_COUNT };
export const DEFAULT_STAR_COUNT = 5;
export const HALF_STEP = 0.5;

export type StarFill = "empty" | "half" | "full";

/**
 * Round a star value to the nearest valid half-step on a scale — the steps
 * the stars can paint and the pointer can pick. Out-of-range and non-finite
 * values are null (unrated); see domain/rating.ts for the stored scale.
 */
export function normalizeStarRating(
  rating: number | null,
  starCount: number = DEFAULT_STAR_COUNT,
): number | null {
  if (rating === null || !Number.isFinite(rating) || !Number.isFinite(starCount)) {
    return null;
  }

  const rounded = Math.round(rating / HALF_STEP) * HALF_STEP;
  if (rounded < HALF_STEP || rounded > starCount) {
    return null;
  }

  return rounded;
}

/**
 * The whole-star value each glyph represents, highest first (the DOM paints
 * them left-to-right via `row-reverse`). A fractional scale (7.5 stars) tops
 * out with a glyph worth 7.5 — its halves pick 7 and 7.5.
 */
export function starGlyphValues(starCount: number): number[] {
  const glyphCount = Math.ceil(starCount - 1e-9);
  return Array.from({ length: glyphCount }, (_, index) => starCount - index);
}

/**
 * How much of a single star glyph should be painted, given the effective
 * rating (either the committed selection or the live hover preview).
 */
export function starFill(rating: number | null, starValue: number): StarFill {
  if (rating === null) return "empty";
  if (rating >= starValue) return "full";
  if (Math.abs(rating - (starValue - HALF_STEP)) < 0.001) return "half";
  return "empty";
}

/**
 * Map a pointer's horizontal position over a star to a rating value.
 *
 * `fraction` is how far across the star the pointer sits, 0 (left edge) to 1
 * (right edge). This is pure geometry — no DOM, no events — so the component
 * can call it from pointermove and it's trivially unit-testable.
 *
 * The left half of the glyph is a half-star, the right half the whole star —
 * the midpoint matches the painted 50/50 gradient. The result runs through
 * `normalizeStarRating` so it stays a valid half-step on the scale.
 *
 * @param starValue  the whole-star value this glyph represents
 * @param fraction   pointer position across the glyph, clamped to [0, 1]
 * @param starCount  how many stars the scale has
 */
export function ratingForPointer(
  starValue: number,
  fraction: number,
  starCount: number = DEFAULT_STAR_COUNT,
): number | null {
  const value = fraction < 0.5 ? starValue - HALF_STEP : starValue;
  return normalizeStarRating(value, starCount);
}

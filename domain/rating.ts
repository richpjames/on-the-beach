/**
 * Star ratings are stored **out of 100** (two decimal places), not out of
 * however many stars are on screen, so the number of stars can be changed —
 * 5 to 2 and back up to 10 — without losing accuracy: a 4.5-of-5 is kept as
 * 90 and paints as 9-of-10 later. Only painting snaps to the nearest
 * half-star; the stored value keeps the full precision.
 */

/** The ceiling of the stored rating scale. */
export const RATING_STORED_MAX = 100;

/** Fewest stars a rating scale can have. */
export const MIN_STAR_COUNT = 1;

/** Most stars a rating scale can have. */
export const MAX_STAR_COUNT = 100;

/**
 * A valid scale size: 1 to 100, with up to two decimal places (the same
 * precision the stored rating carries, so any scale divides cleanly).
 */
export function isValidStarCount(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }
  if (value < MIN_STAR_COUNT || value > MAX_STAR_COUNT) {
    return false;
  }
  // Compare before rounding — rounding first would accept 7.333 as 733. The
  // epsilon absorbs representation error on genuinely two-decimal values
  // (1.01 * 100 is 101.00000000000001).
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/** A valid stored rating: null (unrated) or 0–100 with at most two decimals. */
export function isValidStoredRating(value: unknown): value is number | null {
  if (value === null) {
    return true;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }
  return value >= 0 && value <= RATING_STORED_MAX;
}

/** Round to the two decimal places the stored scale keeps. */
export function roundStoredRating(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A star-scale value (e.g. 4.5 of 5) as the stored out-of-100 value (90).
 * Clamped to the stored range, so an over-large star value can't write 110.
 */
export function starRatingToStored(starValue: number, starCount: number): number {
  const outOf100 = (starValue / starCount) * RATING_STORED_MAX;
  const clamped = Math.min(Math.max(outOf100, 0), RATING_STORED_MAX);
  return roundStoredRating(clamped);
}

/**
 * The stored out-of-100 value as the star-scale value to paint and click
 * with, snapped to the nearest half-star. Values too small to light even
 * half a star (or not finite) paint as unrated — the stored value is kept.
 */
export function storedToStarRating(stored: number | null, starCount: number): number | null {
  if (stored === null || !Number.isFinite(stored)) {
    return null;
  }

  const starValue = (stored / RATING_STORED_MAX) * starCount;

  // Clamping up as well as down: floating point can land a hair above the
  // ceiling (83.33 out of a 3-star scale is 2.4999), and a full rating must
  // always paint every star.
  const snapped = Math.min(Math.round(starValue * 2) / 2, starCount);
  return snapped < 0.5 ? null : snapped;
}

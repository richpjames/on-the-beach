import { normalizeStarRating } from "./star-rating";

export const MAX_STARS = 5;
export const HALF_STEP = 0.5;

export type StarFill = "empty" | "half" | "full";

export { normalizeStarRating };

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
 * TODO(you): implement the half-vs-full decision.
 *
 * DESIGN DECISION — where does the "half star" boundary sit, and how forgiving
 * is it? The obvious rule is: left half of the glyph → `starValue - 0.5`, right
 * half → `starValue`. But you might decide the half-zone should be wider (easier
 * to land a half on small 24px targets) or that touch should always snap to the
 * whole star. Whatever you pick, run the result through `normalizeStarRating`
 * so it stays a valid half-step in range, and return that.
 *
 * @param starValue  the whole-star value this glyph represents (1..5)
 * @param fraction   pointer position across the glyph, clamped to [0, 1]
 */
export function ratingForPointer(starValue: number, fraction: number): number | null {
  // Simple midpoint: the left half of the glyph is a half-star, the right half
  // is the whole star. Predictable and matches the painted 50/50 gradient.
  const value = fraction < 0.5 ? starValue - HALF_STEP : starValue;
  return normalizeStarRating(value);
}

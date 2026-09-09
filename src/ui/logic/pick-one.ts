import type { PickRatingRange } from "../../../domain/types";

/**
 * The rating window a Pick One roll is narrowed to.
 *
 * Pick One rolls over whatever the list is currently showing; this is the one
 * extra constraint it carries, and it outlives a roll — the range is part of
 * the list URL (see `list-url.ts`) so it survives the trip to the release page
 * the roll lands on, and the next roll uses it again.
 */

const RATING_STEP = 0.5;
const MIN_RATING = 0.5;
const MAX_RATING = 5;

/** Every rating a release can hold, highest first — the range menu's options. */
export const PICK_RATING_STEPS: readonly number[] = Array.from(
  { length: MAX_RATING / RATING_STEP },
  (_, index) => MAX_RATING - index * RATING_STEP,
);

/** The widest window there is — every rated release, and nothing unrated. */
export const FULL_PICK_RANGE: PickRatingRange = { min: MIN_RATING, max: MAX_RATING };

/** Stars for a rating: "★★★½" for 3.5. */
export function ratingStars(value: number): string {
  const full = Math.floor(value);
  return "★".repeat(full) + (value - full >= RATING_STEP ? "½" : "");
}

/**
 * Snap a rating onto the half-star scale, clamped to 0.5–5.
 *
 * Only genuine nonsense (a hand-edited URL saying `pick=abc`) comes back null;
 * a number merely off the end of the scale is pulled back onto it.
 */
export function snapRating(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const snapped = Math.round(value / RATING_STEP) * RATING_STEP;
  return Math.min(MAX_RATING, Math.max(MIN_RATING, snapped));
}

/**
 * Build a valid range from two ends given in any order.
 *
 * Returns null when neither end is a rating at all, so a junk pair reads as
 * "any rating" rather than an empty window nothing can match.
 */
export function makePickRange(min: number, max: number): PickRatingRange | null {
  const low = snapRating(min);
  const high = snapRating(max);
  if (low === null || high === null) {
    const single = low ?? high;
    return single === null ? null : { min: single, max: single };
  }
  return low <= high ? { min: low, max: high } : { min: high, max: low };
}

/**
 * Does a release belong in the pool for this range?
 *
 * `rating` is expected already normalised (`normalizeStarRating`), so null
 * means unrated — eligible only when there's no range at all.
 */
export function matchesPickRange(rating: number | null, range: PickRatingRange | null): boolean {
  if (range === null) return true;
  if (rating === null) return false;
  return rating >= range.min && rating <= range.max;
}

/** Serialise a range for the `pick` query param: "4" for one star value, else "3-5". */
export function formatPickRange(range: PickRatingRange | null): string | null {
  if (range === null) return null;
  return range.min === range.max ? String(range.min) : `${range.min}-${range.max}`;
}

/** Read a `pick` query param, ignoring anything that isn't a usable window. */
export function parsePickRange(raw: string | null | undefined): PickRatingRange | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parts = raw.split("-");
  if (parts.length > 2) return null;
  const [min, max] = parts.map(Number);
  if (parts.some((part) => part.trim() === "")) return null;
  return makePickRange(min, parts.length === 1 ? min : max);
}

/**
 * The range as it reads on the Pick One button: "4★" or "3.5–4.5★".
 *
 * Numerals rather than stars: the button sits in the filter bar, and a glyph
 * per star is wide enough to wrap the row onto a second line.
 */
export function pickRangeLabel(range: PickRatingRange | null): string | null {
  if (range === null) return null;
  return range.min === range.max ? `${range.min}★` : `${range.min}–${range.max}★`;
}

/** The same range spoken for screen readers. */
export function pickRangeAriaLabel(range: PickRatingRange | null): string {
  if (range === null) return "any rating";
  return range.min === range.max
    ? `${range.min} star${range.min === 1 ? "" : "s"}`
    : `${range.min} to ${range.max} stars`;
}

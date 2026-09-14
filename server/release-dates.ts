/**
 * Partial release dates, and what scheduling means for them.
 *
 * MusicBrainz dates are frequently incomplete — "1974" and "1974-05" are as
 * normal as "1974-05-01" — so partial dates are first-class here rather than
 * being coerced into a full timestamp that invents precision. A Bandcamp page
 * names a whole date ("releases 14 March 2026"), and reads the same way.
 *
 * Pure date arithmetic, in its own module so the scraper and the item creator
 * can ask these questions without importing the artist watch — and the
 * database and MusicBrainz client behind it.
 */

/** The year of a partial date, or null when there isn't one. */
export function parseReleaseYear(date: string | null): number | null {
  if (!date || date.length < 4) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/** The earliest instant a partial date could refer to. */
export function earliestInstant(date: string | null): Date | null {
  const year = parseReleaseYear(date);
  if (year === null || !date) return null;

  const month = date.length >= 7 ? Number.parseInt(date.slice(5, 7), 10) : 1;
  const day = date.length >= 10 ? Number.parseInt(date.slice(8, 10), 10) : 1;
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;

  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * The reminder date for an announced release, per the design's mapping:
 *
 * | `first-release-date` | `remind_at`             |
 * |----------------------|-------------------------|
 * | `2026-09-18`         | that date               |
 * | `2026-09`            | 1st of that month       |
 * | `2027` (future year) | 1st January of that year|
 * | `2026` (current year)| none                    |
 *
 * A year-only date in the current year can't be scheduled meaningfully — it
 * may already have passed — so the item goes straight into To Listen rather
 * than being scheduled into the past. Anything already elapsed maps to null
 * for the same reason.
 */
export function remindAtForReleaseDate(date: string | null, now: Date = new Date()): Date | null {
  const instant = earliestInstant(date);
  if (!instant) return null;

  // Year-only: only meaningful when the whole year is still ahead.
  if (date && date.length === 4 && instant.getUTCFullYear() <= now.getUTCFullYear()) {
    return null;
  }

  return instant.getTime() > now.getTime() ? instant : null;
}

/** A release the source says hasn't happened yet. */
export function isAnnouncedRelease(date: string | null, now: Date = new Date()): boolean {
  return remindAtForReleaseDate(date, now) !== null;
}

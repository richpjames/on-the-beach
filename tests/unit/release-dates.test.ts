import { describe, expect, test } from "bun:test";
import { bareReleaseYear } from "../../domain/release-dates";

describe("bareReleaseYear", () => {
  const NOW = new Date("2026-11-09T12:00:00Z");

  test("reads a year that stands alone", () => {
    expect(bareReleaseYear("1973", NOW)).toBe(1973);
    expect(bareReleaseYear(" 1999 ", NOW)).toBe(1999);
  });

  test("allows next year, for a record announced ahead of its release", () => {
    expect(bareReleaseYear("2027", NOW)).toBe(2027);
    expect(bareReleaseYear("2028", NOW)).toBeNull();
  });

  test.each(["1973-05", "Summer 1973", "Guaco 76", "73", "1349", "2112", ""])(
    "leaves '%s' to be a name",
    (text) => {
      expect(bareReleaseYear(text, NOW)).toBeNull();
    },
  );
});

/**
 * The record label inside a copyright line.
 *
 * Both sources that name a label ship it as a copyright line — Apple's iTunes
 * lookup as "℗ 2024 Bronze", Bandcamp's credits as "© ℗ 2024 Blue Note
 * Records" — with the symbols and year(s) prefixing everything and the label
 * name the rest of the line.
 */

/**
 * A copyright line with its leading symbols and year(s) stripped off, or
 * undefined when nothing but those remains. Years may run comma-separated
 * ("℗ 2023, 2024 Warp") or as a range ("℗ 2023-2024 Warp"); a name that
 * itself begins with digits ("© 2024 4AD") is kept whole.
 */
export function labelNameFromCopyrightLine(line: string): string | undefined {
  const name = line
    .replace(/^[©℗&\s]+/, "")
    .replace(/^(?:\d{4}(?:\s*[,–—-]\s*\d{4})*)[\s,·–—-]*/, "")
    .trim();
  return name.length > 0 ? name : undefined;
}

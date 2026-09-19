/**
 * Small text and URL helpers shared across every layer.
 *
 * Pure string work only — nothing here knows about a source, a database or a
 * page. Source-aware URL classification lives in `adapters/registry.ts`.
 */

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalize(text: string): string {
  return text.toLowerCase().trim();
}

export function capitalize(text: string): string {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The Pitchfork adapter. A review page tells you who and what it is about in
 * two places: the OG title ("{Artist}: {Album} Album Review | Pitchfork") and
 * a JSON-LD Review record naming the reviewed MusicRelease directly. JSON-LD
 * wins where the two disagree — it is structured, not pattern-matched.
 */
import {
  extractImageFromJsonLdValue,
  extractName,
  firstDefined,
  getString,
  getTypeText,
  hasScrapedMetadata,
  isRecord,
  parseJsonLdScripts,
  parseOgTags,
  type OgData,
  type ScrapedMetadata,
} from "../web/html-metadata";
import { fetchPageHtml, MAX_HEAD_BYTES } from "../web/fetch-page";

// Pitchfork og:title is "{Artist}: {Album} Album Review | Pitchfork".
// For multi-artist reviews it's "{Artist1} / {Artist2}: {Album} ...".
export function parsePitchforkOg(og: OgData): ScrapedMetadata {
  const rawTitle = og.ogTitle || og.title || "";
  const stripped = rawTitle
    .replace(/\s*\|\s*Pitchfork\s*$/i, "")
    .replace(/\s+Album\s+Review\s*$/i, "")
    .replace(/\s+EP\s+Review\s*$/i, "")
    .trim();

  const colonIdx = stripped.indexOf(":");
  if (colonIdx > 0) {
    const artist = stripped
      .slice(0, colonIdx)
      .replace(/\s*\/\s*/g, ", ")
      .trim();
    const title = stripped.slice(colonIdx + 1).trim();
    return {
      potentialArtist: artist || undefined,
      potentialTitle: title || undefined,
      imageUrl: og.ogImage,
      itemType: "album",
    };
  }

  return {
    potentialTitle: stripped || undefined,
    imageUrl: og.ogImage,
    itemType: "album",
  };
}

function extractArtistsFromJsonLdValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const names = value
      .map((item) => extractName(item))
      .filter((name): name is string => Boolean(name));
    return names.length ? names.join(", ") : undefined;
  }
  return extractName(value);
}

function extractYearFromJsonLdValue(value: unknown): number | undefined {
  const str = getString(value);
  if (!str) return undefined;
  const match = str.match(/\b(19|20)\d{2}\b/);
  if (!match) return undefined;
  const year = Number.parseInt(match[0], 10);
  return Number.isFinite(year) ? year : undefined;
}

export function parsePitchforkJsonLd(html: string): ScrapedMetadata {
  const entries = parseJsonLdScripts(html);

  for (const entry of entries) {
    const typeText = getTypeText(entry["@type"]);
    if (!/review/i.test(typeText)) continue;

    const reviewed = entry.itemReviewed;
    if (!isRecord(reviewed)) continue;

    const reviewedType = getTypeText(reviewed["@type"]);
    if (!/musicalbum|musicrelease/i.test(reviewedType)) continue;

    const potentialTitle = getString(reviewed.name);
    const potentialArtist = extractArtistsFromJsonLdValue(reviewed.byArtist);
    const imageUrl =
      extractImageFromJsonLdValue(reviewed.image) ?? extractImageFromJsonLdValue(entry.image);
    const year = extractYearFromJsonLdValue(reviewed.datePublished);

    if (potentialArtist || potentialTitle || imageUrl || year !== undefined) {
      return {
        potentialArtist,
        potentialTitle,
        imageUrl,
        year,
        itemType: "album",
      };
    }
  }

  return {};
}

/** Scrape a Pitchfork review: OG title and JSON-LD Review, merged. */
export async function scrapePitchfork(
  url: string,
  timeoutMs: number,
): Promise<ScrapedMetadata | null> {
  const html = await fetchPageHtml(url, timeoutMs, { maxBytes: MAX_HEAD_BYTES, stopAt: "</head>" });
  if (html === null) return null;

  const ogResult = parsePitchforkOg(parseOgTags(html));
  const jsonLd = parsePitchforkJsonLd(html);
  const merged: ScrapedMetadata = {
    potentialArtist: firstDefined(jsonLd.potentialArtist, ogResult.potentialArtist),
    potentialTitle: firstDefined(jsonLd.potentialTitle, ogResult.potentialTitle),
    imageUrl: firstDefined(jsonLd.imageUrl, ogResult.imageUrl),
    year: jsonLd.year ?? ogResult.year,
    itemType: ogResult.itemType ?? "album",
  };
  return hasScrapedMetadata(merged) ? merged : null;
}

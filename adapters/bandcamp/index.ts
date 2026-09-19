/**
 * The Bandcamp adapter.
 *
 * Bandcamp has no API to speak of, so everything is read off the page: the OG
 * title names artist and release ("Release Title, by Artist Name"), the
 * `TralbumData` JSON in the body carries the `album_id` the embedded player
 * needs, and the credits state the release date. All three need the page body,
 * not just the head.
 */
import {
  decodeHtmlEntities,
  parseOgTags,
  type OgData,
  type ScrapedMetadata,
} from "../web/html-metadata";
import { fetchPageHtml, MAX_BODY_BYTES } from "../web/fetch-page";
import { stripHtmlForAnalysis } from "../web";
import { parseReleaseYear } from "../../domain/release-dates";

export function parseBandcampOg(og: OgData): ScrapedMetadata {
  const title = og.ogTitle || og.title || "";
  // Bandcamp format: "Release Title, by Artist Name"
  const byMatch = title.match(/^(.+?),\s*by\s+(.+)$/i);
  if (byMatch) {
    return {
      potentialTitle: byMatch[1].trim(),
      potentialArtist: byMatch[2].trim(),
      imageUrl: og.ogImage,
    };
  }
  return { potentialTitle: title || undefined, imageUrl: og.ogImage };
}

export function extractBandcampEmbedMetadata(html: string): Record<string, string> | null {
  // Primary: <meta name="bc-page-properties" content='{"item_type":"album","item_id":123}'>
  // Use flexible patterns to handle extra attributes and either attribute order.
  const metaMatch =
    html.match(/<meta\s[^>]*?name="bc-page-properties"[^>]*?content='([^']+)'/i) ??
    html.match(/<meta\s[^>]*?name='bc-page-properties'[^>]*?content='([^']+)'/i) ??
    html.match(/<meta\s[^>]*?name="bc-page-properties"[^>]*?content="([^"]+)"/i) ??
    html.match(/<meta\s[^>]*?name='bc-page-properties'[^>]*?content="([^"]+)"/i) ??
    html.match(/<meta\s[^>]*?content='([^']+)'[^>]*?name="bc-page-properties"/i) ??
    html.match(/<meta\s[^>]*?content="([^"]+)"[^>]*?name="bc-page-properties"/i);
  if (metaMatch) {
    try {
      const parsed = JSON.parse(decodeHtmlEntities(metaMatch[1])) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const id = obj.item_id;
        const type = obj.item_type;
        const idNum = typeof id === "number" ? id : typeof id === "string" ? Number(id) : NaN;
        if (Number.isFinite(idNum) && idNum > 0) {
          return {
            album_id: String(idNum),
            ...(typeof type === "string" ? { item_type: type } : {}),
          };
        }
      }
    } catch {
      // fall through to TralbumData
    }
  }

  // Fallback: TralbumData = { "id" : 123, "item_type" : "album" }
  // This runs whether or not bc-page-properties was found, in case it was present but invalid.
  const tralbumIdMatch = html.match(/TralbumData\s*=\s*\{[\s\S]*?"id"\s*:\s*(\d+)/);
  const tralbumTypeMatch = html.match(/TralbumData\s*=\s*\{[\s\S]*?"item_type"\s*:\s*"([^"]+)"/);
  if (tralbumIdMatch) {
    return {
      album_id: tralbumIdMatch[1],
      ...(tralbumTypeMatch ? { item_type: tralbumTypeMatch[1] } : {}),
    };
  }

  return null;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/** `2026-03-14` from a day, a month name (or its three-letter short form) and a year. */
function toIsoDate(day: string, monthName: string, year: string): string | undefined {
  const lower = monthName.toLowerCase();
  const month = MONTH_NAMES.findIndex((name) => name.startsWith(lower.slice(0, 3)));
  if (month < 0) return undefined;

  const dayNum = Number.parseInt(day, 10);
  if (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > 31) return undefined;

  return `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
}

/**
 * "released 14 March 2024" (worldwide) or "released March 14, 2024" (US), read
 * out of a fragment of markup — "releases" where the record isn't out yet.
 */
function matchVisibleReleaseDate(fragment: string): string | undefined {
  const text = stripHtmlForAnalysis(fragment);
  const months = MONTH_NAMES.join("|");

  const dayFirst = text.match(
    new RegExp(String.raw`\brelease[ds]\s+(\d{1,2})\s+(${months})\s+(\d{4})`, "i"),
  );
  if (dayFirst) return toIsoDate(dayFirst[1], dayFirst[2], dayFirst[3]);

  const monthFirst = text.match(
    new RegExp(String.raw`\brelease[ds]\s+(${months})\s+(\d{1,2}),?\s+(\d{4})`, "i"),
  );
  if (monthFirst) return toIsoDate(monthFirst[2], monthFirst[1], monthFirst[3]);

  return undefined;
}

/**
 * The release date a Bandcamp page names, as `YYYY-MM-DD`.
 *
 * Every album and track page states it in the credits under the tracklist —
 * "released 14 March 2024" for something already out, "releases 14 March 2026"
 * for a pre-order. That one word is the whole difference between a record to
 * listen to now and one to be reminded about, so it's worth reading: the
 * caller turns a date still to come into the item's schedule.
 *
 * The credits block is searched before the rest of the page, because the
 * sleeve notes above it are free text and a reissue's "originally released
 * March 1985" would otherwise be read as this record's date. `TralbumData`'s
 * GMT timestamp is the last resort, for layouts that render no credits at all
 * (an embed, say); it can sit a day either side of what the page displays.
 */
export function parseBandcampReleaseDate(html: string): string | undefined {
  const credits = html.match(
    /<[^>]*class=["'][^"']*tralbum-credits[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  const fromCredits = credits ? matchVisibleReleaseDate(credits[1]) : undefined;
  if (fromCredits) return fromCredits;

  const fromPage = matchVisibleReleaseDate(html);
  if (fromPage) return fromPage;

  // Fallback: TralbumData's "release_date" / "album_release_date", which read
  // as "14 Mar 2026 00:00:00 GMT".
  const embedded = html.match(
    /"(?:album_)?release_date"\s*:\s*"(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/,
  );
  if (embedded) return toIsoDate(embedded[1], embedded[2], embedded[3]);

  return undefined;
}

/** Scrape a Bandcamp album or track page: OG tags, embed id and release date. */
export async function scrapeBandcamp(
  url: string,
  timeoutMs: number,
): Promise<ScrapedMetadata | null> {
  const html = await fetchPageHtml(url, timeoutMs, { maxBytes: MAX_BODY_BYTES, stopAt: "</body>" });
  if (html === null) return null;

  const result = parseBandcampOg(parseOgTags(html));
  result.embedMetadata = extractBandcampEmbedMetadata(html) ?? undefined;
  const releaseDate = parseBandcampReleaseDate(html);
  if (releaseDate) {
    result.releaseDate = releaseDate;
    // Bandcamp's OG tags name no year, so the date it prints is the only
    // one going — fill the item's year in from it.
    result.year ??= parseReleaseYear(releaseDate) ?? undefined;
  }
  return result;
}

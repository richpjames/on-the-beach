/**
 * The NTS adapter. An NTS episode page is a mix page: the OG title names the
 * show, and the canonical URL is the stable link an episode should be filed
 * under — episode URLs carry a slug that changes with each rebroadcast.
 */
import { firstDefined, parseOgTags, type OgData, type ScrapedMetadata } from "../web/html-metadata";
import { fetchPageHtml, MAX_HEAD_BYTES } from "../web/fetch-page";
import { parseCanonicalUrl } from "../web";

export function parseNtsOg(og: OgData): ScrapedMetadata {
  const rawTitle = og.ogTitle || og.title || "";
  // NTS format: "Show Name - Episode Info | NTS Radio" or "Show Name | NTS"
  const title = rawTitle
    .replace(/\s*\|\s*NTS(?:\s+Radio)?\s*$/i, "")
    .replace(/\s+on\s+NTS(?:\s+Radio)?\s*$/i, "")
    .trim();

  return {
    potentialTitle: title || undefined,
    imageUrl: og.ogImage,
    itemType: "mix",
  };
}

/** Scrape an NTS episode page: the show from OG tags, the canonical URL beside it. */
export async function scrapeNts(url: string, timeoutMs: number): Promise<ScrapedMetadata | null> {
  const html = await fetchPageHtml(url, timeoutMs, { maxBytes: MAX_HEAD_BYTES, stopAt: "</head>" });
  if (html === null) return null;

  const og = parseOgTags(html);
  const result = parseNtsOg(og);
  const canonicalUrl = firstDefined(og.metaTags?.["og:url"], parseCanonicalUrl(html)) || undefined;
  if (canonicalUrl) result.canonicalUrl = canonicalUrl;
  return result;
}

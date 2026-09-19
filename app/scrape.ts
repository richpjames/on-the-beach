/**
 * Scraping a music link into draft-item metadata.
 *
 * This is the use case the source adapters serve: classify the URL (registry),
 * hand it to the source's adapter, and fall back to the web adapter for a
 * source we model only by its OG tags — or not at all.
 */
import type { SourceName } from "../domain/types";
import type { ScrapedMetadata } from "../adapters/web/html-metadata";
import { SOURCE_SCRAPERS } from "../adapters/registry";
import { scrapeOgPage, scrapeUnknownWebPage } from "../adapters/web";

export { UnsupportedMusicLinkError } from "../adapters/web";
export type { ScrapedMetadata } from "../adapters/web/html-metadata";

export async function scrapeUrl(
  url: string,
  source: SourceName,
  timeoutMs = 5000,
): Promise<ScrapedMetadata | null> {
  if (source === "unknown") return scrapeUnknownWebPage(url, timeoutMs);

  const scrape = SOURCE_SCRAPERS[source];
  return scrape ? scrape(url, timeoutMs) : scrapeOgPage(url, timeoutMs);
}

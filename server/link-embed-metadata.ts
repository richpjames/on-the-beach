import { scrapeUrl } from "./scraper";
import { parseUrl } from "./utils";

/**
 * Player metadata for a link added by hand on the release page.
 *
 * A link that arrives with a new release is scraped as part of creating it, and
 * the player-specific part of that scrape — Bandcamp's `album_id` — is stored
 * on the link. A link added later got none of that, so the release page was
 * left holding a Bandcamp URL it had no way to build a player from. Scraping
 * here puts both paths on the same footing.
 *
 * Bandcamp is the only source that needs it: every other embed the release page
 * builds is derived from the URL itself.
 *
 * Returns the JSON to store in `music_links.metadata`, or null when there is
 * nothing to store. `scrape` is injectable for tests.
 */
export async function scrapeLinkEmbedMetadata(
  url: string,
  scrape: typeof scrapeUrl = scrapeUrl,
): Promise<string | null> {
  const { source, normalizedUrl } = parseUrl(url);
  if (source !== "bandcamp") return null;

  try {
    const embedMetadata = (await scrape(normalizedUrl, source))?.embedMetadata;
    if (!embedMetadata || Object.keys(embedMetadata).length === 0) return null;
    return JSON.stringify(embedMetadata);
  } catch {
    // A link we can't reach is still worth keeping — it just doesn't get a
    // player.
    return null;
  }
}

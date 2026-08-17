import { scrapeOgImage, scrapeUrl } from "./scraper";
import { parseUrl } from "./utils";

/**
 * What a link added by hand on the release page is worth scraping for.
 *
 * A link that arrives with a new release is scraped as part of creating it, and
 * two things are lifted from that scrape: the player-specific ids stored on the
 * link (Bandcamp's `album_id`), and the cover art stored on the release. A link
 * added later got neither, so the release page was left holding a Bandcamp URL
 * it had no way to build a player from, and a release added without a picture
 * (a scanned cover, a hand-typed title) stayed pictureless even once a link to
 * its page was added. Scraping here puts both paths on the same footing.
 *
 * Bandcamp is the only source needing embed metadata: every other embed the
 * release page builds is derived from the URL itself. Cover art is worth
 * looking for on any source, but only when the release hasn't got one — a
 * scrape nobody needs is a page fetch nobody asked for.
 */
export interface AddedLinkScrape {
  /** JSON to store in `music_links.metadata`, or null when there's nothing to store. */
  metadata: string | null;
  /** Cover art the link's page advertises, or null. */
  imageUrl: string | null;
}

export interface AddedLinkScrapeDeps {
  scrape: typeof scrapeUrl;
  scrapeImage: typeof scrapeOgImage;
}

export const defaultAddedLinkScrapeDeps: AddedLinkScrapeDeps = {
  scrape: scrapeUrl,
  scrapeImage: scrapeOgImage,
};

const NOTHING: AddedLinkScrape = { metadata: null, imageUrl: null };

/**
 * Artwork is stored as-is and later rendered by the release page, which only
 * accepts an absolute http(s) URL or a local upload path — so a relative or
 * `data:` og:image is dropped here rather than saved to be ignored.
 */
function usableArtworkUrl(url: string | undefined | null): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/**
 * Scrape a hand-added link for what the release can use from it.
 *
 * `wantsArtwork` should be false when the release already has a picture — the
 * caller's own artwork always wins, and saying so up front lets a link needing
 * nothing else skip the fetch altogether. Never throws: a link we can't reach
 * is still worth keeping, it just doesn't get a player or a cover.
 */
export async function scrapeAddedLink(
  url: string,
  wantsArtwork: boolean,
  deps: AddedLinkScrapeDeps = defaultAddedLinkScrapeDeps,
): Promise<AddedLinkScrape> {
  const { source, normalizedUrl } = parseUrl(url);
  const wantsEmbedMetadata = source === "bandcamp";

  if (!wantsEmbedMetadata && !wantsArtwork) return NOTHING;

  if (source === "unknown") {
    return { metadata: null, imageUrl: usableArtworkUrl(await deps.scrapeImage(normalizedUrl)) };
  }

  try {
    const scraped = await deps.scrape(normalizedUrl, source);

    const embedMetadata = wantsEmbedMetadata ? scraped?.embedMetadata : undefined;
    const hasEmbedMetadata = embedMetadata && Object.keys(embedMetadata).length > 0;

    return {
      metadata: hasEmbedMetadata ? JSON.stringify(embedMetadata) : null,
      imageUrl: wantsArtwork ? usableArtworkUrl(scraped?.imageUrl) : null,
    };
  } catch {
    return NOTHING;
  }
}

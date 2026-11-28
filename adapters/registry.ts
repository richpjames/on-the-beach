/**
 * The source registry: the one place a music source is wired into the app.
 *
 * A source is a folder in `adapters/` (Apple Music, Discogs, MusicBrainz…) that
 * knows how to scrape and search its own pages. This file is the whole of its
 * connection to the rest of the app:
 *
 * 1. `URL_PATTERNS` — recognising and normalising a link on that source, so a
 *    URL can be classified without fetching anything;
 * 2. `SOURCE_SCRAPERS` — the scrape to run once the source is known;
 * 3. `sourceNamesReleaseDate` — whether the source's pages state a release
 *    date (see `ScrapedMetadata.releaseDate`). Asking is what saves a page
 *    fetch: a client wanting nothing but the date has no reason to scrape a
 *    Spotify link that will never carry one.
 *
 * Adding a source is a new folder plus an entry here — never an edit to a
 * shared file. Sources without a scrape of their own (Tidal, Deezer, physical)
 * fall back to the web adapter's generic OG scrape.
 */
import type { SourceName } from "../domain/types";
import type { ScrapedMetadata } from "./web/html-metadata";
import { scrapeAppleMusic } from "./apple-music/index";
import { scrapeBandcamp } from "./bandcamp";
import { fetchDiscogsRelease } from "./discogs";
import { scrapeEbay } from "./ebay/index";
import { scrapeMixcloud } from "./mixcloud";
import { scrapeNts } from "./nts";
import { scrapePitchfork } from "./pitchfork";
import { scrapeQobuz } from "./qobuz/index";
import { scrapeSoundcloud } from "./soundcloud";
import { scrapeYouTube } from "./youtube";

export interface ParsedUrl {
  source: SourceName;
  normalizedUrl: string;
  potentialArtist?: string;
  potentialTitle?: string;
  /** The marketplace listing's own id, from the entry's `listingId` hook. */
  listingId?: string;
  /** Words the listing's URL slug carries — evidence when no client title arrived. */
  slugText?: string;
}

const URL_PATTERNS: Array<{
  source: SourceName;
  pattern: RegExp;
  normalizer?: (match: RegExpMatchArray) => string;
  extractor?: (match: RegExpMatchArray) => { potentialArtist?: string; potentialTitle?: string };
  /**
   * The listing's id on its marketplace — global across the site's country
   * domains, so it (not the TLD-bearing URL) is what duplicate shares dedupe
   * on. See `marketplaceListingKey`.
   */
  listingId?: (match: RegExpMatchArray) => string | undefined;
  /** The slug read as words, for marketplaces whose slugs carry them. */
  slugText?: (match: RegExpMatchArray) => string | undefined;
}> = [
  {
    source: "bandcamp",
    pattern: /^https?:\/\/([^.]+)\.bandcamp\.com(?:\/(?:album|track)\/([^/?]+))?/,
    extractor: (match) => ({
      potentialArtist: match[1]?.replace(/-/g, " "),
      potentialTitle: match[2]?.replace(/-/g, " "),
    }),
  },
  {
    source: "spotify",
    pattern: /^https?:\/\/open\.spotify\.com\/(album|track|playlist)\/([a-zA-Z0-9]+)/,
  },
  {
    source: "soundcloud",
    pattern: /^https?:\/\/(?:www\.)?soundcloud\.com\/([^/]+)(?:\/([^/?]+))?/,
    extractor: (match) => ({
      potentialArtist: match[1]?.replace(/-/g, " "),
      potentialTitle: match[2]?.replace(/-/g, " "),
    }),
  },
  {
    source: "youtube",
    pattern: /^https?:\/\/(?:(?:www|m)\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/,
    normalizer: (match) => `https://www.youtube.com/watch?v=${match[2]}`,
  },
  {
    source: "youtube",
    pattern: /^https?:\/\/(?:(?:www|m)\.)?youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/,
    normalizer: (match) => `https://www.youtube.com/playlist?list=${match[1]}`,
  },
  {
    source: "apple_music",
    pattern:
      /^https?:\/\/music\.apple\.com\/[a-z]{2}\/(album|playlist|artist|music-video|station)\/([^/]+)/,
    extractor: (match) => {
      const slug = match[2]?.replace(/-/g, " ");
      if (match[1] === "artist") return { potentialArtist: slug };
      return { potentialTitle: slug };
    },
  },
  {
    // Discogs renamed marketplace listing pages from /sell/item/<id> to
    // /shop/item/<id>. Both paths serve the same listing id — the API's own
    // `uri` field still answers with the /sell/ form — so accept either and
    // normalise to /sell/, keeping a listing shared under both spellings one
    // item rather than two.
    source: "discogs",
    pattern:
      /^https?:\/\/(?:www\.)?discogs\.com\/(?:(?:release|master)\/\d+|(?:sell|shop)\/item\/\d+)/,
    normalizer: (match) =>
      (match.input ?? match[0]).split("?")[0].replace("/shop/item/", "/sell/item/"),
  },
  {
    source: "tidal",
    pattern:
      /^https?:\/\/(?:www\.|listen\.)?tidal\.com\/(?:browse\/)?(album|track|playlist)\/(\d+)/,
  },
  {
    source: "mixcloud",
    pattern: /^https?:\/\/(?:www\.)?mixcloud\.com\/([^/]+)\/([^/?]+)/,
    extractor: (match) => ({
      potentialArtist: match[1]?.replace(/-/g, " "),
      potentialTitle: match[2]?.replace(/-/g, " "),
    }),
  },
  {
    source: "deezer",
    pattern: /^https?:\/\/(?:www\.)?deezer\.com\/[a-z]{2}\/(album|track|playlist)\/(\d+)/,
  },
  {
    // Qobuz store URLs carry a locale and a slug that concatenates title and
    // artist ("kind-of-blue-miles-davis") — too ambiguous to split, so names
    // come from the API scrape instead. Artist pages are filed under
    // "interpreter"; their slug is the artist alone.
    source: "qobuz",
    pattern:
      /^https?:\/\/(?:www\.)?qobuz\.com\/[a-z]{2}-[a-z]{2}\/(album|track|playlist|interpreter|artist)\/([^/]+)\/([a-zA-Z0-9]+)/,
    extractor: (match) => {
      if (match[1] === "interpreter" || match[1] === "artist") {
        return { potentialArtist: match[2]?.replace(/-/g, " ") };
      }
      return {};
    },
  },
  {
    // The player's share links carry no slug or locale — the same resource
    // under a second spelling, classified but not normalised into the store
    // form (the slug needed for that is only knowable from the API).
    source: "qobuz",
    pattern: /^https?:\/\/play\.qobuz\.com\/(album|track|playlist|artist)\/([a-zA-Z0-9]+)/,
  },
  {
    source: "nts",
    pattern: /^https?:\/\/(?:www\.)?nts\.live\/shows\/([^/]+)(?:\/episodes\/([^/?]+))?/,
    extractor: (match) => ({
      potentialArtist: match[1]?.replace(/-/g, " "),
      potentialTitle: match[2]?.replace(/-/g, " "),
    }),
  },
  {
    // Pitchfork review slugs concatenate artist(s) and album with hyphens, so
    // they can't be split reliably from the URL alone — leave artist/title for
    // the page scraper to recover from OG tags / JSON-LD.
    source: "pitchfork",
    pattern: /^https?:\/\/(?:www\.)?pitchfork\.com\/reviews\/albums\/[^/?]+/,
  },
  {
    // eBay's country sites (ebay.es, ebay.co.uk, …) share one catalogue of
    // listings. The normaliser keeps the TLD — it sets the currency and the
    // Browse API's marketplace header — while dedupe runs on the listing id,
    // which is global across every country site. The id is the digits after
    // /itm/, optionally behind a title slug.
    source: "ebay",
    pattern: /^https?:\/\/(?:www\.)?ebay\.([a-z]{2,3}(?:\.[a-z]{2})?)\/itm\/(?:[^/?]+\/)?(\d+)/,
    normalizer: (match) => `https://www.ebay.${match[1]}/itm/${match[2]}`,
    listingId: (match) => match[2],
  },
  {
    // Wallapop slugs carry the seller's words ("vinilo-camaron-la-leyenda-del-
    // tiempo-1979-1320305358"): the trailing digits are the listing id, the
    // words before them are evidence when the share arrived with no title.
    source: "wallapop",
    pattern: /^https?:\/\/(?:[a-z]{2}\.)?wallapop\.com\/item\/([^/?]+)/,
    listingId: (match) => match[1]?.match(/(\d+)$/)?.[1],
    slugText: (match) => {
      const words = (match[1] ?? "")
        .replace(/-?\d+$/, "")
        .replace(/-/g, " ")
        .trim();
      return /[a-z]/i.test(words) ? words : undefined;
    },
  },
];

function stripMobileSubdomain(url: string): string {
  return url.replace(/^(https?:\/\/)m\./i, "$1");
}

/** Classify a URL: which source it belongs to, normalised, with any artist/title the URL itself carries. */
export function parseUrl(url: string): ParsedUrl {
  const trimmedUrl = stripMobileSubdomain(url.trim());

  for (const { source, pattern, normalizer, extractor, listingId, slugText } of URL_PATTERNS) {
    const match = trimmedUrl.match(pattern);
    if (match) {
      const id = listingId?.(match);
      const words = slugText?.(match);
      return {
        source,
        normalizedUrl: normalizer ? normalizer(match) : trimmedUrl.split("?")[0],
        ...extractor?.(match),
        ...(id ? { listingId: id } : {}),
        ...(words ? { slugText: words } : {}),
      };
    }
  }

  return {
    source: "unknown",
    normalizedUrl: trimmedUrl,
  };
}

/** The scrape for a source, run by `app/scrape.ts` once the source is known. */
export type SourceScrape = (url: string, timeoutMs: number) => Promise<ScrapedMetadata | null>;

export const SOURCE_SCRAPERS: Partial<Record<SourceName, SourceScrape>> = {
  apple_music: scrapeAppleMusic,
  bandcamp: scrapeBandcamp,
  discogs: fetchDiscogsRelease,
  ebay: scrapeEbay,
  mixcloud: scrapeMixcloud,
  nts: scrapeNts,
  pitchfork: scrapePitchfork,
  qobuz: scrapeQobuz,
  soundcloud: scrapeSoundcloud,
  youtube: scrapeYouTube,
};

/** Whether a source's pages state a release date worth scraping for. */
export function sourceNamesReleaseDate(source: SourceName): boolean {
  return source === "bandcamp" || source === "qobuz";
}

/**
 * Whether a source is a marketplace: one copy of one release for sale, on a
 * site that blocks server fetches. The listing's metadata is captured by the
 * share client instead (see the creator's marketplace branch). The `sources`
 * table stays the display authority — this is the static capability query,
 * same pattern as `sourceNamesReleaseDate`.
 */
export function sourceIsMarketplace(source: SourceName): boolean {
  return source === "ebay" || source === "wallapop";
}

/**
 * The dedupe key for a marketplace link: `<source>:<listing id>`. Listing ids
 * are global across a marketplace's country sites, so this one key matches
 * every site variant of the same listing — present and future — while the
 * TLD-bearing URL is still what gets stored. Null when the source isn't a
 * marketplace or its entry yields no id; those links dedupe on the exact
 * normalised URL, as everything else does.
 */
export function marketplaceListingKey(url: string): string | null {
  const parsed = parseUrl(url);
  if (!sourceIsMarketplace(parsed.source) || !parsed.listingId) return null;
  return `${parsed.source}:${parsed.listingId}`;
}

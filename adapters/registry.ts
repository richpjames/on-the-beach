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
import { scrapeMixcloud } from "./mixcloud";
import { scrapeNts } from "./nts";
import { scrapePitchfork } from "./pitchfork";
import { scrapeSoundcloud } from "./soundcloud";
import { scrapeYouTube } from "./youtube";

export interface ParsedUrl {
  source: SourceName;
  normalizedUrl: string;
  potentialArtist?: string;
  potentialTitle?: string;
}

const URL_PATTERNS: Array<{
  source: SourceName;
  pattern: RegExp;
  normalizer?: (match: RegExpMatchArray) => string;
  extractor?: (match: RegExpMatchArray) => { potentialArtist?: string; potentialTitle?: string };
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
];

function stripMobileSubdomain(url: string): string {
  return url.replace(/^(https?:\/\/)m\./i, "$1");
}

/** Classify a URL: which source it belongs to, normalised, with any artist/title the URL itself carries. */
export function parseUrl(url: string): ParsedUrl {
  const trimmedUrl = stripMobileSubdomain(url.trim());

  for (const { source, pattern, normalizer, extractor } of URL_PATTERNS) {
    const match = trimmedUrl.match(pattern);
    if (match) {
      return {
        source,
        normalizedUrl: normalizer ? normalizer(match) : trimmedUrl.split("?")[0],
        ...extractor?.(match),
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
  mixcloud: scrapeMixcloud,
  nts: scrapeNts,
  pitchfork: scrapePitchfork,
  soundcloud: scrapeSoundcloud,
  youtube: scrapeYouTube,
};

/** Whether a source's pages state a release date worth scraping for. */
export function sourceNamesReleaseDate(source: SourceName): boolean {
  return source === "bandcamp";
}

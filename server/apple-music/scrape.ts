/**
 * Everything the app knows about scraping and searching Apple Music.
 *
 * Apple exposes the same release through three different doors, and none of
 * them is reliably complete: oEmbed is fast but often omits the artist, the
 * open iTunes lookup fills the gaps by numeric id, and the page's OG tags are
 * the last resort. `fetchAppleMusicApiMetadata` walks that ladder so
 * `scraper.ts` holds only the dispatch — the same division `mixcloud.ts` uses.
 *
 * Searching is a separate concern from scraping and satisfies the
 * `ServiceSearch` port: `searchAppleMusic` prefers the MusicKit catalogue API
 * (see `./catalog`) and falls back to the open iTunes Search API here.
 */
import type { ServiceSearchResult } from "../../ports/service-search";
import {
  firstDefined,
  getString,
  hasScrapedMetadata,
  isRecord,
  type OgData,
  type ScrapedMetadata,
} from "../html-metadata";
import { searchAppleMusicCatalog } from "./catalog";
import { normalizeForMatch } from "./match";

// ---------------------------------------------------------------------------
// Scraping a known Apple Music URL
// ---------------------------------------------------------------------------

export function parseAppleMusicOg(og: OgData): ScrapedMetadata {
  const result: ScrapedMetadata = { imageUrl: og.ogImage };
  const title = og.ogTitle?.trim();

  if (title) {
    const byMatch = title.match(/^(.+?)\s+by\s+(.+?)\s+on\s+Apple Music$/i);
    if (byMatch) {
      result.potentialTitle = byMatch[1].trim();
      result.potentialArtist = byMatch[2].trim();
    } else {
      result.potentialTitle = title;
    }
  }

  // og:description is often "Artist · YEAR · N Songs", but may also be "Release · ...".
  if (!result.potentialArtist && og.ogDescription) {
    const artistMatch = og.ogDescription.match(/^(.+?)\s+[·-]\s+/i);
    const candidateArtist = artistMatch?.[1]?.trim();
    if (
      candidateArtist &&
      !/^(album|playlist|station|music video|single|ep)$/i.test(candidateArtist)
    ) {
      result.potentialArtist = candidateArtist;
    }
  }

  return result;
}
export function isCompleteAppleMusicMetadata(
  metadata: ScrapedMetadata | null | undefined,
): metadata is ScrapedMetadata {
  return Boolean(metadata?.potentialArtist && metadata?.potentialTitle && metadata?.imageUrl);
}

function mergeAppleMusicMetadata(
  ...entries: Array<ScrapedMetadata | null | undefined>
): ScrapedMetadata | null {
  const merged: ScrapedMetadata = {
    potentialArtist: firstDefined(...entries.map((entry) => entry?.potentialArtist)),
    potentialTitle: firstDefined(...entries.map((entry) => entry?.potentialTitle)),
    imageUrl: firstDefined(...entries.map((entry) => entry?.imageUrl)),
  };

  return hasScrapedMetadata(merged) ? merged : null;
}
async function scrapeAppleMusicOEmbed(
  url: string,
  timeoutMs: number,
): Promise<ScrapedMetadata | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const oembedUrl = `https://music.apple.com/api/oembed?url=${encodeURIComponent(url)}`;

    const response = await fetch(oembedUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timer);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as unknown;
    if (!isRecord(data)) {
      return null;
    }

    const potentialTitle = firstDefined(getString(data.title), getString(data.name));
    const potentialArtist = firstDefined(
      getString(data.author_name),
      getString(data.author),
      getString(data.uploader),
    );
    const imageUrl = normalizeAppleMusicImageUrl(
      firstDefined(getString(data.thumbnail_url), getString(data.thumbnail), getString(data.image)),
    );

    if (!potentialTitle && !potentialArtist && !imageUrl) {
      return null;
    }

    return {
      potentialTitle,
      potentialArtist,
      imageUrl,
    };
  } catch {
    return null;
  }
}

function extractAppleMusicLookupId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const trackId = parsed.searchParams.get("i");
    if (trackId && /^\d+$/.test(trackId)) {
      return trackId;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (/^\d+$/.test(segments[i])) {
        return segments[i];
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function normalizeAppleMusicImageUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  return url.replace(/\/\d+x\d+(?:bb|sr)\./i, "/1200x1200bb.");
}

async function scrapeAppleMusicLookup(
  url: string,
  timeoutMs: number,
): Promise<ScrapedMetadata | null> {
  try {
    const lookupId = extractAppleMusicLookupId(url);
    if (!lookupId) {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const lookupUrl = `https://itunes.apple.com/lookup?id=${encodeURIComponent(lookupId)}`;

    const response = await fetch(lookupUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timer);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as unknown;
    if (!isRecord(data) || !Array.isArray(data.results)) {
      return null;
    }

    const primary = data.results.find((entry) => isRecord(entry));
    if (!primary) {
      return null;
    }

    const potentialTitle = firstDefined(
      getString(primary.collectionName),
      getString(primary.trackName),
      getString(primary.name),
    );
    const potentialArtist = firstDefined(
      getString(primary.artistName),
      getString(primary.collectionArtistName),
    );
    const imageUrl = normalizeAppleMusicImageUrl(
      firstDefined(getString(primary.artworkUrl100), getString(primary.artworkUrl60)),
    );

    if (!potentialTitle && !potentialArtist && !imageUrl) {
      return null;
    }

    return {
      potentialTitle,
      potentialArtist,
      imageUrl,
    };
  } catch {
    return null;
  }
}

/**
 * What Apple's JSON APIs know about a URL, before the page itself is fetched.
 *
 * `oEmbed` and `lookup` are kept separate rather than pre-merged because the
 * page's OG tags slot *between* them in precedence when the ladder runs to the
 * end — see `mergeAppleMusicPageMetadata`.
 */
export interface AppleMusicApiMetadata {
  /** Apple's oEmbed endpoint, or null when it failed or gave nothing. */
  oEmbed: ScrapedMetadata | null;
  /** The iTunes lookup by numeric id — only attempted if oEmbed fell short. */
  lookup: ScrapedMetadata | null;
  /** `oEmbed` and `lookup` merged, or null when neither returned anything. */
  merged: ScrapedMetadata | null;
}

/** The starting state for a scrape of a non-Apple URL. */
export const NO_APPLE_MUSIC_API_METADATA: AppleMusicApiMetadata = {
  oEmbed: null,
  lookup: null,
  merged: null,
};

/**
 * Walk Apple's JSON APIs for a catalogue URL, cheapest first, stopping as soon
 * as the answer is complete.
 *
 * oEmbed alone is usually enough for albums; singles and deep-linked tracks
 * tend to need the iTunes lookup to name the artist. When the result is
 * complete the caller can skip fetching the page altogether.
 */
export async function fetchAppleMusicApiMetadata(
  url: string,
  timeoutMs: number,
): Promise<AppleMusicApiMetadata> {
  const oEmbed = await scrapeAppleMusicOEmbed(url, timeoutMs);
  const fromOEmbed = mergeAppleMusicMetadata(oEmbed);
  if (isCompleteAppleMusicMetadata(fromOEmbed)) {
    return { oEmbed, lookup: null, merged: fromOEmbed };
  }

  const lookup = await scrapeAppleMusicLookup(url, timeoutMs);
  return { oEmbed, lookup, merged: mergeAppleMusicMetadata(oEmbed, lookup) };
}

/**
 * The release's metadata once the page has been fetched too: the APIs still
 * win where they have an answer, with the OG tags backfilling what neither
 * door supplied.
 */
export function mergeAppleMusicPageMetadata(
  og: OgData,
  api: AppleMusicApiMetadata,
): ScrapedMetadata | null {
  return mergeAppleMusicMetadata(api.oEmbed, api.lookup, parseAppleMusicOg(og));
}

// ---------------------------------------------------------------------------
// Searching Apple Music — the ServiceSearch port
// ---------------------------------------------------------------------------
/**
 * Search Apple Music for a release by title and artist, returning the best
 * matching catalogue URL together with its cover artwork, or null if not found.
 *
 * Prefers the official Apple Music Catalog API (api.music.apple.com) when
 * MusicKit is configured — those URLs carry the catalogue ids the browser SDK
 * needs to stream full tracks — and falls back to the open iTunes Search API
 * when unconfigured or when the catalogue search comes up empty.
 */
export async function searchAppleMusic(
  title: string,
  artist: string | null,
  timeoutMs = 8000,
): Promise<ServiceSearchResult | null> {
  const catalogResult = await searchAppleMusicCatalog(title, artist, timeoutMs);
  if (catalogResult) return catalogResult;
  return searchAppleMusicViaItunes(title, artist, timeoutMs);
}

/**
 * Search Apple Music via the open iTunes Search API. Returns the Apple Music
 * URL for the best matching result together with its cover artwork, or null if
 * not found.
 *
 * Matching strategy (in order):
 *  1. Exact title + artist match
 *  2. Partial match — one title is a prefix/substring of the other (handles
 *     Wikipedia-style disambiguators like "Foo (1981 album)" vs "Foo")
 *  3. First result whose artist matches (search query is already specific)
 */
export async function searchAppleMusicViaItunes(
  title: string,
  artist: string | null,
  timeoutMs = 8000,
): Promise<ServiceSearchResult | null> {
  // Test environments set this to keep the release page deterministic — the
  // visual snapshot can't depend on whether iTunes responds in time.
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return null;

  try {
    const term = [artist, title].filter(Boolean).join(" ");
    const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=album,musicTrack,mix&limit=10`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = (await response.json()) as unknown;
    if (!isRecord(data) || !Array.isArray(data.results) || data.results.length === 0) return null;

    const normalizedTitle = normalizeForMatch(title);
    const normalizedArtist = artist ? normalizeForMatch(artist) : null;

    function artistMatches(resultArtist: string | undefined): boolean {
      if (!normalizedArtist || !resultArtist) return true;
      return normalizeForMatch(resultArtist) === normalizedArtist;
    }

    function titlesCompatible(resultTitle: string): boolean {
      const rn = normalizeForMatch(resultTitle);
      return (
        rn === normalizedTitle || rn.startsWith(normalizedTitle) || normalizedTitle.startsWith(rn)
      );
    }

    function resultUrl(result: Record<string, unknown>): string | undefined {
      const raw = firstDefined(getString(result.collectionViewUrl), getString(result.trackViewUrl));
      if (!raw) return undefined;
      try {
        const u = new URL(raw);
        u.search = "";
        if (u.hostname === "itunes.apple.com") {
          u.hostname = "music.apple.com";
          // iTunes paths use /id123456789 suffix; Apple Music uses /123456789
          u.pathname = u.pathname.replace(/\/id(\d+)$/, "/$1");
        }
        return u.toString();
      } catch {
        return raw;
      }
    }

    function toResult(result: Record<string, unknown>): ServiceSearchResult | undefined {
      const url = resultUrl(result);
      if (!url) return undefined;
      const artworkUrl =
        normalizeAppleMusicImageUrl(
          firstDefined(getString(result.artworkUrl100), getString(result.artworkUrl60)),
        ) ?? null;
      return { url, artworkUrl };
    }

    // Pass 1: exact title + artist
    for (const result of data.results) {
      if (!isRecord(result)) continue;
      const resultTitle = firstDefined(
        getString(result.collectionName),
        getString(result.trackName),
      );
      if (!resultTitle || normalizeForMatch(resultTitle) !== normalizedTitle) continue;
      if (!artistMatches(getString(result.artistName))) continue;
      const match = toResult(result);
      if (match) return match;
    }

    // Pass 2: compatible title (one is a prefix of the other) + artist
    for (const result of data.results) {
      if (!isRecord(result)) continue;
      const resultTitle = firstDefined(
        getString(result.collectionName),
        getString(result.trackName),
      );
      if (!resultTitle || !titlesCompatible(resultTitle)) continue;
      if (!artistMatches(getString(result.artistName))) continue;
      const match = toResult(result);
      if (match) return match;
    }

    // Pass 3: first result whose artist matches (search query is already scoped)
    for (const result of data.results) {
      if (!isRecord(result)) continue;
      if (!artistMatches(getString(result.artistName))) continue;
      const match = toResult(result);
      if (match) return match;
    }

    return null;
  } catch {
    return null;
  }
}

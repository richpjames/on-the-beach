import type { SourceName } from "../domain/types";
import {
  extractPageLinks,
  extractReleaseCandidatesFromWebText,
  matchReleaseUrls,
} from "./link-extractor";
import { fetchDiscogsRelease } from "./discogs";
import type { ServiceSearchResult } from "../ports/service-search";
import {
  fetchAppleMusicApiMetadata,
  isCompleteAppleMusicMetadata,
  mergeAppleMusicPageMetadata,
  NO_APPLE_MUSIC_API_METADATA,
  parseAppleMusicOg,
  type AppleMusicApiMetadata,
} from "./apple-music";
import {
  decodeHtmlEntities,
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
} from "./html-metadata";
import {
  extractMixcloudEmbedUrl,
  fetchMixcloudOEmbed,
  isCompleteMixcloudMetadata,
  mergeMixcloudPageMetadata,
  parseMixcloudOg,
} from "./mixcloud";

export type { OgData, ScrapedMetadata } from "./html-metadata";

type OgParser = (og: OgData) => ScrapedMetadata;

const MAX_HEAD_BYTES = 100_000;
const MAX_UNKNOWN_HTML_BYTES = 250_000;
const UNKNOWN_TEXT_SNIPPET_CHARS = 24_000;

const STRONG_MUSIC_TERMS = [
  "album",
  "release",
  "track",
  "tracks",
  "single",
  "vinyl",
  "vol",
  "discography",
  "ep",
  "lp",
  "cassette",
  "catalog",
  "catalogue",
  "label",
] as const;

const WEAK_MUSIC_TERMS = [
  "artist",
  "music",
  "listen",
  "stream",
  "playlist",
  "song",
  "songs",
] as const;

export class UnsupportedMusicLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMusicLinkError";
  }
}

export interface MusicSignalResult {
  isMusicRelated: boolean;
  matchedTerms: string[];
}

export interface MusicSignalContext {
  url?: string;
  og?: OgData;
}

function stripHtmlForAnalysis(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function buildMusicSignalText(html: string, { url, og }: MusicSignalContext): string {
  const parts = [stripHtmlForAnalysis(html)];
  if (og?.ogTitle) parts.push(og.ogTitle);
  if (og?.ogDescription) parts.push(og.ogDescription);
  if (og?.ogSiteName) parts.push(og.ogSiteName);
  if (og?.title) parts.push(og.title);
  if (url) {
    const pathname = new URL(url).pathname;
    parts.push(decodeURIComponent(pathname).replace(/[-_/]+/g, " "));
  }
  return parts.join(" ");
}

export function detectMusicRelatedHtml(
  html: string,
  context: MusicSignalContext = {},
): MusicSignalResult {
  const text = buildMusicSignalText(html, context).toLowerCase();
  const matchedTerms = new Set<string>();

  for (const term of STRONG_MUSIC_TERMS) {
    if (new RegExp(`\\b${term}\\b`, "i").test(text)) {
      matchedTerms.add(term);
    }
  }

  for (const term of WEAK_MUSIC_TERMS) {
    if (new RegExp(`\\b${term}\\b`, "i").test(text)) {
      matchedTerms.add(term);
    }
  }

  const strongMatchCount = STRONG_MUSIC_TERMS.filter((term) => matchedTerms.has(term)).length;
  const weakMatchCount = WEAK_MUSIC_TERMS.filter((term) => matchedTerms.has(term)).length;

  return {
    isMusicRelated: strongMatchCount > 0 || weakMatchCount >= 2,
    matchedTerms: [...matchedTerms],
  };
}

function buildUnknownPageSnippet(url: string, html: string): string {
  const og = parseOgTags(html);
  const text = stripHtmlForAnalysis(html).slice(0, UNKNOWN_TEXT_SNIPPET_CHARS);
  const parts = [
    `URL: ${url}`,
    og.ogTitle || og.title ? `Title: ${og.ogTitle || og.title}` : "",
    og.ogDescription ? `Description: ${og.ogDescription}` : "",
    og.ogSiteName ? `Site: ${og.ogSiteName}` : "",
    text ? `Visible text: ${text}` : "",
  ].filter(Boolean);

  return parts.join("\n");
}

async function scrapeUnknownUrl(url: string, html: string, og: OgData): Promise<ScrapedMetadata> {
  const signal = detectMusicRelatedHtml(html, { url, og });
  if (!signal.isMusicRelated) {
    throw new UnsupportedMusicLinkError("Link does not appear to be music-related");
  }

  const releases = await extractReleaseCandidatesFromWebText(
    url,
    buildUnknownPageSnippet(url, html),
  );
  if (releases === null) {
    throw new UnsupportedMusicLinkError(
      "Unsupported music-link extraction is unavailable on this server",
    );
  }

  if (releases.length === 0) {
    throw new UnsupportedMusicLinkError("Couldn't extract a release from this link");
  }

  // A page naming one release is that release's page — its own URL is the right
  // link. A page naming several is a listing, and links to each of them: give
  // every release the page that is actually about it where the page said so.
  const withLinks =
    releases.length > 1 ? matchReleaseUrls(releases, extractPageLinks(html, url)) : releases;

  const primary = withLinks[0];
  return {
    potentialArtist: primary?.artist,
    potentialTitle: primary?.title,
    itemType: primary?.itemType,
    imageUrl: og.ogImage,
    pageTitle: og.ogTitle || og.title,
    releases: withLinks,
  };
}

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

export function parseSoundcloudOg(og: OgData): ScrapedMetadata {
  const title = og.ogTitle || og.title || "";
  // SoundCloud format: "Track by Artist" or "Stream Track by Artist"
  const byMatch = title.match(/^(?:Stream\s+)?(.+?)\s+by\s+(.+?)(?:\s+on\s+SoundCloud)?$/i);
  if (byMatch) {
    return {
      potentialTitle: byMatch[1].trim(),
      potentialArtist: byMatch[2].trim(),
      imageUrl: og.ogImage,
    };
  }
  return { potentialTitle: title || undefined, imageUrl: og.ogImage };
}

async function scrapeYouTubeOEmbed(
  url: string,
  timeoutMs: number,
): Promise<ScrapedMetadata | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const oembedUrl = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;

    const response = await fetch(oembedUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = (await response.json()) as unknown;
    if (!isRecord(data)) return null;

    const potentialTitle = getString(data.title);
    const potentialArtist = getString(data.author_name);
    const imageUrl = getString(data.thumbnail_url);

    if (!potentialTitle && !potentialArtist && !imageUrl) return null;

    return { potentialTitle, potentialArtist, imageUrl };
  } catch {
    return null;
  }
}

export function parseDefaultOg(og: OgData): ScrapedMetadata {
  return {
    potentialTitle: og.ogTitle || og.title || undefined,
    imageUrl: og.ogImage,
  };
}

export function parseCanonicalUrl(html: string): string | undefined {
  const match =
    html.match(/<link\s[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ??
    html.match(/<link\s[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  return match?.[1]?.trim() || undefined;
}

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

export const SOURCE_PARSERS: Partial<Record<SourceName, OgParser>> = {
  bandcamp: parseBandcampOg,
  soundcloud: parseSoundcloudOg,
  apple_music: parseAppleMusicOg,
  mixcloud: parseMixcloudOg,
  nts: parseNtsOg,
  pitchfork: parsePitchforkOg,
};

export async function scrapeUrl(
  url: string,
  source: SourceName,
  timeoutMs = 5000,
): Promise<ScrapedMetadata | null> {
  let mixcloudOEmbed: ScrapedMetadata | null = null;
  let appleMusic: AppleMusicApiMetadata = NO_APPLE_MUSIC_API_METADATA;

  if (source === "mixcloud") {
    mixcloudOEmbed = await fetchMixcloudOEmbed(url, timeoutMs);
  }

  if (source === "apple_music") {
    appleMusic = await fetchAppleMusicApiMetadata(url, timeoutMs);
    // Complete from Apple's own APIs — no need to fetch the page at all.
    if (isCompleteAppleMusicMetadata(appleMusic.merged)) {
      return appleMusic.merged;
    }
  }

  try {
    if (source === "discogs") {
      return await fetchDiscogsRelease(url, timeoutMs);
    }

    if (source === "youtube") {
      return await scrapeYouTubeOEmbed(url, timeoutMs);
    }

    if (source === "mixcloud" && isCompleteMixcloudMetadata(mixcloudOEmbed)) {
      return mixcloudOEmbed;
    }

    if (source === "apple_music" && hasScrapedMetadata(appleMusic.merged)) {
      return appleMusic.merged;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MusicBot/1.0)",
        Accept: "text/html",
      },
    });

    clearTimeout(timer);

    const contentType = response.headers.get("content-type") || "";
    const fallback =
      source === "mixcloud" ? mixcloudOEmbed : source === "apple_music" ? appleMusic.merged : null;

    if (!contentType.includes("text/html")) {
      return hasScrapedMetadata(fallback) ? fallback : null;
    }

    // Read only the head for known sources, but include part of the body for unknown pages.
    const reader = response.body?.getReader();
    if (!reader) {
      return hasScrapedMetadata(fallback) ? fallback : null;
    }

    let html = "";
    const decoder = new TextDecoder();
    // Bandcamp needs body content too (TralbumData JS is in the body)
    const maxBytes =
      source === "unknown" || source === "bandcamp" ? MAX_UNKNOWN_HTML_BYTES : MAX_HEAD_BYTES;

    while (html.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (source === "unknown" || source === "bandcamp") {
        if (html.includes("</body>")) break;
      } else if (html.includes("</head>")) {
        break;
      }
    }

    reader.cancel();

    const og = parseOgTags(html);
    if (source === "unknown") {
      const mixcloudUrl = extractMixcloudEmbedUrl(html);
      try {
        const result = await scrapeUnknownUrl(url, html, og);
        if (result && mixcloudUrl) {
          result.embedMetadata = { mixcloud_url: mixcloudUrl };
        }
        return result;
      } catch (err) {
        if (err instanceof UnsupportedMusicLinkError && mixcloudUrl) {
          return {
            potentialTitle: og.ogTitle || og.title || undefined,
            imageUrl: og.ogImage,
            embedMetadata: { mixcloud_url: mixcloudUrl },
          };
        }
        throw err;
      }
    }

    if (source === "mixcloud") {
      return mergeMixcloudPageMetadata(html, og, mixcloudOEmbed);
    }

    if (source === "apple_music") {
      return mergeAppleMusicPageMetadata(og, appleMusic);
    }

    if (source === "nts") {
      const result = parseNtsOg(og);
      const canonicalUrl =
        firstDefined(og.metaTags?.["og:url"], parseCanonicalUrl(html)) || undefined;
      if (canonicalUrl) result.canonicalUrl = canonicalUrl;
      return result;
    }

    if (source === "pitchfork") {
      const ogResult = parsePitchforkOg(og);
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

    const parser = SOURCE_PARSERS[source] || parseDefaultOg;
    const result = parser(og);
    if (source === "bandcamp" && result) {
      result.embedMetadata = extractBandcampEmbedMetadata(html) ?? undefined;
    }
    return result;
  } catch (err) {
    if (err instanceof UnsupportedMusicLinkError) {
      throw err;
    }

    const fallback =
      source === "mixcloud" ? mixcloudOEmbed : source === "apple_music" ? appleMusic.merged : null;
    return hasScrapedMetadata(fallback) ? fallback : null;
  }
}

/**
 * Read just the `og:image` off a page, without asking what release the page is
 * about.
 *
 * The full scrape of an unsupported link runs an LLM extraction to work that
 * out, and throws when the page isn't recognisably about music — far more than
 * is needed when the release already exists and all that's wanted is the
 * picture the page advertises. Returns null on anything that isn't reachable
 * HTML carrying an image.
 */
export async function scrapeOgImage(url: string, timeoutMs = 5000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MusicBot/1.0)",
        Accept: "text/html",
      },
    });

    clearTimeout(timer);

    if (!response.headers.get("content-type")?.includes("text/html")) return null;

    const reader = response.body?.getReader();
    if (!reader) return null;

    let html = "";
    const decoder = new TextDecoder();
    while (html.length < MAX_HEAD_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes("</head>")) break;
    }

    reader.cancel();

    return parseOgTags(html).ogImage ?? null;
  } catch {
    return null;
  }
}

/**
 * Search Spotify for a release by title and artist, returning the best-matching
 * Spotify URL, or null if not found.
 *
 * STUB: Spotify's Web API (unlike the open iTunes Search API) requires OAuth app
 * credentials via the Client Credentials flow. This is intentionally left as a
 * no-op until SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are configured and the
 * token + /v1/search implementation lands. Returning null means the active
 * service can be switched to Spotify in the UI without breaking lookups — they
 * simply find nothing for now.
 */
export async function searchSpotify(
  _title: string,
  _artist: string | null,
  _timeoutMs = 8000,
): Promise<ServiceSearchResult | null> {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return null;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    // Not configured — Spotify lookups cleanly no-op until credentials exist.
    return null;
  }

  // TODO: obtain a Client Credentials token from accounts.spotify.com and query
  // https://api.spotify.com/v1/search?type=album,track — then match like
  // searchAppleMusic above and return the result's external Spotify URL.
  return null;
}

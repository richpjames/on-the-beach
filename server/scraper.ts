import type { ItemType, SourceName } from "../src/types";
import {
  extractReleaseCandidatesFromWebText,
  type ExtractedReleaseCandidate,
} from "./link-extractor";
import { fetchDiscogsRelease } from "./discogs";

export interface OgData {
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogSiteName?: string;
  title?: string;
  metaTags?: Record<string, string>;
}

export interface ScrapedMetadata {
  potentialArtist?: string;
  potentialTitle?: string;
  itemType?: ItemType;
  imageUrl?: string;
  releases?: ExtractedReleaseCandidate[];
  embedMetadata?: Record<string, string>;
  year?: number;
  genre?: string;
}

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

export function parseOgTags(html: string): OgData {
  const data: OgData = {};

  // Match <meta> tags with property/name and content in either order
  const metaRegex =
    /<meta\s+(?:[^>]*?)(?:property|name)\s*=\s*(["'])([^"']+)\1[^>]*?content\s*=\s*(["'])([\s\S]*?)\3[^>]*?\/?>/gi;
  const metaRegexReversed =
    /<meta\s+(?:[^>]*?)content\s*=\s*(["'])([\s\S]*?)\1[^>]*?(?:property|name)\s*=\s*(["'])([^"']+)\3[^>]*?\/?>/gi;

  const tags = new Map<string, string>();

  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(html)) !== null) {
    tags.set(match[2].toLowerCase(), decodeHtmlEntities(match[4]));
  }
  while ((match = metaRegexReversed.exec(html)) !== null) {
    tags.set(match[4].toLowerCase(), decodeHtmlEntities(match[2]));
  }

  data.ogTitle = tags.get("og:title");
  data.ogDescription = tags.get("og:description");
  data.ogImage = tags.get("og:image");
  data.ogSiteName = tags.get("og:site_name");
  data.metaTags = Object.fromEntries(tags);

  // Fallback to <title> tag
  if (!data.ogTitle) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      data.title = decodeHtmlEntities(titleMatch[1].trim());
    }
  }

  return data;
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (raw, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : raw;
    })
    .replace(/&#(\d+);/g, (raw, num) => {
      const codePoint = Number.parseInt(num, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : raw;
    });
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

export function detectMusicRelatedHtml(html: string): MusicSignalResult {
  const text = stripHtmlForAnalysis(html).toLowerCase();
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
  const signal = detectMusicRelatedHtml(html);
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

  const primary = releases[0];
  return {
    potentialArtist: primary?.artist,
    potentialTitle: primary?.title,
    itemType: primary?.itemType,
    imageUrl: og.ogImage,
    releases,
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

function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function hasScrapedMetadata(
  metadata: ScrapedMetadata | null | undefined,
): metadata is ScrapedMetadata {
  return Boolean(metadata?.potentialArtist || metadata?.potentialTitle || metadata?.imageUrl);
}

function hasCompleteAppleMusicMetadata(
  metadata: ScrapedMetadata | null | undefined,
): metadata is ScrapedMetadata {
  return Boolean(metadata?.potentialArtist && metadata?.potentialTitle && metadata?.imageUrl);
}

function mergeScrapedMetadata(
  ...entries: Array<ScrapedMetadata | null | undefined>
): ScrapedMetadata | null {
  const merged: ScrapedMetadata = {
    potentialArtist: firstDefined(...entries.map((entry) => entry?.potentialArtist)),
    potentialTitle: firstDefined(...entries.map((entry) => entry?.potentialTitle)),
    imageUrl: firstDefined(...entries.map((entry) => entry?.imageUrl)),
  };

  return hasScrapedMetadata(merged) ? merged : null;
}

function normalizeMixcloudImageUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;

  const unsafeSizeMatch = trimmed.match(/\/unsafe\/(\d+)x(\d+)\//i);
  if (unsafeSizeMatch) {
    const width = Number(unsafeSizeMatch[1]);
    const height = Number(unsafeSizeMatch[2]);
    if (
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0 &&
      width !== height
    ) {
      const size = Math.max(width, height);
      return trimmed.replace(/\/unsafe\/\d+x\d+\//i, `/unsafe/${size}x${size}/`);
    }
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname.toLowerCase().endsWith("mixcloud.com")) return trimmed;

    const widthParam = parsed.searchParams.get("w") ?? parsed.searchParams.get("width");
    const heightParam = parsed.searchParams.get("h") ?? parsed.searchParams.get("height");
    const width = Number(widthParam);
    const height = Number(heightParam);

    if (
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0 &&
      width !== height
    ) {
      const size = Math.max(width, height);
      if (parsed.searchParams.has("w")) parsed.searchParams.set("w", String(size));
      if (parsed.searchParams.has("width")) parsed.searchParams.set("width", String(size));
      if (parsed.searchParams.has("h")) parsed.searchParams.set("h", String(size));
      if (parsed.searchParams.has("height")) parsed.searchParams.set("height", String(size));
      return parsed.toString();
    }
  } catch {
    // Ignore URL parse errors and keep original value.
  }

  return trimmed;
}

function normalizeMixcloudTitle(rawTitle: string): string {
  return rawTitle
    .replace(/\s+(?:on|at)\s+mixcloud(?:\s*\|.*)?$/i, "")
    .replace(/\s+[|-]\s*mixcloud.*$/i, "")
    .trim();
}

export function parseMixcloudOg(og: OgData): ScrapedMetadata {
  const meta = og.metaTags ?? {};
  const artistFromMeta = firstDefined(
    meta["twitter:audio:artist_name"],
    meta["music:musician_name"],
    meta.author,
    meta["twitter:creator"],
  );
  const rawTitle = firstDefined(meta["twitter:title"], og.ogTitle, og.title) ?? "";
  const imageUrl = normalizeMixcloudImageUrl(
    firstDefined(
      og.ogImage,
      meta["og:image:secure_url"],
      meta["twitter:image"],
      meta["twitter:image:src"],
      meta["thumbnail"],
    ),
  );
  const byMatch = rawTitle.match(
    /^(?:stream\s+)?(.+?)\s+by\s+(.+?)(?:\s+(?:on|at)\s+mixcloud)?(?:\s*[|-].*)?$/i,
  );

  if (byMatch) {
    const potentialTitle = normalizeMixcloudTitle(byMatch[1].trim());
    const potentialArtist = firstDefined(artistFromMeta, byMatch[2].trim());
    return {
      potentialTitle: potentialTitle || undefined,
      potentialArtist,
      imageUrl,
    };
  }

  const potentialTitle = rawTitle ? normalizeMixcloudTitle(rawTitle) : undefined;
  return {
    potentialTitle,
    potentialArtist: artistFromMeta,
    imageUrl,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getTypeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join(" ");
  }
  return "";
}

function collectJsonLdObjects(value: unknown, out: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLdObjects(item, out);
    }
    return;
  }

  if (!isRecord(value)) return;
  out.push(value);
  if ("@graph" in value) {
    collectJsonLdObjects(value["@graph"], out);
  }
}

function parseJsonLdScripts(html: string): Array<Record<string, unknown>> {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const parsed: Array<Record<string, unknown>> = [];

  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;

    try {
      const decoded = decodeHtmlEntities(raw);
      const json = JSON.parse(decoded) as unknown;
      collectJsonLdObjects(json, parsed);
    } catch {
      // Ignore invalid JSON-LD blobs.
    }
  }

  return parsed;
}

function extractName(value: unknown): string | undefined {
  const direct = getString(value);
  if (direct) return direct;

  if (!isRecord(value)) return undefined;
  return getString(value.name) ?? getString(value.title);
}

function extractArtistFromJsonLd(item: Record<string, unknown>): string | undefined {
  return firstDefined(
    extractName(item.uploader),
    extractName(item.author),
    extractName(item.byArtist),
    extractName(item.creator),
    extractName(item.user),
    extractName(item.owner),
  );
}

function extractTitleFromJsonLd(item: Record<string, unknown>): string | undefined {
  const title = getString(item.title);
  if (title) return title;

  const typeText = getTypeText(item["@type"]);
  if (/(person|organization)$/i.test(typeText)) {
    return undefined;
  }

  const name = getString(item.name);
  if (!name || /^mixcloud$/i.test(name)) return undefined;
  return name;
}

function extractImageFromJsonLdValue(value: unknown): string | undefined {
  const direct = getString(value);
  if (direct) return direct;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractImageFromJsonLdValue(item);
      if (nested) return nested;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  return firstDefined(
    getString(value.url),
    getString(value.contentUrl),
    getString(value.thumbnailUrl),
    getString(value["@id"]),
  );
}

function extractImageFromJsonLd(item: Record<string, unknown>): string | undefined {
  return normalizeMixcloudImageUrl(
    firstDefined(
      extractImageFromJsonLdValue(item.image),
      extractImageFromJsonLdValue(item.thumbnailUrl),
      extractImageFromJsonLdValue(item.thumbnail),
      extractImageFromJsonLdValue(item.contentUrl),
    ),
  );
}

export function parseMixcloudJsonLd(html: string): ScrapedMetadata {
  const entries = parseJsonLdScripts(html);

  for (const entry of entries) {
    const potentialArtist = extractArtistFromJsonLd(entry);
    const potentialTitle = extractTitleFromJsonLd(entry);
    const imageUrl = extractImageFromJsonLd(entry);
    if (potentialArtist || potentialTitle || imageUrl) {
      return { potentialArtist, potentialTitle, imageUrl };
    }
  }

  return {};
}

async function scrapeMixcloudOEmbed(
  url: string,
  timeoutMs: number,
): Promise<ScrapedMetadata | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const oembedUrl = `https://www.mixcloud.com/oembed/?format=json&url=${encodeURIComponent(url)}`;

    const response = await fetch(oembedUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = (await response.json()) as unknown;
    if (!isRecord(data)) return null;

    const potentialTitle = getString(data.title) ?? getString(data.name);
    const potentialArtist =
      getString(data.author_name) ?? getString(data.author) ?? getString(data.uploader);
    const imageUrl = normalizeMixcloudImageUrl(
      firstDefined(getString(data.thumbnail_url), getString(data.thumbnail), getString(data.image)),
    );

    if (!potentialTitle && !potentialArtist && !imageUrl) return null;

    return {
      potentialTitle,
      potentialArtist,
      imageUrl,
    };
  } catch {
    return null;
  }
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

export function parseDefaultOg(og: OgData): ScrapedMetadata {
  return {
    potentialTitle: og.ogTitle || og.title || undefined,
    imageUrl: og.ogImage,
  };
}

export const SOURCE_PARSERS: Partial<Record<SourceName, OgParser>> = {
  bandcamp: parseBandcampOg,
  soundcloud: parseSoundcloudOg,
  apple_music: parseAppleMusicOg,
  mixcloud: parseMixcloudOg,
};

export async function scrapeUrl(
  url: string,
  source: SourceName,
  timeoutMs = 5000,
): Promise<ScrapedMetadata | null> {
  let mixcloudOEmbed: ScrapedMetadata | null = null;
  let appleMusicOEmbed: ScrapedMetadata | null = null;
  let appleMusicLookup: ScrapedMetadata | null = null;
  let appleMusicMetadata: ScrapedMetadata | null = null;

  if (source === "mixcloud") {
    mixcloudOEmbed = await scrapeMixcloudOEmbed(url, timeoutMs);
  }

  if (source === "apple_music") {
    appleMusicOEmbed = await scrapeAppleMusicOEmbed(url, timeoutMs);
    appleMusicMetadata = mergeScrapedMetadata(appleMusicOEmbed);
    if (hasCompleteAppleMusicMetadata(appleMusicMetadata)) {
      return appleMusicMetadata;
    }

    appleMusicLookup = await scrapeAppleMusicLookup(url, timeoutMs);
    appleMusicMetadata = mergeScrapedMetadata(appleMusicOEmbed, appleMusicLookup);
    if (hasCompleteAppleMusicMetadata(appleMusicMetadata)) {
      return appleMusicMetadata;
    }
  }

  try {
    if (source === "discogs") {
      return await fetchDiscogsRelease(url, timeoutMs);
    }

    if (source === "youtube") {
      return await scrapeYouTubeOEmbed(url, timeoutMs);
    }

    if (
      source === "mixcloud" &&
      mixcloudOEmbed?.potentialArtist &&
      mixcloudOEmbed?.potentialTitle
    ) {
      return mixcloudOEmbed;
    }

    if (source === "apple_music" && hasScrapedMetadata(appleMusicMetadata)) {
      return appleMusicMetadata;
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
      source === "mixcloud" ? mixcloudOEmbed : source === "apple_music" ? appleMusicMetadata : null;

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
      return await scrapeUnknownUrl(url, html, og);
    }

    if (source === "mixcloud") {
      const mixcloudOg = parseMixcloudOg(og);
      const jsonLd = parseMixcloudJsonLd(html);

      const merged: ScrapedMetadata = {
        potentialArtist: firstDefined(
          jsonLd.potentialArtist,
          mixcloudOEmbed?.potentialArtist,
          mixcloudOg.potentialArtist,
        ),
        potentialTitle: firstDefined(
          jsonLd.potentialTitle,
          mixcloudOEmbed?.potentialTitle,
          mixcloudOg.potentialTitle,
        ),
        imageUrl: firstDefined(jsonLd.imageUrl, mixcloudOEmbed?.imageUrl, mixcloudOg.imageUrl),
      };

      return hasScrapedMetadata(merged) ? merged : null;
    }

    if (source === "apple_music") {
      const appleMusicOg = parseAppleMusicOg(og);
      return mergeScrapedMetadata(appleMusicOEmbed, appleMusicLookup, appleMusicOg);
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
      source === "mixcloud" ? mixcloudOEmbed : source === "apple_music" ? appleMusicMetadata : null;
    return hasScrapedMetadata(fallback) ? fallback : null;
  }
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Search Apple Music (iTunes Search API) for a release by title and artist.
 * Returns the Apple Music URL for the best matching result, or null if not found.
 *
 * Matching strategy (in order):
 *  1. Exact title + artist match
 *  2. Partial match — one title is a prefix/substring of the other (handles
 *     Wikipedia-style disambiguators like "Foo (1981 album)" vs "Foo")
 *  3. First result whose artist matches (search query is already specific)
 */
export async function searchAppleMusic(
  title: string,
  artist: string | null,
  timeoutMs = 8000,
): Promise<string | null> {
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
      return firstDefined(getString(result.collectionViewUrl), getString(result.trackViewUrl));
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
      const url = resultUrl(result);
      if (url) return url;
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
      const url = resultUrl(result);
      if (url) return url;
    }

    // Pass 3: first result whose artist matches (search query is already scoped)
    for (const result of data.results) {
      if (!isRecord(result)) continue;
      if (!artistMatches(getString(result.artistName))) continue;
      const url = resultUrl(result);
      if (url) return url;
    }

    return null;
  } catch {
    return null;
  }
}

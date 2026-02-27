import type { SourceName } from "../src/types";

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
  imageUrl?: string;
}

type OgParser = (og: OgData) => ScrapedMetadata;

const MAX_HEAD_BYTES = 100_000;

export function parseOgTags(html: string): OgData {
  const data: OgData = {};

  // Match <meta> tags with property/name and content in either order
  const metaRegex =
    /<meta\s+(?:[^>]*?)(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*?)["'][^>]*?\/?>/gi;
  const metaRegexReversed =
    /<meta\s+(?:[^>]*?)content\s*=\s*["']([^"']*?)["'][^>]*?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?\/?>/gi;

  const tags = new Map<string, string>();

  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(html)) !== null) {
    tags.set(match[1].toLowerCase(), decodeHtmlEntities(match[2]));
  }
  while ((match = metaRegexReversed.exec(html)) !== null) {
    tags.set(match[2].toLowerCase(), decodeHtmlEntities(match[1]));
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
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)));
}

export function parseBandcampOg(og: OgData): ScrapedMetadata {
  const title = og.ogTitle || og.title || "";
  // Bandcamp format: "Album Title, by Artist Name"
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
  if (og.ogTitle) {
    result.potentialTitle = og.ogTitle;
  }
  // og:description on Apple Music often contains "Album · YEAR · N Songs" or artist info
  if (og.ogDescription) {
    const artistMatch = og.ogDescription.match(/^(.+?)\s+[·-]\s+/i);
    if (artistMatch) {
      result.potentialArtist = artistMatch[1].trim();
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

  if (source === "mixcloud") {
    mixcloudOEmbed = await scrapeMixcloudOEmbed(url, timeoutMs);
  }

  try {
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
    if (!contentType.includes("text/html")) {
      return hasScrapedMetadata(mixcloudOEmbed) ? mixcloudOEmbed : null;
    }

    // Read only up to the </head> or MAX_HEAD_BYTES
    const reader = response.body?.getReader();
    if (!reader) {
      return hasScrapedMetadata(mixcloudOEmbed) ? mixcloudOEmbed : null;
    }

    let html = "";
    const decoder = new TextDecoder();

    while (html.length < MAX_HEAD_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes("</head>")) break;
    }

    reader.cancel();

    const og = parseOgTags(html);
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

    const parser = SOURCE_PARSERS[source] || parseDefaultOg;
    return parser(og);
  } catch {
    return hasScrapedMetadata(mixcloudOEmbed) ? mixcloudOEmbed : null;
  }
}

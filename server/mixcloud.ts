/**
 * Everything the app knows about Mixcloud.
 *
 * Mixcloud needs more coaxing than most sources: its show pages are a SPA, so
 * the metadata worth having is spread across oEmbed, JSON-LD and OG tags, and
 * its thumbnails come back at whatever aspect ratio the uploader used. Keeping
 * that in one place leaves `scraper.ts` holding only the dispatch.
 */
import {
  extractImageFromJsonLdValue,
  extractName,
  firstDefined,
  getString,
  getTypeText,
  hasScrapedMetadata,
  isRecord,
  parseJsonLdScripts,
  type OgData,
  type ScrapedMetadata,
} from "./html-metadata";

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

export async function fetchMixcloudOEmbed(
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

export function extractMixcloudEmbedUrl(html: string): string | null {
  const iframeRegex =
    /<iframe[^>]+src=["'](https?:\/\/(?:www\.)?mixcloud\.com\/widget\/iframe\/\?[^"']*)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = iframeRegex.exec(html)) !== null) {
    try {
      const srcUrl = new URL(match[1]);
      const feed = srcUrl.searchParams.get("feed");
      if (feed && /^\/[^/]+\/[^/]+/.test(feed)) {
        const normalized = feed.endsWith("/") ? feed : `${feed}/`;
        return `https://www.mixcloud.com${normalized}`;
      }
    } catch {
      // ignore invalid URLs
    }
  }
  return null;
}

/**
 * The player for a Mixcloud show, as the release page embeds it.
 *
 * The widget takes the show's path — not its full URL — in a `feed` parameter,
 * and `hide_cover` drops the artwork the page is already showing above it.
 * Returns null for anything that isn't a Mixcloud URL.
 */
export function mixcloudWidgetSrc(mixcloudUrl: string | null | undefined): string | null {
  if (!mixcloudUrl) return null;

  let pathname: string;
  try {
    const parsed = new URL(mixcloudUrl);
    if (!parsed.hostname.toLowerCase().endsWith("mixcloud.com")) return null;
    pathname = parsed.pathname;
  } catch {
    return null;
  }

  return `https://www.mixcloud.com/widget/iframe/?hide_cover=1&feed=${encodeURIComponent(pathname)}`;
}

/**
 * Whether the oEmbed answer alone is enough to skip fetching the page.
 *
 * oEmbed names the uploader and the show, which is everything a release needs;
 * the artwork it returns is optional and not worth a page fetch on its own.
 */
export function isCompleteMixcloudMetadata(
  metadata: ScrapedMetadata | null | undefined,
): metadata is ScrapedMetadata {
  return Boolean(metadata?.potentialArtist && metadata?.potentialTitle);
}

/**
 * The show's metadata, read off the page and merged with whatever oEmbed
 * already gave us. JSON-LD wins where it has an answer — it names the uploader
 * and the show directly, where the OG title has to be split apart.
 */
export function mergeMixcloudPageMetadata(
  html: string,
  og: OgData,
  oEmbed: ScrapedMetadata | null,
): ScrapedMetadata | null {
  const fromOg = parseMixcloudOg(og);
  const fromJsonLd = parseMixcloudJsonLd(html);

  const merged: ScrapedMetadata = {
    potentialArtist: firstDefined(
      fromJsonLd.potentialArtist,
      oEmbed?.potentialArtist,
      fromOg.potentialArtist,
    ),
    potentialTitle: firstDefined(
      fromJsonLd.potentialTitle,
      oEmbed?.potentialTitle,
      fromOg.potentialTitle,
    ),
    imageUrl: firstDefined(fromJsonLd.imageUrl, oEmbed?.imageUrl, fromOg.imageUrl),
  };

  return hasScrapedMetadata(merged) ? merged : null;
}

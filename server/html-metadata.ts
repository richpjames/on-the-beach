/**
 * Reading metadata out of a web page, without caring whose page it is.
 *
 * OG tags, JSON-LD and the small helpers over them are the same work whether
 * the page is a Mixcloud show, a Bandcamp album or a label's own site, so they
 * live here rather than in `scraper.ts` — that keeps a per-source module (see
 * `mixcloud.ts`) from having to import the scraper it is called by.
 */
import type { ItemType } from "../src/types";
import type { ExtractedReleaseCandidate } from "./link-extractor";

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
  /** The page's own title (og:title, else <title>) — names the page a release was lifted from. */
  pageTitle?: string;
  embedMetadata?: Record<string, string>;
  year?: number;
  genre?: string;
  /** The releasing label, where the source names one (Discogs does). */
  label?: string;
  canonicalUrl?: string;
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

export function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function hasScrapedMetadata(
  metadata: ScrapedMetadata | null | undefined,
): metadata is ScrapedMetadata {
  return Boolean(metadata?.potentialArtist || metadata?.potentialTitle || metadata?.imageUrl);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function getTypeText(value: unknown): string {
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

export function parseJsonLdScripts(html: string): Array<Record<string, unknown>> {
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

export function extractName(value: unknown): string | undefined {
  const direct = getString(value);
  if (direct) return direct;

  if (!isRecord(value)) return undefined;
  return getString(value.name) ?? getString(value.title);
}

export function extractImageFromJsonLdValue(value: unknown): string | undefined {
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

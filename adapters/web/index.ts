/**
 * The web adapter: pages we don't have a source for.
 *
 * A link from a modelled source (Bandcamp, Discogs, …) is scraped by that
 * source's adapter. Everything else is *the web at large*, and this is its
 * adapter: a page is fetched, asked whether it is about music at all, and —
 * when it is — handed to the LLM extraction in `link-extractor.ts` to work out
 * which release(s) it names. This is also where the generic OG-tag parsing
 * lives, for sources whose story is entirely in their head.
 */
import {
  decodeHtmlEntities,
  parseOgTags,
  type OgData,
  type ScrapedMetadata,
} from "./html-metadata";
import { fetchPageHtml, MAX_HEAD_BYTES, MAX_BODY_BYTES } from "./fetch-page";
import {
  extractPageLinks,
  extractReleaseCandidatesFromWebText,
  matchReleaseUrls,
} from "./link-extractor";
import { extractMixcloudEmbedUrl } from "../mixcloud";

export class UnsupportedMusicLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMusicLinkError";
  }
}

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

export interface MusicSignalResult {
  isMusicRelated: boolean;
  matchedTerms: string[];
}

export interface MusicSignalContext {
  url?: string;
  og?: OgData;
}

export function stripHtmlForAnalysis(html: string): string {
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

/** The OG tags read as generic metadata: a title, maybe a picture, nothing more. */
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

/**
 * Scrape a page we don't have a source for: establish it is music-related,
 * then let the LLM extraction name the release(s) it carries.
 *
 * A page with nothing but a Mixcloud embed in it is still worth keeping — the
 * embed is a playable link even when the surrounding text says nothing the
 * extraction can use.
 */
export async function scrapeUnknownWebPage(
  url: string,
  timeoutMs: number,
): Promise<ScrapedMetadata | null> {
  const html = await fetchPageHtml(url, timeoutMs, {
    maxBytes: MAX_BODY_BYTES,
    stopAt: "</body>",
  });
  if (html === null) return null;

  const og = parseOgTags(html);
  const mixcloudUrl = extractMixcloudEmbedUrl(html);
  try {
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
    const result: ScrapedMetadata = {
      potentialArtist: primary?.artist,
      potentialTitle: primary?.title,
      itemType: primary?.itemType,
      imageUrl: og.ogImage,
      pageTitle: og.ogTitle || og.title,
      releases: withLinks,
    };
    if (mixcloudUrl) {
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
    if (err instanceof UnsupportedMusicLinkError) {
      throw err;
    }
    // Anything unexpected (a failed fetch mid-parse, an extraction hiccup)
    // reads as "no metadata" rather than an error — same as a source whose
    // page simply didn't answer.
    return null;
  }
}

/**
 * Scrape a page from a source we model only by its OG tags: read the head,
 * take the title and the picture. Sources without a bespoke adapter in the
 * registry (Tidal, Deezer, …) land here.
 */
export async function scrapeOgPage(
  url: string,
  timeoutMs: number,
): Promise<ScrapedMetadata | null> {
  const html = await fetchPageHtml(url, timeoutMs, { maxBytes: MAX_HEAD_BYTES, stopAt: "</head>" });
  if (html === null) return null;
  return parseDefaultOg(parseOgTags(html));
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
  const html = await fetchPageHtml(url, timeoutMs, { maxBytes: MAX_HEAD_BYTES, stopAt: "</head>" });
  if (html === null) return null;
  return parseOgTags(html).ogImage ?? null;
}

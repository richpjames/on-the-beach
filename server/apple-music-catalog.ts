import { getDeveloperToken, getStorefront, isAppleMusicConfigured } from "./apple-music-token";

// ---------------------------------------------------------------------------
// Apple Music Catalog API search
//
// When MusicKit is configured we resolve secondary Apple Music links through
// the official catalogue search (api.music.apple.com) rather than the legacy
// iTunes Search API. It returns first-class catalogue URLs (and, crucially, the
// catalogue ids the browser MusicKit SDK needs to stream full tracks). Callers
// fall back to the iTunes search when this returns null / when unconfigured.
// ---------------------------------------------------------------------------

const API_BASE = "https://api.music.apple.com/v1/catalog";

/** The square pixel size we bake into Apple Music artwork template URLs. */
const ARTWORK_SIZE = 1200;

/**
 * The result of resolving a release on a streaming service: its catalogue URL
 * plus, when the service exposes one, a ready-to-use cover artwork URL.
 */
export interface ServiceSearchResult {
  url: string;
  artworkUrl: string | null;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface CatalogResource {
  attributes?: {
    name?: unknown;
    artistName?: unknown;
    url?: unknown;
    artwork?: unknown;
  };
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve an Apple Music artwork template into a concrete image URL.
 *
 * Catalogue resources carry artwork as a templated URL with `{w}`/`{h}` (and
 * sometimes `{c}`/`{f}`) placeholders, e.g.
 * `https://…/{w}x{h}bb.{f}`. We bake in a fixed square size so the stored URL
 * points straight at a usable cover image.
 */
function resolveCatalogArtworkUrl(artwork: unknown): string | null {
  if (!artwork || typeof artwork !== "object") return null;
  const template = getString((artwork as { url?: unknown }).url);
  if (!template) return null;
  return template
    .replace(/\{w\}/g, String(ARTWORK_SIZE))
    .replace(/\{h\}/g, String(ARTWORK_SIZE))
    .replace(/\{c\}/g, "bb")
    .replace(/\{f\}/g, "jpg");
}

/** Build a search result from a matched catalogue resource, or null if it has no URL. */
function toResult(resource: CatalogResource): ServiceSearchResult | null {
  const url = getString(resource.attributes?.url);
  if (!url) return null;
  return { url, artworkUrl: resolveCatalogArtworkUrl(resource.attributes?.artwork) };
}

/**
 * Search the Apple Music catalogue for a release by title and artist, returning
 * the best-matching catalogue URL together with its cover artwork, or null when
 * unconfigured, on error, or when nothing matches confidently. Mirrors the
 * three-pass matching used for the iTunes search (exact title+artist, compatible
 * title+artist, artist-only).
 */
export async function searchAppleMusicCatalog(
  title: string,
  artist: string | null,
  timeoutMs = 8000,
): Promise<ServiceSearchResult | null> {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return null;
  if (!isAppleMusicConfigured()) return null;

  const token = getDeveloperToken();
  if (!token) return null;

  try {
    const term = [artist, title].filter(Boolean).join(" ");
    const params = new URLSearchParams({
      term,
      types: "albums,songs",
      limit: "10",
    });
    const searchUrl = `${API_BASE}/${getStorefront()}/search?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = (await response.json()) as {
      results?: {
        albums?: { data?: CatalogResource[] };
        songs?: { data?: CatalogResource[] };
      };
    };

    // Prefer album matches over individual tracks — a release maps to an album.
    const candidates: CatalogResource[] = [
      ...(data.results?.albums?.data ?? []),
      ...(data.results?.songs?.data ?? []),
    ];
    if (candidates.length === 0) return null;

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

    // Pass 1: exact title + artist.
    for (const c of candidates) {
      const name = getString(c.attributes?.name);
      if (!name || normalizeForMatch(name) !== normalizedTitle) continue;
      if (!artistMatches(getString(c.attributes?.artistName))) continue;
      const result = toResult(c);
      if (result) return result;
    }

    // Pass 2: compatible title (prefix either way) + artist.
    for (const c of candidates) {
      const name = getString(c.attributes?.name);
      if (!name || !titlesCompatible(name)) continue;
      if (!artistMatches(getString(c.attributes?.artistName))) continue;
      const result = toResult(c);
      if (result) return result;
    }

    // Pass 3: first artist-matching result (the query is already specific).
    for (const c of candidates) {
      if (!artistMatches(getString(c.attributes?.artistName))) continue;
      const result = toResult(c);
      if (result) return result;
    }

    return null;
  } catch {
    return null;
  }
}

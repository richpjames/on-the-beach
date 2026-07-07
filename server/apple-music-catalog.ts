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
  };
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Search the Apple Music catalogue for a release by title and artist, returning
 * the best-matching catalogue URL, or null when unconfigured, on error, or when
 * nothing matches confidently. Mirrors the three-pass matching used for the
 * iTunes search (exact title+artist, compatible title+artist, artist-only).
 */
export async function searchAppleMusicCatalog(
  title: string,
  artist: string | null,
  timeoutMs = 8000,
): Promise<string | null> {
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
      const url = getString(c.attributes?.url);
      if (url) return url;
    }

    // Pass 2: compatible title (prefix either way) + artist.
    for (const c of candidates) {
      const name = getString(c.attributes?.name);
      if (!name || !titlesCompatible(name)) continue;
      if (!artistMatches(getString(c.attributes?.artistName))) continue;
      const url = getString(c.attributes?.url);
      if (url) return url;
    }

    // Pass 3: first artist-matching result (the query is already specific).
    for (const c of candidates) {
      if (!artistMatches(getString(c.attributes?.artistName))) continue;
      const url = getString(c.attributes?.url);
      if (url) return url;
    }

    return null;
  } catch {
    return null;
  }
}

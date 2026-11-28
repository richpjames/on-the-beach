/**
 * Searching Qobuz — the `ServiceSearch` port.
 *
 * `catalog/search` answers anonymously (see `./api`), scoped to albums: a
 * release maps to an album, and a track hit is as often the wrong edition.
 * Matching mirrors the Apple Music searches' two passes — exact title and
 * artist, then a title that is a prefix of the other either way — and an
 * artist-only hit deliberately doesn't count, for the reasons spelled out
 * in `apple-music/scrape.ts`: a wrong link is worse than no link.
 */
import type { ServiceSearchResult } from "../../ports/service-search";
import { getString, isRecord } from "../web/html-metadata";
import { normalizeForMatch } from "../apple-music/match";
import { fetchQobuzApi, qobuzStorefrontUrl } from "./api";
import { upgradeQobuzCoverUrl } from "./scrape";

function toResult(item: Record<string, unknown>): ServiceSearchResult | null {
  const url = getString(item.url);
  if (!url) return null;
  return {
    url: qobuzStorefrontUrl(url),
    artworkUrl: isRecord(item.image)
      ? (upgradeQobuzCoverUrl(getString(item.image.large)) ?? null)
      : null,
    label: isRecord(item.label) ? (getString(item.label.name) ?? null) : null,
  };
}

/**
 * Search Qobuz for a release by title and artist, returning the best-matching
 * store URL together with its cover artwork and label, or null when nothing
 * matches confidently.
 */
export async function searchQobuz(
  title: string,
  artist: string | null,
  timeoutMs = 8000,
): Promise<ServiceSearchResult | null> {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return null;

  // `normalizeForMatch` keeps only ASCII word characters, so a punctuation-only
  // or non-Latin title normalizes to nothing — and an empty string is a prefix
  // of every result, which would file an arbitrary album as a confident match.
  // No usable title, no search (and no empty query sent to the API).
  const normalizedTitle = normalizeForMatch(title);
  if (!normalizedTitle) return null;

  // The symmetric artist case: a named artist that normalizes to nothing
  // (non-Latin or punctuation) can't be verified, and treating it as "no
  // artist given" would accept any artist's album with a matching title.
  // No confident match is possible — the Bandcamp/YouTube fallbacks take it.
  const normalizedArtist = artist ? normalizeForMatch(artist) : null;
  if (artist && !normalizedArtist) return null;

  const query = [artist, title].filter(Boolean).join(" ");
  const data = await fetchQobuzApi(
    "catalog/search",
    { query, type: "albums", limit: "10" },
    timeoutMs,
  );
  if (!data) return null;

  const albums = isRecord(data.albums) ? data.albums : null;
  const items = albums && Array.isArray(albums.items) ? albums.items.filter(isRecord) : [];
  if (items.length === 0) return null;

  function artistMatches(item: Record<string, unknown>): boolean {
    if (!normalizedArtist) return true;
    const resultArtist = isRecord(item.artist) ? getString(item.artist.name) : undefined;
    if (!resultArtist) return true;
    return normalizeForMatch(resultArtist) === normalizedArtist;
  }

  function titlesCompatible(resultTitle: string): boolean {
    const rn = normalizeForMatch(resultTitle);
    // An empty result title is a prefix of ours too — same trap, other side.
    if (!rn) return false;
    return (
      rn === normalizedTitle || rn.startsWith(normalizedTitle) || normalizedTitle.startsWith(rn)
    );
  }

  // Pass 1: exact title + artist.
  for (const item of items) {
    const name = getString(item.title);
    if (!name || normalizeForMatch(name) !== normalizedTitle) continue;
    if (!artistMatches(item)) continue;
    const result = toResult(item);
    if (result) return result;
  }

  // Pass 2: compatible title (prefix either way) + artist.
  for (const item of items) {
    const name = getString(item.title);
    if (!name || !titlesCompatible(name)) continue;
    if (!artistMatches(item)) continue;
    const result = toResult(item);
    if (result) return result;
  }

  return null;
}

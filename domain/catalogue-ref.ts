// ---------------------------------------------------------------------------
// Catalogue references, as a human pastes them
//
// The release resolver writes catalogue ids it verified itself; a hand
// correction arrives as whatever the user copied — usually a Discogs or
// MusicBrainz page URL, sometimes just the number. These parsers turn either
// form into the id the `music_items` columns keep, so the edit form can accept
// a pasted link without asking anyone to know what an MBID looks like.
// ---------------------------------------------------------------------------

/**
 * The Discogs ids a pasted reference can carry. A release page pins the
 * pressing; a master page names only the work, and knows nothing about which
 * pressing the user is holding — hence two optional fields, never both.
 */
export interface DiscogsRef {
  releaseId?: number;
  masterId?: number;
}

/**
 * Parse a Discogs reference: a release URL, a master URL, or a bare number
 * (taken as the release id — the pressing is what a shelf holds). Returns
 * null for anything else, including an empty string; the caller decides what
 * an empty field means, not the parser.
 */
export function parseDiscogsRef(value: string): DiscogsRef | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const releaseUrl = trimmed.match(/discogs\.com\/release\/(\d+)/i);
  if (releaseUrl) return { releaseId: Number(releaseUrl[1]) };

  const masterUrl = trimmed.match(/discogs\.com\/master\/(\d+)/i);
  if (masterUrl) return { masterId: Number(masterUrl[1]) };

  if (/^\d+$/.test(trimmed)) return { releaseId: Number(trimmed) };

  return null;
}

const MBID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Parse a MusicBrainz release reference: a release page URL or a bare MBID.
 * A release-group URL is deliberately not accepted — the group names the work,
 * not the pressing, and the id the item stores is the release's.
 */
export function parseMusicBrainzReleaseRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const releaseUrl = trimmed.match(/musicbrainz\.org\/release\/([0-9a-f-]{36})/i);
  if (releaseUrl) return releaseUrl[1]!.toLowerCase();

  if (MBID.test(trimmed) && trimmed.length === 36) return trimmed.toLowerCase();

  return null;
}

// Parsing of Apple Music catalogue URLs into the ids MusicKit needs to build a
// playback queue. Shared by the server (deriving playback descriptors at SSR
// time) and the client (resolving links fetched after load).

/** The `MusicKit.setQueue` option key for a catalogue resource. */
export type AppleMusicKind = "album" | "song" | "playlist" | "musicVideo";

export interface AppleMusicResource {
  kind: AppleMusicKind;
  /** Catalogue id, e.g. "1440846597" for albums/songs or "pl.u-…" for playlists. */
  id: string;
}

/**
 * Parse a `music.apple.com` catalogue URL into the resource MusicKit can play.
 *
 * Handles the common shapes:
 *   /album/{slug}/{id}            → album
 *   /album/{slug}/{id}?i={songId} → song   (track deep-link within an album)
 *   /song/{slug}/{id}             → song
 *   /playlist/{slug}/{pl.id}      → playlist
 *   /music-video/{slug}/{id}      → musicVideo
 *
 * The storefront segment (e.g. `/gb/`) is optional. Returns null for anything
 * that isn't a recognisable, playable catalogue resource.
 */
export function parseAppleMusicCatalogUrl(rawUrl: string): AppleMusicResource | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!url.hostname.toLowerCase().endsWith("music.apple.com")) return null;

  // A `?i=` param always denotes a specific track, whatever the path type.
  const trackParam = url.searchParams.get("i");
  if (trackParam && /^\d+$/.test(trackParam)) {
    return { kind: "song", id: trackParam };
  }

  const segments = url.pathname.split("/").filter(Boolean);
  // Drop a leading two-letter storefront segment when present.
  if (segments[0] && /^[a-z]{2}$/i.test(segments[0])) {
    segments.shift();
  }

  const type = segments[0];
  const id = segments[segments.length - 1];
  if (!type || !id) return null;

  switch (type) {
    case "album":
      return /^\d+$/.test(id) ? { kind: "album", id } : null;
    case "song":
      return /^\d+$/.test(id) ? { kind: "song", id } : null;
    case "music-video":
      return /^\d+$/.test(id) ? { kind: "musicVideo", id } : null;
    case "playlist":
      return id.startsWith("pl.") ? { kind: "playlist", id } : null;
    default:
      return null;
  }
}

/** Whether a URL is a playable Apple Music catalogue resource. */
export function isPlayableAppleMusicUrl(url: string): boolean {
  return parseAppleMusicCatalogUrl(url) !== null;
}

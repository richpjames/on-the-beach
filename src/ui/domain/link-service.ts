import type { SourceName } from "../../types";

/**
 * Which service a link points at, for choosing the mark that stands in for it.
 *
 * The stored `source_name` is authoritative when it says something — it's what
 * the ingest parser or the user picked — but plenty of links carry no source of
 * their own (the streaming-service lookup returns a bare URL, older links were
 * saved as "unknown"), so the hostname is the fallback.
 */
const KNOWN_SOURCES = new Set<string>([
  "bandcamp",
  "spotify",
  "soundcloud",
  "youtube",
  "apple_music",
  "discogs",
  "tidal",
  "deezer",
  "mixcloud",
  "nts",
  "pitchfork",
  "physical",
]);

const HOSTS: ReadonlyArray<readonly [string, SourceName]> = [
  ["bandcamp.com", "bandcamp"],
  ["spotify.com", "spotify"],
  ["soundcloud.com", "soundcloud"],
  ["youtube.com", "youtube"],
  ["youtube-nocookie.com", "youtube"],
  ["youtu.be", "youtube"],
  ["discogs.com", "discogs"],
  ["tidal.com", "tidal"],
  ["deezer.com", "deezer"],
  ["mixcloud.com", "mixcloud"],
  ["nts.live", "nts"],
  ["pitchfork.com", "pitchfork"],
];

/** The service a URL belongs to, or "unknown" for anywhere else on the web. */
export function serviceFromUrl(url: string | null | undefined): SourceName {
  if (!url) return "unknown";
  let hostname: string;
  try {
    // Links are stored with a protocol, but a hand-typed one may not have it.
    hostname = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  // music.apple.com and itunes.apple.com are Apple Music; anything else on
  // apple.com isn't, so the suffix match has to see the whole subdomain.
  if (hostname === "apple.com" || hostname.endsWith(".apple.com")) {
    return /^(music|itunes|beta\.music)\.apple\.com$/.test(hostname) ? "apple_music" : "unknown";
  }
  for (const [host, source] of HOSTS) {
    if (hostname === host || hostname.endsWith(`.${host}`)) return source;
  }
  return "unknown";
}

/** The service to show for a link, preferring its recorded source name. */
export function linkService(
  url: string | null | undefined,
  sourceName?: string | null,
): SourceName {
  if (sourceName && KNOWN_SOURCES.has(sourceName)) return sourceName as SourceName;
  return serviceFromUrl(url);
}

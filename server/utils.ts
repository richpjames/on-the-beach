import type { SourceName } from "../src/types";

interface ParsedUrl {
  source: SourceName;
  normalizedUrl: string;
  potentialArtist?: string;
  potentialTitle?: string;
}

const URL_PATTERNS: Array<{
  source: SourceName;
  pattern: RegExp;
  normalizer?: (match: RegExpMatchArray) => string;
  extractor?: (match: RegExpMatchArray) => { potentialArtist?: string; potentialTitle?: string };
}> = [
  {
    source: "bandcamp",
    pattern: /^https?:\/\/([^.]+)\.bandcamp\.com(?:\/(?:album|track)\/([^/?]+))?/,
    extractor: (match) => ({
      potentialArtist: match[1]?.replace(/-/g, " "),
      potentialTitle: match[2]?.replace(/-/g, " "),
    }),
  },
  {
    source: "spotify",
    pattern: /^https?:\/\/open\.spotify\.com\/(album|track|playlist)\/([a-zA-Z0-9]+)/,
  },
  {
    source: "soundcloud",
    pattern: /^https?:\/\/(?:www\.)?soundcloud\.com\/([^/]+)(?:\/([^/?]+))?/,
    extractor: (match) => ({
      potentialArtist: match[1]?.replace(/-/g, " "),
      potentialTitle: match[2]?.replace(/-/g, " "),
    }),
  },
  {
    source: "youtube",
    pattern: /^https?:\/\/(?:(?:www|m)\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/,
    normalizer: (match) => `https://www.youtube.com/watch?v=${match[2]}`,
  },
  {
    source: "apple_music",
    pattern:
      /^https?:\/\/music\.apple\.com\/[a-z]{2}\/(album|playlist|artist|music-video|station)\/([^/]+)/,
    extractor: (match) => {
      const slug = match[2]?.replace(/-/g, " ");
      if (match[1] === "artist") return { potentialArtist: slug };
      return { potentialTitle: slug };
    },
  },
  {
    source: "discogs",
    pattern: /^https?:\/\/(?:www\.)?discogs\.com\/(release|master)\/(\d+)/,
  },
  {
    source: "tidal",
    pattern:
      /^https?:\/\/(?:www\.|listen\.)?tidal\.com\/(?:browse\/)?(album|track|playlist)\/(\d+)/,
  },
  {
    source: "mixcloud",
    pattern: /^https?:\/\/(?:www\.)?mixcloud\.com\/([^/]+)\/([^/?]+)/,
    extractor: (match) => ({
      potentialArtist: match[1]?.replace(/-/g, " "),
      potentialTitle: match[2]?.replace(/-/g, " "),
    }),
  },
  {
    source: "deezer",
    pattern: /^https?:\/\/(?:www\.)?deezer\.com\/[a-z]{2}\/(album|track|playlist)\/(\d+)/,
  },
];

export function parseUrl(url: string): ParsedUrl {
  const trimmedUrl = url.trim();

  for (const { source, pattern, normalizer, extractor } of URL_PATTERNS) {
    const match = trimmedUrl.match(pattern);
    if (match) {
      return {
        source,
        normalizedUrl: normalizer ? normalizer(match) : trimmedUrl.split("?")[0],
        ...(extractor?.(match) || {}),
      };
    }
  }

  return {
    source: "unknown",
    normalizedUrl: trimmedUrl,
  };
}

export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function normalize(text: string): string {
  return text.toLowerCase().trim();
}

export function capitalize(text: string): string {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

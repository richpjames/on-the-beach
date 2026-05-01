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
    source: "youtube",
    pattern: /^https?:\/\/(?:(?:www|m)\.)?youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/,
    normalizer: (match) => `https://www.youtube.com/playlist?list=${match[1]}`,
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
    pattern: /^https?:\/\/(?:www\.)?discogs\.com\/(?:(?:release|master)\/\d+|sell\/item\/\d+)/,
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
  {
    source: "nts",
    pattern: /^https?:\/\/(?:www\.)?nts\.live\/shows\/([^/]+)(?:\/episodes\/([^/?]+))?/,
    extractor: (match) => ({
      potentialArtist: match[1]?.replace(/-/g, " "),
      potentialTitle: match[2]?.replace(/-/g, " "),
    }),
  },
];

function stripMobileSubdomain(url: string): string {
  return url.replace(/^(https?:\/\/)m\./i, "$1");
}

export function parseUrl(url: string): ParsedUrl {
  const trimmedUrl = stripMobileSubdomain(url.trim());

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

export function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "www.youtube.com" ||
      parsed.hostname === "youtube.com" ||
      parsed.hostname === "m.youtube.com"
    ) {
      return parsed.searchParams.get("v");
    }
    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.slice(1) || null;
    }
  } catch {
    // invalid URL
  }
  return null;
}

export function extractYouTubePlaylistId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "www.youtube.com" ||
      parsed.hostname === "youtube.com" ||
      parsed.hostname === "m.youtube.com"
    ) {
      return parsed.searchParams.get("list");
    }
  } catch {
    // invalid URL
  }
  return null;
}

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
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

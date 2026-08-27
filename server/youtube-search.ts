import type { ServiceSearchResult } from "./apple-music-catalog";
import { decodeHtmlEntities } from "./html-metadata";

// ---------------------------------------------------------------------------
// YouTube fallback search
//
// Plenty of releases simply aren't on Apple Music (or Spotify) — small labels,
// self-released tapes, out-of-print records. For those, a YouTube upload is
// often the only way to hear the thing. So when the active streaming service
// comes up empty we take a second look on YouTube.
//
// The catch is that YouTube search always returns *something*: covers, karaoke
// backings, reaction videos, "type beats", someone's chillhop mix that happens
// to mention the artist. A wrong link is worse than no link, so a candidate is
// only accepted when it clears the confidence bar in `judgeYouTubeCandidate` —
// the release title must appear in the video title, the artist must appear on
// the video or own the channel, and whatever is left over must not advertise a
// different version of the recording.
//
// Requires `YOUTUBE_API_KEY` (a YouTube Data API v3 key). Without it the
// fallback cleanly no-ops, exactly like the Spotify search does without its
// credentials.
// ---------------------------------------------------------------------------

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

/** YouTube's "Music" category — keeps talk, gaming and vlog uploads out of the results. */
const MUSIC_CATEGORY_ID = "10";

const MAX_CANDIDATES = 10;

/** The fields of a YouTube search hit the confidence check looks at. */
export interface YouTubeCandidate {
  videoId: string;
  title: string;
  channelTitle: string;
}

/** Why a candidate was accepted, or why it wasn't. */
export type YouTubeMatchVerdict =
  | { confident: true; reason: "topic_channel" | "artist_channel" | "title_and_artist" }
  | {
      confident: false;
      reason: "no_artist" | "no_title" | "title_mismatch" | "artist_mismatch" | "other_version";
    };

/**
 * Phrases that mark an upload as *a different recording* from the release we're
 * looking for. Checked against what's left of the video title once the release
 * title and artist name have been removed, so a release genuinely called
 * "Remixes" (or a band called The Covers) doesn't rule itself out.
 */
const OTHER_VERSION_PATTERNS: RegExp[] = [
  /\bcover(s|ed)?\b/,
  /\bkaraoke\b/,
  /\binstrumental\b/,
  /\bbacking track\b/,
  /\bremix(es|ed)?\b/,
  /\bbootleg\b/,
  /\bmashup\b/,
  /\bmegamix\b/,
  /\bdj (mix|set)\b/,
  /\blive\b/,
  /\bconcert\b/,
  /\bunplugged\b/,
  /\breact(s|ion|ing)?\b/,
  /\bfirst listen\b/,
  /\breview\b/,
  /\binterview\b/,
  /\bdocumentary\b/,
  /\btrailer\b/,
  /\bbehind the scenes\b/,
  /\btribute\b/,
  /\bin the style of\b/,
  /\bmade famous by\b/,
  /\bfan ?made\b/,
  /\blesson\b/,
  /\btutorial\b/,
  /\bhow to play\b/,
  /\bguitar (tab|chords)\b/,
  /\bnightcore\b/,
  /\bsped up\b/,
  /\bslowed\b/,
  /\breverb\b/,
  /\b8 ?bit\b/,
  /\bchiptune\b/,
  /\btype beat\b/,
  /\bai (cover|generated)\b/,
  /\bbest of\b/,
  /\bgreatest hits\b/,
];

/**
 * Lower-case, drop punctuation (to spaces, so "Artist - Title" splits cleanly)
 * and collapse whitespace. Both sides of every comparison go through this, so
 * the exact treatment of apostrophes matters less than applying it uniformly.
 */
function normalizeForMatch(s: string): string {
  return decodeHtmlEntities(s)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drop a Wikipedia-style trailing disambiguator — "Michael Nyman (1981 album)"
 * is filed under that name here, but no uploader ever titles a video with it.
 */
function stripDisambiguator(title: string): string {
  return title
    .replace(/\s*\((?=[^)]*\b(?:album|ep|single|mixtape|soundtrack)\b)[^)]*\)\s*$/i, "")
    .trim();
}

/** Whole-word containment of one normalized phrase within another. */
function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Remove every whole-word occurrence of `phrase` from an already-normalized string. */
function removePhrase(haystack: string, phrase: string): string {
  if (!phrase) return haystack;
  let out = ` ${haystack} `;
  const target = ` ${phrase} `;
  while (out.includes(target)) {
    out = out.replace(target, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * YouTube auto-generates a "<Artist> - Topic" channel for music delivered to it
 * by rights holders — the closest thing the platform has to an official release.
 */
function topicChannelArtist(channelTitle: string): string | null {
  const match = /^(.*?)\s+-\s+Topic$/.exec(decodeHtmlEntities(channelTitle).trim());
  return match ? normalizeForMatch(match[1]) : null;
}

/**
 * Whether a channel is plausibly the artist's own. Deliberately an equality
 * test (modulo spacing and the usual "VEVO" / "Official" / "Records" dressing)
 * rather than containment — "Massive Attack Karaoke Backings" contains the
 * artist's name but is emphatically not their channel.
 */
function channelBelongsToArtist(channelNorm: string, wantedArtist: string): boolean {
  const compact = (s: string) => s.replace(/\s/g, "");
  const artist = compact(wantedArtist);
  if (!artist) return false;
  const base = compact(channelNorm);
  const undressed = compact(channelNorm.replace(/\b(official|music|records|recordings)\b/g, ""));
  return base === artist || base.replace(/vevo$/, "") === artist || undressed === artist;
}

/**
 * Decide whether a YouTube search hit is confidently the requested release.
 *
 * The bar is deliberately high — this only runs after the streaming-service
 * lookup failed, so a wrong link would be the only listen link on the release.
 * All three of these must hold:
 *   1. The artist is known (with no artist there is nothing to verify against).
 *   2. The release title appears, whole-word, in the video title.
 *   3. The artist owns the channel ("<Artist> - Topic" or a channel named after
 *      them) or is named in the video title.
 * And the leftover words must not advertise a cover, live take, remix, reaction
 * or similar — see {@link OTHER_VERSION_PATTERNS}.
 */
export function judgeYouTubeCandidate(
  candidate: YouTubeCandidate,
  title: string,
  artist: string | null,
): YouTubeMatchVerdict {
  const wantedTitle = normalizeForMatch(stripDisambiguator(title)) || normalizeForMatch(title);
  const wantedArtist = artist ? normalizeForMatch(artist) : "";

  if (!wantedArtist) return { confident: false, reason: "no_artist" };
  if (!wantedTitle) return { confident: false, reason: "no_title" };

  const videoTitle = normalizeForMatch(candidate.title);
  const channel = normalizeForMatch(candidate.channelTitle);

  if (!containsPhrase(videoTitle, wantedTitle)) {
    return { confident: false, reason: "title_mismatch" };
  }

  const topicArtist = topicChannelArtist(candidate.channelTitle);
  const isTopicChannel = topicArtist === wantedArtist;
  const isArtistChannel = channelBelongsToArtist(channel, wantedArtist);
  const artistInTitle = containsPhrase(videoTitle, wantedArtist);

  if (!isTopicChannel && !isArtistChannel && !artistInTitle) {
    return { confident: false, reason: "artist_mismatch" };
  }

  // What the uploader added beyond the artist and release title — "official
  // video" and "full album" are fine here, "karaoke version" is not.
  let residue = removePhrase(removePhrase(videoTitle, wantedTitle), wantedArtist);
  if (!isTopicChannel && !isArtistChannel) {
    // The channel is a stranger's, so its name is part of what we're judging.
    residue = `${residue} ${removePhrase(channel, wantedArtist)}`.trim();
  }
  if (OTHER_VERSION_PATTERNS.some((pattern) => pattern.test(residue))) {
    return { confident: false, reason: "other_version" };
  }

  if (isTopicChannel) return { confident: true, reason: "topic_channel" };
  if (isArtistChannel) return { confident: true, reason: "artist_channel" };
  return { confident: true, reason: "title_and_artist" };
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface SearchApiItem {
  id?: { videoId?: unknown };
  snippet?: { title?: unknown; channelTitle?: unknown };
}

function toCandidate(item: SearchApiItem): YouTubeCandidate | null {
  const videoId = getString(item.id?.videoId);
  const title = getString(item.snippet?.title);
  if (!videoId || !title || !/^[\w-]+$/.test(videoId)) return null;
  return { videoId, title, channelTitle: getString(item.snippet?.channelTitle) ?? "" };
}

/**
 * Search YouTube for a release, returning a watch URL only when a result is
 * confidently the right recording — otherwise null.
 *
 * No artwork is ever returned: a video thumbnail is 16:9 and frequently isn't
 * the cover at all, so it has no business becoming a release's artwork.
 */
export async function searchYouTube(
  title: string,
  artist: string | null,
  timeoutMs = 8000,
): Promise<ServiceSearchResult | null> {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return null;

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  // Without an artist there's no way to be confident about a hit, so don't even
  // spend the API quota.
  if (!artist || !normalizeForMatch(artist)) return null;

  try {
    const params = new URLSearchParams({
      key: apiKey,
      part: "snippet",
      type: "video",
      videoCategoryId: MUSIC_CATEGORY_ID,
      // The link feeds the app's in-page YouTube player, so a video that can't
      // be embedded is no use to us.
      videoEmbeddable: "true",
      maxResults: String(MAX_CANDIDATES),
      q: `${artist} ${stripDisambiguator(title)}`,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${SEARCH_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = (await response.json()) as { items?: SearchApiItem[] };
    const items = Array.isArray(data.items) ? data.items : [];

    for (const item of items) {
      const candidate = toCandidate(item);
      if (!candidate) continue;
      if (!judgeYouTubeCandidate(candidate, title, artist).confident) continue;
      return {
        url: `https://www.youtube.com/watch?v=${candidate.videoId}`,
        artworkUrl: null,
      };
    }

    return null;
  } catch {
    return null;
  }
}

import { bareReleaseYear } from "../../domain/release-dates";
import { decodeHtmlEntities } from "../web/html-metadata";

// ---------------------------------------------------------------------------
// Reading a YouTube video as a release
//
// A YouTube link gives up two strings: the video's title and the name of the
// channel that uploaded it. Taking those as the release title and the artist
// works for an artist's own channel, but a great deal of this catalogue only
// reaches YouTube as somebody's vinyl rip. "Rosinha de Valença - 1973",
// uploaded by "Cesar b costa", was stored as a record called "Rosinha De
// Valença - 1973" by Cesar B Costa — a record neither catalogue holds, so the
// resolver abstained on an album MusicBrainz has.
//
// So the title is read the way uploaders write one: "Artist - Title", padded
// out with "(Full Album)", "[Official Video]" or the year. These are rules, not
// a model — the same title always reads the same way, and a title with no
// separator falls back to the channel exactly as it always did, which is the
// right answer for an artist's own channel.
// ---------------------------------------------------------------------------

/**
 * Lower-case, drop punctuation (to spaces, so "Artist - Title" splits cleanly)
 * and collapse whitespace. Both sides of every comparison go through this, so
 * the exact treatment of apostrophes matters less than applying it uniformly.
 */
export function normalizeForMatch(s: string): string {
  return decodeHtmlEntities(s)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The artist a "<Artist> - Topic" channel is named for, as written. YouTube
 * auto-generates these channels for music delivered to it by rights holders —
 * the closest thing the platform has to an official release.
 */
export function topicChannelName(channelTitle: string): string | null {
  const match = /^(.*?)\s+-\s+Topic$/.exec(decodeHtmlEntities(channelTitle).trim());
  const name = match?.[1]?.trim();
  return name ? name : null;
}

/** {@link topicChannelName}, normalized for comparison. */
export function topicChannelArtist(channelTitle: string): string | null {
  const name = topicChannelName(channelTitle);
  return name === null ? null : normalizeForMatch(name);
}

/**
 * Whether a channel is plausibly the artist's own. Deliberately an equality
 * test (modulo spacing and the usual "VEVO" / "Official" / "Records" dressing)
 * rather than containment — "Massive Attack Karaoke Backings" contains the
 * artist's name but is emphatically not their channel.
 */
export function channelBelongsToArtist(channelNorm: string, wantedArtist: string): boolean {
  const compact = (s: string) => s.replace(/\s/g, "");
  const artist = compact(wantedArtist);
  if (!artist) return false;
  const base = compact(channelNorm);
  const undressed = compact(channelNorm.replace(/\b(official|music|records|recordings)\b/g, ""));
  return base === artist || base.replace(/vevo$/, "") === artist || undressed === artist;
}

// ---------------------------------------------------------------------------
// Dressing
// ---------------------------------------------------------------------------

/**
 * Phrases that say the upload is a whole record. Unlike the rest of the
 * dressing these are allowed to stand in for the title: "Los Jaivas - Full
 * Album" names no record, so it reads as self-titled.
 */
const RECORD_MARKERS = [
  "full album",
  "full lp",
  "full ep",
  "complete album",
  "album completo",
  "disco completo",
  "lp completo",
  "album complet",
];

/**
 * Words uploaders pad a title with that say what the upload is, not what the
 * record is called. A bracket, pipe part or trailing dash part made entirely of
 * these (and at most one year) is dropped.
 *
 * Deliberately absent: anything marking a *different recording* — live, remix,
 * instrumental, acoustic — and edition notes like "2016 Remaster". Those are
 * part of what the record is, and the resolver's prefix matching already copes
 * with them trailing a title.
 *
 * None of these may stand in for a whole title the way a record marker can:
 * "LSD - Audio" is a song called "Audio", and PiL's "Album" is an album.
 */
const DRESSING = [
  "official",
  "oficial",
  "music video",
  "video",
  "videoclip",
  "clip",
  "clipe",
  "audio",
  "lyric",
  "lyrics",
  "letra",
  "visualizer",
  "visualiser",
  "hd",
  "hq",
  "4k",
  "1080p",
  "720p",
  "high quality",
  "album",
  "single",
  "lp",
  "ep",
  "stream",
  "vinyl",
  "vinil",
  "vinilo",
  "rip",
];

interface NoisePhrase {
  words: string[];
  recordMarker: boolean;
}

// Longest first, so "album completo" is read as a record marker before "album"
// can claim its first word as plain dressing.
const NOISE_PHRASES: NoisePhrase[] = [
  ...RECORD_MARKERS.map((phrase) => ({ words: phrase.split(" "), recordMarker: true })),
  ...DRESSING.map((phrase) => ({ words: phrase.split(" "), recordMarker: false })),
].sort((a, b) => b.words.length - a.words.length);

/**
 * "Full Album", "full album" and "Álbum Completo" alike, so the phrase lists
 * can be written once in plain lower case.
 */
function noiseKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface NoiseReading {
  /** Every word is dressing, or the one year allowed. Empty text counts. */
  isNoise: boolean;
  year?: number;
  /** The dressing includes a whole-record marker such as "Full Album". */
  recordMarker: boolean;
  /** The text is a year and nothing else. */
  onlyYear: boolean;
}

function readNoise(text: string): NoiseReading {
  const tokens = noiseKey(text).split(" ").filter(Boolean);
  // Text with words in a script noiseKey keeps no letters for — Japanese,
  // Korean, Cyrillic, Greek — still says something; only empty text is noise.
  if (tokens.length === 0) return { isNoise: !text.trim(), recordMarker: false, onlyYear: false };
  let year: number | undefined;
  let recordMarker = false;
  let i = 0;

  scan: while (i < tokens.length) {
    const asYear = bareReleaseYear(tokens[i]!);
    // One year at most: "(1973-1975)" is a span, which is something to keep.
    if (asYear !== null && year === undefined) {
      year = asYear;
      i += 1;
      continue;
    }
    for (const phrase of NOISE_PHRASES) {
      if (phrase.words.every((word, k) => tokens[i + k] === word)) {
        if (phrase.recordMarker) recordMarker = true;
        i += phrase.words.length;
        continue scan;
      }
    }
    return { isNoise: false, recordMarker: false, onlyYear: false };
  }

  return { isNoise: true, year, recordMarker, onlyYear: tokens.length === 1 && year !== undefined };
}

/**
 * Whether a part says nothing about the record's name: empty once its brackets
 * are gone, a whole-record marker, or a bare year.
 *
 * A bare year qualifies only so that it can be set aside and then decided on
 * as a whole — see `classifyYouTubeVideo` for why it ends up as the title.
 */
function isPlaceholder(reading: NoiseReading, text: string): boolean {
  return !text || (reading.isNoise && (reading.recordMarker || reading.onlyYear));
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

const OPENERS = "([{【";
const CLOSERS = ")]}】";

/** A dash with space on both sides, so "Jean-Michel Jarre" never splits. */
const DASH = /\s+(?:-{1,2}|[\u2010-\u2015\u2212])\s+/g;
const PIPE = /\s*[|｜]\s*/g;

const EDGE_SEPARATORS = /^[\s,;:~|｜\-\u2010-\u2015\u2212]+|[\s,;:~|｜\-\u2010-\u2015\u2212]+$/g;

const BRACKETED = /[([{【]([^()[\]{}【】]*)[)\]}】]/g;

/** "Title Full Album", where the marker isn't set off at all. */
const TRAILING_RECORD_MARKER =
  /\s+(?:full\s+(?:album|lp|ep)(?:\s+stream)?|complete\s+album|(?:[aá]lbum|disco|lp)\s+complet[oa]?)$/iu;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimSeparators(text: string): string {
  return collapse(text.replace(EDGE_SEPARATORS, ""));
}

/**
 * Split on every separator that sits outside all brackets, so "Title (1973 -
 * Full Album)" stays one part and its bracket can be judged whole.
 */
function splitOutsideBrackets(text: string, separator: RegExp): string[] {
  const depthAt: number[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    depthAt.push(depth);
    const char = text[i]!;
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char) && depth > 0) depth -= 1;
  }

  const parts: string[] = [];
  let start = 0;
  for (const match of text.matchAll(separator)) {
    const at = match.index ?? 0;
    if (depthAt[at] !== 0) continue;
    parts.push(text.slice(start, at));
    start = at + match[0].length;
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Drop every bracket whose contents are all dressing, offering up the year any
 * of them carried. Repeats until nothing changes, so "((Official Video))"
 * goes too.
 */
function stripNoiseBrackets(text: string, offerYear: (year: number | undefined) => void): string {
  let current = text;
  for (;;) {
    const next = current.replace(BRACKETED, (whole, inner: string) => {
      const noise = readNoise(inner);
      if (!noise.isNoise) return whole;
      offerYear(noise.year);
      return " ";
    });
    if (next === current) return collapse(current);
    current = next;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassifiedVideo {
  artist?: string;
  title?: string;
  /**
   * A release year the uploader set beside the record's name — "Title (1973)",
   * "- 1973" — never one set beside the artist alone. Not set when a year is
   * all the title has: see `classifyYouTubeVideo`.
   */
  year?: number;
}

/**
 * Read a video title and its channel as a release's artist, title and year.
 *
 *   1. A pipe hangs extra matter off a title — "| Full Album | 1973", "| Some
 *      Label" — so only the first part that isn't dressing is read.
 *   2. Brackets made of dressing go: "(Official Video)", "[Full Album]",
 *      "(1973)". A year found in one is kept only where it sits beside the
 *      part that names the record.
 *   3. A "<Artist> - Topic" channel names the artist outright, and its videos
 *      are titled with the track alone. A dash in that title ("Harvest Moon -
 *      Remastered 2009") is part of the track's name, so it is only split when
 *      what's in front of it is that same artist.
 *   4. Otherwise the title splits at its first spaced dash: artist in front,
 *      title behind, with trailing parts of dressing dropped ("- Full Album",
 *      "- 1973"). The two are swapped only when the channel belongs to the name
 *      behind the dash — "Harvest Moon - Neil Young" on Neil Young's channel.
 *   5. With no dash at all, the channel is the artist, as before.
 *
 * When nothing names the record, it is self-titled ("Los Jaivas - Full Album"),
 * matching how unrecognised pages are read in link-extractor.ts — unless a year
 * is all that's left. "Rosinha de Valença - 1973" is her self-titled 1973 album,
 * but "Prince - 1999" is an album called 1999, and no rule can tell them apart.
 * Reading both as self-titled would hand the resolver "Prince" by Prince, which
 * it would confidently match to his 1979 album. So the year is kept as the
 * title, exactly as written, and the resolver tries the self-titled reading
 * itself — accepting it only for a record dated that very year.
 */
export function classifyYouTubeVideo(
  videoTitle: string | undefined,
  channelName: string | undefined,
): ClassifiedVideo {
  const channel = channelName ? collapse(decodeHtmlEntities(channelName)) : "";
  const raw = videoTitle ? collapse(decodeHtmlEntities(videoTitle)) : "";
  // No title to read at all: say so, rather than inventing a self-titled record
  // out of the channel name.
  if (!raw) return { artist: topicChannelName(channel) ?? (channel || undefined) };

  // The first year found wins. A year from a dropped pipe part is a fallback:
  // "Title (1973) | 2016" is the 1973 record, not a 2016 one.
  let year: number | undefined;
  let pipeYear: number | undefined;
  const offerYear = (found: number | undefined): void => {
    year ??= found;
  };

  let main = "";
  for (const part of splitOutsideBrackets(raw, PIPE).map(trimSeparators)) {
    const noise = readNoise(part);
    if (noise.isNoise) pipeYear ??= noise.year;
    else if (!main) main = part;
  }

  const pieces = splitOutsideBrackets(main, DASH).map((segment) => {
    let found: number | undefined;
    const text = trimSeparators(stripNoiseBrackets(segment, (y) => (found ??= y)));
    return { text, year: found };
  });
  const segments = pieces.map((piece) => piece.text);

  const finish = (artist: string | undefined, title: string): ClassifiedVideo => {
    const named = trimSeparators(title.replace(TRAILING_RECORD_MARKER, ""));
    const found = year ?? pipeYear;
    if (named)
      return found === undefined ? { artist, title: named } : { artist, title: named, year: found };
    if (found !== undefined) return { artist, title: String(found) };
    return { artist, title: artist };
  };

  // A year counts only where the uploader set it beside the record's name;
  // "Bad Brains (1979) - I Against I" is not a 1979 record.
  const offerTitleYears = (from: number): void => {
    for (const piece of pieces.slice(from)) offerYear(piece.year);
  };

  const topicArtist = topicChannelName(channel);
  if (topicArtist) {
    const leadsWithArtist =
      segments.length > 1 && normalizeForMatch(segments[0]!) === normalizeForMatch(topicArtist);
    const trackParts = leadsWithArtist ? segments.slice(1) : segments;
    offerTitleYears(leadsWithArtist ? 1 : 0);
    return finish(topicArtist, trackParts.filter(Boolean).join(" - "));
  }

  // "[Full Album] - Artist - Title": a leading part that names nothing is set
  // aside before the artist is read off the front.
  while (segments.length > 1) {
    const reading = readNoise(segments[0]!);
    if (!isPlaceholder(reading, segments[0]!)) break;
    offerYear(reading.year);
    segments.shift();
  }

  if (segments.length < 2) {
    const only = segments[0] ?? "";
    offerTitleYears(pieces.length - 1);
    const reading = readNoise(only);
    if (isPlaceholder(reading, only)) {
      offerYear(reading.year);
      return finish(channel || undefined, "");
    }
    return finish(channel || undefined, only);
  }

  const [artistPart, ...titleParts] = segments as [string, ...string[]];
  offerTitleYears(pieces.length - segments.length + 1);

  while (titleParts.length > 1) {
    const reading = readNoise(titleParts[titleParts.length - 1]!);
    if (!reading.isNoise) break;
    offerYear(reading.year);
    titleParts.pop();
  }
  if (titleParts.length === 1) {
    const reading = readNoise(titleParts[0]!);
    if (isPlaceholder(reading, titleParts[0]!)) {
      offerYear(reading.year);
      titleParts.pop();
    }
  }

  let artist = artistPart;
  let title = titleParts.filter(Boolean).join(" - ");

  const channelNorm = normalizeForMatch(channel);
  if (
    title &&
    channelBelongsToArtist(channelNorm, normalizeForMatch(title)) &&
    !channelBelongsToArtist(channelNorm, normalizeForMatch(artist))
  ) {
    [artist, title] = [title, artist];
  }

  return finish(artist, title);
}

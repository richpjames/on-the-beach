// ---------------------------------------------------------------------------
// External link sources — the hosts a MusicBrainz release group's url-rels
// point at, and the rules for turning one of their pages into item notes.
//
// Pure: no database, no fetching. The rankings themselves live in the
// `external_link_sources` table (the user re-ranks them on /admin); the
// defaults below are what a host is worth the first time it is met.
// ---------------------------------------------------------------------------

export interface LinkSourceInfo {
  /** The row key in `external_link_sources` — a bare host, no `www.`. */
  host: string;
  displayName: string;
}

/**
 * Known hosts, matched by suffix so a language or mirror subdomain folds into
 * its parent: en.wikipedia.org and en.m.wikipedia.org are both Wikipedia.
 * The rank is the default a newly-encountered host is recorded with.
 */
const KNOWN_LINK_SOURCES: ReadonlyArray<{
  host: string;
  displayName: string;
  rank: number;
}> = [
  { host: "wikipedia.org", displayName: "Wikipedia", rank: 11 },
  { host: "pitchfork.com", displayName: "Pitchfork", rank: 10 },
  { host: "allmusic.com", displayName: "AllMusic", rank: 9 },
];

/** What an unrecognised host is worth until the user says otherwise. */
export const DEFAULT_LINK_SOURCE_RANK = 0;

/**
 * The source a URL belongs to, or null when it isn't a usable http(s) URL.
 * An unrecognised host is keyed by its own hostname — it still appears on the
 * admin page and can still be ranked, it just starts at 0.
 */
export function linkSourceForUrl(url: string): LinkSourceInfo | null {
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!hostname) return null;

  const bare = hostname.replace(/^www\./, "");
  for (const known of KNOWN_LINK_SOURCES) {
    if (bare === known.host || bare.endsWith(`.${known.host}`)) {
      return { host: known.host, displayName: known.displayName };
    }
  }
  return { host: bare, displayName: bare };
}

/** The default rank for a host key — the known table's, or 0. */
export function defaultRankForHost(host: string): number {
  return KNOWN_LINK_SOURCES.find((known) => known.host === host)?.rank ?? DEFAULT_LINK_SOURCE_RANK;
}

/**
 * Whether the host is a curated source whose article body the extractor knows
 * how to scope. An unrecognised host has no such wrapper to trust, so its
 * paragraph is held to the sentence test before it may become notes.
 */
export function isKnownLinkSource(host: string): boolean {
  return KNOWN_LINK_SOURCES.some((known) => known.host === host);
}

/**
 * Whether a note already reads as at least one sentence — the bar the user
 * set for leaving existing notes alone. A sentence ends in a terminator
 * followed by whitespace or the end of the text (optionally behind a closing
 * quote or bracket). Dots inside URLs don't count: they are followed by more
 * URL, not whitespace, so a bare provenance line ("From X (https://…)"),
 * however long, is still not a sentence.
 */
export function isAtLeastASentence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /[.!?…]["'”’)\]]*(?:\s|$)/.test(trimmed);
}

/**
 * The provenance line for an ingested paragraph, in the same "From X (url)"
 * shape the listing-page scrape stamps (see `formatPageSourceNote`).
 */
export function formatLinkSourceNote(displayName: string, url: string): string {
  return `From ${displayName} (${url})`;
}

/**
 * The notes an ingested paragraph produces: the paragraph with its source
 * line, appended beneath whatever short note is already there. The caller
 * guarantees the existing notes are empty or less than a sentence — a note
 * that already reads as prose is never touched. Notes render with
 * `white-space: pre-wrap`, so the blank line reads as a paragraph break.
 */
export function composeEnrichedNotes(
  existingNotes: string | null,
  paragraph: string,
  displayName: string,
  url: string,
): string {
  const addition = `${paragraph} — ${formatLinkSourceNote(displayName, url)}`;
  const existing = existingNotes?.trim();
  return existing ? `${existing}\n\n${addition}` : addition;
}

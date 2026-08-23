import { and, desc, eq, isNotNull, isNull, or, lt } from "drizzle-orm";
import { db } from "./db/index";
import { artists, musicItems } from "./db/schema";
import {
  lookupRelease,
  searchArtistCandidates,
  VARIOUS_ARTISTS_MBID,
  type MbArtistCandidate,
} from "./musicbrainz";

// ---------------------------------------------------------------------------
// Artist MBID resolution
//
// This is the part of the artist watch most likely to produce wrong results,
// so it gets the most care. A bare name search for "Nirvana", "Bad Company" or
// "Sun Ra Arkestra" returns several real artists, and picking wrong means
// alerting on a stranger's discography forever.
//
// Resolution ladder, best evidence first:
//   1. From existing items — music_items.musicbrainz_artist_id is already
//      populated by the scan/manual-add enrichment path. No network.
//   2. Via a known release — search for a record we know the artist made and
//      take the artist credit off it. Far safer than a name search.
//   3. Name search — accepted only when the top hit is both strong and clearly
//      ahead of the runner-up.
//
// Anything else stays `unresolved` and is never polled: no alerts is the
// correct failure mode, alerts for the wrong band is not.
// ---------------------------------------------------------------------------

export type MbidConfidence = "confirmed" | "probable" | "unresolved";

// Defined in musicbrainz.ts so the release query builder can pin a compilation
// search to it; re-exported here because this is where callers expect it.
export { VARIOUS_ARTISTS_MBID } from "./musicbrainz";

/**
 * The names a compilation's "artist" goes by. Not a person or a band, so
 * anything that reasons about an artist's discography — the watch, the
 * "you might also like" suggestions — has to leave them alone: there is no
 * such discography to walk.
 */
const VARIOUS_ARTISTS_NAMES = new Set([
  "various",
  "various artist",
  "various artists",
  "va",
  "v/a",
  "v.a.",
  "compilation",
]);

/**
 * Is this a compilation placeholder rather than a real artist? Matched on the
 * MusicBrainz id when we have one, and on the name otherwise — most items get
 * their artist name from a scrape or the user typing it, long before any MBID
 * is resolved.
 */
export function isVariousArtists(
  artistName: string | null | undefined,
  mbid?: string | null,
): boolean {
  if (mbid === VARIOUS_ARTISTS_MBID) return true;
  if (!artistName) return false;
  return VARIOUS_ARTISTS_NAMES.has(artistName.toLowerCase().trim().replace(/\s+/g, " "));
}

/** A name-search hit is only accepted at or above this score. */
const MIN_ACCEPTED_SCORE = 95;
/** …and only when it beats the runner-up by at least this much. */
const MIN_SCORE_MARGIN = 20;

/** Unresolved artists are retried at most this often. */
export const RE_RESOLUTION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ArtistResolution {
  mbid: string | null;
  confidence: MbidConfidence;
  /** Populated when a name search was ambiguous, for the settings picker. */
  candidates?: MbArtistCandidate[];
}

/**
 * Choose an artist from name-search candidates, or refuse to. A single strong
 * hit is `probable`; a strong hit shadowed by an almost-as-strong one is
 * exactly the ambiguity this ladder exists to avoid, so it resolves to nothing
 * and the user is asked instead.
 *
 * Pure — the interesting rules are here rather than behind a fetch.
 */
export function pickArtistFromSearch(candidates: MbArtistCandidate[]): ArtistResolution {
  const ranked = [...candidates]
    .filter((candidate) => candidate.id !== VARIOUS_ARTISTS_MBID)
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  if (!top || top.score < MIN_ACCEPTED_SCORE) {
    return { mbid: null, confidence: "unresolved", candidates: ranked };
  }

  const runnerUp = ranked[1];
  if (runnerUp && top.score - runnerUp.score < MIN_SCORE_MARGIN) {
    return { mbid: null, confidence: "unresolved", candidates: ranked };
  }

  return { mbid: top.id, confidence: "probable", candidates: ranked };
}

/**
 * The MBID most of an artist's items agree on. Ties break towards the value
 * seen on the most recently added item — a re-scan that corrects a bad match
 * should win over an old one.
 */
export async function mbidFromItems(artistId: number): Promise<string | null> {
  const rows = await db
    .select({ mbid: musicItems.musicbrainzArtistId })
    .from(musicItems)
    .where(and(eq(musicItems.artistId, artistId), isNotNull(musicItems.musicbrainzArtistId)))
    .orderBy(desc(musicItems.id));

  const counts = new Map<string, number>();
  for (const row of rows) {
    const mbid = row.mbid;
    if (!mbid || mbid === VARIOUS_ARTISTS_MBID) continue;
    counts.set(mbid, (counts.get(mbid) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  // `rows` is newest-first and Map preserves insertion order, so a strict `>`
  // keeps the most recent of two equally frequent values.
  for (const [mbid, count] of counts) {
    if (count > bestCount) {
      best = mbid;
      bestCount = count;
    }
  }

  return best;
}

/**
 * Backfill artist MBIDs from the items that already carry them. Runs with no
 * network at all, which covers most of a library for free. Only fills artists
 * that have no MBID yet — a value the user confirmed is never overwritten.
 */
export async function backfillArtistMbidsFromItems(): Promise<{ resolved: number }> {
  const unresolved = await db
    .select({ id: artists.id })
    .from(artists)
    .where(isNull(artists.musicbrainzArtistId));

  let resolved = 0;
  const now = new Date();

  for (const artist of unresolved) {
    const mbid = await mbidFromItems(artist.id);
    if (!mbid) continue;

    await db
      .update(artists)
      .set({
        musicbrainzArtistId: mbid,
        mbidConfidence: "confirmed",
        mbidResolvedAt: now,
        updatedAt: now,
      })
      .where(eq(artists.id, artist.id));
    resolved += 1;
  }

  if (resolved > 0) {
    console.log(`[artist-identity] backfilled ${resolved} artist MBID(s) from existing items`);
  }

  return { resolved };
}

/**
 * Resolve one artist's MBID over the network, rungs 2 and 3 of the ladder.
 * Rung 1 (existing items) is tried first and costs nothing, so a caller never
 * has to check it separately.
 *
 * Never throws: a lookup failure resolves to `unresolved`, which is retried on
 * the next sweep after the re-resolution interval.
 */
export async function resolveArtistMbid(artistId: number): Promise<ArtistResolution> {
  const artist = await db
    .select({ id: artists.id, name: artists.name })
    .from(artists)
    .where(eq(artists.id, artistId))
    .get();
  if (!artist) return { mbid: null, confidence: "unresolved" };

  // 1. Existing items.
  const fromItems = await mbidFromItems(artistId);
  if (fromItems) {
    await storeResolution(artistId, { mbid: fromItems, confidence: "confirmed" });
    return { mbid: fromItems, confidence: "confirmed" };
  }

  // 2. Via a release we know they made — the search pins the artist through a
  //    record rather than through their name alone.
  const knownRelease = await db
    .select({ title: musicItems.title, year: musicItems.year })
    .from(musicItems)
    .where(eq(musicItems.artistId, artistId))
    .orderBy(desc(musicItems.id))
    .get();

  if (knownRelease?.title) {
    try {
      const fields = await lookupRelease(
        artist.name,
        knownRelease.title,
        knownRelease.year ? String(knownRelease.year) : undefined,
      );
      const mbid = fields?.musicbrainzArtistId ?? null;
      if (mbid && mbid !== VARIOUS_ARTISTS_MBID) {
        await storeResolution(artistId, { mbid, confidence: "confirmed" });
        return { mbid, confidence: "confirmed" };
      }
    } catch (err) {
      console.warn(`[artist-identity] release-derived lookup failed for "${artist.name}":`, err);
    }
  }

  // 3. Name search, accepted only when unambiguous.
  try {
    const candidates = await searchArtistCandidates(artist.name);
    const picked = pickArtistFromSearch(candidates);
    await storeResolution(artistId, picked);
    if (picked.confidence === "unresolved") {
      console.info("[artist-identity] name search was ambiguous", {
        artist: artist.name,
        candidates: candidates.slice(0, 3).map((c) => ({ name: c.name, score: c.score })),
      });
    }
    return picked;
  } catch (err) {
    console.warn(`[artist-identity] name search failed for "${artist.name}":`, err);
    // Stamp the attempt so a persistently failing artist doesn't get retried
    // on every single sweep.
    await storeResolution(artistId, { mbid: null, confidence: "unresolved" });
    return { mbid: null, confidence: "unresolved" };
  }
}

async function storeResolution(artistId: number, resolution: ArtistResolution): Promise<void> {
  const now = new Date();
  await db
    .update(artists)
    .set({
      musicbrainzArtistId: resolution.mbid,
      mbidConfidence: resolution.confidence,
      mbidResolvedAt: now,
      updatedAt: now,
    })
    .where(eq(artists.id, artistId));
}

/** Manually confirm an MBID for an artist (the settings disambiguation list). */
export async function setArtistMbid(artistId: number, mbid: string): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(artists)
    .set({
      musicbrainzArtistId: mbid,
      mbidConfidence: "confirmed",
      mbidResolvedAt: now,
      // A newly confirmed identity deserves a poll straight away; the old
      // failure count belonged to the wrong artist.
      nextPollAt: now,
      pollFailureCount: 0,
      updatedAt: now,
    })
    .where(eq(artists.id, artistId))
    .returning({ id: artists.id });

  return updated.length > 0;
}

/**
 * Artists eligible for a re-resolution attempt: never attempted, or attempted
 * long enough ago that MusicBrainz may have gained the entry since.
 */
export async function artistsDueForResolution(now: Date = new Date()): Promise<number[]> {
  const cutoff = new Date(now.getTime() - RE_RESOLUTION_INTERVAL_MS);
  const rows = await db
    .select({ id: artists.id })
    .from(artists)
    .where(
      and(
        isNull(artists.musicbrainzArtistId),
        or(isNull(artists.mbidResolvedAt), lt(artists.mbidResolvedAt, cutoff)),
      ),
    );
  return rows.map((row) => row.id);
}

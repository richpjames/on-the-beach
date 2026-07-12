import { and, desc, eq } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems, artists, itemSuggestions } from "./db/schema";
import { findSuggestedRelease } from "./musicbrainz";
import { normalize } from "./utils";

// ---------------------------------------------------------------------------
// Suggestion prefetch
//
// Every artist with at least one 'to-listen' item should have exactly one
// pending suggestion (another release by that artist, looked up on
// MusicBrainz) stored ahead of time, so that when an item is marked
// 'listened' the "you might also like" prompt has something to show
// instantly. The prefetch runs in three places:
//   1. Eagerly, fire-and-forget, when an item is created (music-item-creator)
//      — this covers the web add form and all ingest paths (share extension,
//      email, photo).
//   2. In bulk, via the hourly sweep started from hooks.server.ts, which
//      backfills artists whose items predate this feature and refills after
//      a suggestion is accepted or dismissed.
//   3. Indirectly, when a suggestion is accepted: the newly created item
//      re-enters path 1 and queues up the next release by that artist.
// ---------------------------------------------------------------------------

interface ItemSummary {
  id: number;
  artist_name: string | null;
  year: number | null;
  musicbrainz_artist_id: string | null;
}

export interface StoredSuggestion {
  id: number;
  sourceItemId: number;
  title: string;
  artistName: string;
  itemType: string;
  year: number | null;
  musicbrainzReleaseId: string | null;
  status: string;
  createdAt: Date;
}

/** All suggestion rows for an artist, matched on normalized name. */
async function suggestionsForArtist(artistName: string): Promise<StoredSuggestion[]> {
  const target = normalize(artistName);
  const rows = await db.select().from(itemSuggestions);
  return rows.filter((row) => normalize(row.artistName) === target);
}

/** The artist's single pending suggestion, if one is stored. */
export async function findPendingSuggestionForArtist(
  artistName: string,
): Promise<StoredSuggestion | null> {
  const rows = await suggestionsForArtist(artistName);
  return rows.find((row) => row.status === "pending") ?? null;
}

/**
 * Resolve the pending suggestion to surface for an item: one keyed to the
 * item itself wins, otherwise fall back to the artist's pending suggestion —
 * items created before the prefetch existed (or whose sibling triggered it)
 * still get the artist-level one.
 */
export async function findPendingSuggestionForItem(
  itemId: number,
): Promise<StoredSuggestion | null> {
  const own = await db
    .select()
    .from(itemSuggestions)
    .where(and(eq(itemSuggestions.sourceItemId, itemId), eq(itemSuggestions.status, "pending")))
    .get();
  if (own) return own;

  const itemRow = await db
    .select({ artistName: artists.name })
    .from(musicItems)
    .innerJoin(artists, eq(musicItems.artistId, artists.id))
    .where(eq(musicItems.id, itemId))
    .get();
  if (!itemRow?.artistName) return null;

  return findPendingSuggestionForArtist(itemRow.artistName);
}

/**
 * Look up one extra release by the item's artist on MusicBrainz and store it
 * as a pending suggestion. Skips artists that already have a pending
 * suggestion (one "extra" per artist) and never re-suggests a release that is
 * already tracked or was previously suggested (accepted or dismissed).
 *
 * Returns true when a new suggestion was stored.
 */
export async function fetchAndStoreSuggestion(item: ItemSummary): Promise<boolean> {
  if (!item.artist_name) return false;

  try {
    const previousSuggestions = await suggestionsForArtist(item.artist_name);
    if (previousSuggestions.some((row) => row.status === "pending")) {
      return false;
    }

    // Exclude releases already in the library…
    const artistRows = await db
      .select({ normalizedTitle: musicItems.normalizedTitle })
      .from(musicItems)
      .innerJoin(artists, eq(musicItems.artistId, artists.id))
      .where(eq(artists.normalizedName, normalize(item.artist_name)));

    const trackedTitles = new Set(artistRows.map((r) => r.normalizedTitle));

    // …and releases the user already saw suggested (dismissed or accepted).
    for (const row of previousSuggestions) {
      trackedTitles.add(row.title.toLowerCase().trim());
      trackedTitles.add(normalize(row.title));
    }

    const suggestion = await findSuggestedRelease({
      mbArtistId: item.musicbrainz_artist_id,
      artistName: item.artist_name,
      trackedTitles,
      sourceYear: item.year,
    });

    if (!suggestion) return false;

    await db.insert(itemSuggestions).values({
      sourceItemId: item.id,
      title: suggestion.title,
      artistName: item.artist_name,
      itemType: suggestion.itemType,
      year: suggestion.year,
      musicbrainzReleaseId: suggestion.musicbrainzReleaseId,
      status: "pending",
    });
    return true;
  } catch (err) {
    console.error("[suggestions] Failed to fetch/store suggestion for item", item.id, err);
    return false;
  }
}

/**
 * Fire-and-forget prefetch for a freshly created item. Never throws and never
 * blocks the caller. No-ops under `OTB_DISABLE_EXTERNAL_LOOKUPS` (tests).
 */
export function fetchSuggestionInBackground(item: ItemSummary): void {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return;

  void fetchAndStoreSuggestion(item).catch((err) => {
    console.error("[suggestions] background prefetch failed for item", item.id, err);
  });
}

// Artists whose last lookup found nothing suggestible — don't hammer
// MusicBrainz for them on every sweep. Cleared on server restart.
const emptyLookupBackoff = new Map<string, number>();
const EMPTY_LOOKUP_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** MusicBrainz allows ~1 request/second; each artist lookup makes up to two. */
function sweepThrottleMs(): number {
  const fromEnv = Number(process.env.OTB_SUGGESTION_SWEEP_THROTTLE_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 2_500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ensure every artist with at least one 'to-listen' item has a pending
 * suggestion ready. Runs on startup and hourly (see hooks.server.ts) so items
 * that predate the prefetch — or artists whose suggestion was just accepted
 * or dismissed — get one queued up in the background. Sequential and
 * throttled to respect MusicBrainz rate limits.
 */
export async function ensureSuggestionsForToListenArtists(): Promise<void> {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return;

  const candidates = await db
    .selectDistinct({
      itemId: musicItems.id,
      artistName: artists.name,
      year: musicItems.year,
      mbArtistId: musicItems.musicbrainzArtistId,
    })
    .from(musicItems)
    .innerJoin(artists, eq(musicItems.artistId, artists.id))
    .where(eq(musicItems.listenStatus, "to-listen"))
    .orderBy(desc(musicItems.id));

  if (candidates.length === 0) return;

  const pendingRows = await db
    .select({ artistName: itemSuggestions.artistName })
    .from(itemSuggestions)
    .where(eq(itemSuggestions.status, "pending"));
  const covered = new Set(pendingRows.map((row) => normalize(row.artistName)));

  // Most recent to-listen item per artist represents that artist in the lookup.
  const perArtist = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const key = normalize(candidate.artistName);
    if (!perArtist.has(key)) perArtist.set(key, candidate);
  }

  const now = Date.now();
  let fetched = 0;
  for (const [key, candidate] of perArtist) {
    if (covered.has(key)) continue;
    const backoffUntil = emptyLookupBackoff.get(key);
    if (backoffUntil !== undefined && backoffUntil > now) continue;

    if (fetched > 0) await sleep(sweepThrottleMs());
    fetched += 1;

    const stored = await fetchAndStoreSuggestion({
      id: candidate.itemId,
      artist_name: candidate.artistName,
      year: candidate.year,
      musicbrainz_artist_id: candidate.mbArtistId,
    });

    if (stored) {
      emptyLookupBackoff.delete(key);
    } else {
      emptyLookupBackoff.set(key, now + EMPTY_LOOKUP_BACKOFF_MS);
    }
  }

  if (fetched > 0) {
    console.log(`[suggestions] sweep looked up ${fetched} artist(s)`);
  }
}

/** Test hook: forget empty-lookup backoff state. */
export function __clearSuggestionSweepBackoff(): void {
  emptyLookupBackoff.clear();
}

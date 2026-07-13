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

export type SuggestionFetchOutcome =
  // A new pending suggestion was stored.
  | "stored"
  // The artist already has a pending suggestion — nothing to do.
  | "already-pending"
  // MusicBrainz has no untracked release to suggest; retried after a day.
  | "no-candidates"
  // The lookup failed (network, rate limit, blocked UA); retried on the
  // next sweep or creation — transient failures must not back off for 24h.
  | "error"
  // No artist name, or the artist is inside its no-candidates backoff window.
  | "skipped";

// Artists whose last lookup found nothing suggestible — don't hammer
// MusicBrainz for them on every attempt. Cleared on server restart.
// Lookup *errors* deliberately do not enter this map.
const emptyLookupBackoff = new Map<string, number>();
const EMPTY_LOOKUP_BACKOFF_MS = 24 * 60 * 60 * 1000;

// One lookup per artist at a time. Without this, the on-demand lookup at
// state-change time can race the background prefetch fired at creation: both
// pass the "no pending suggestion" check and both insert a row. A concurrent
// caller joins the in-flight lookup instead.
const inFlightByArtist = new Map<string, Promise<SuggestionFetchOutcome>>();

/**
 * Look up one extra release by the item's artist on MusicBrainz and store it
 * as a pending suggestion. Skips artists that already have a pending
 * suggestion (one "extra" per artist) and never re-suggests a release that is
 * already tracked or was previously suggested (accepted or dismissed).
 */
export async function fetchAndStoreSuggestion(item: ItemSummary): Promise<SuggestionFetchOutcome> {
  const artistName = item.artist_name;
  if (!artistName) return "skipped";

  const artistKey = normalize(artistName);
  const inFlight = inFlightByArtist.get(artistKey);
  if (inFlight) return inFlight;

  const run = fetchAndStoreSuggestionLocked({ ...item, artist_name: artistName }, artistKey);
  inFlightByArtist.set(artistKey, run);
  try {
    return await run;
  } finally {
    inFlightByArtist.delete(artistKey);
  }
}

async function fetchAndStoreSuggestionLocked(
  item: ItemSummary & { artist_name: string },
  backoffKey: string,
): Promise<SuggestionFetchOutcome> {
  const backoffUntil = emptyLookupBackoff.get(backoffKey);
  if (backoffUntil !== undefined && backoffUntil > Date.now()) {
    return "skipped";
  }

  try {
    const previousSuggestions = await suggestionsForArtist(item.artist_name);
    if (previousSuggestions.some((row) => row.status === "pending")) {
      return "already-pending";
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

    if (!suggestion) {
      emptyLookupBackoff.set(backoffKey, Date.now() + EMPTY_LOOKUP_BACKOFF_MS);
      return "no-candidates";
    }

    await db.insert(itemSuggestions).values({
      sourceItemId: item.id,
      title: suggestion.title,
      artistName: item.artist_name,
      itemType: suggestion.itemType,
      year: suggestion.year,
      musicbrainzReleaseId: suggestion.musicbrainzReleaseId,
      status: "pending",
    });
    emptyLookupBackoff.delete(backoffKey);
    console.info("[suggestions] stored suggestion", {
      artist: item.artist_name,
      title: suggestion.title,
      sourceItemId: item.id,
    });
    return "stored";
  } catch (err) {
    console.error(
      `[suggestions] lookup failed for artist "${item.artist_name}" (item ${item.id}):`,
      err,
    );
    return "error";
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve a suggestion for an item at state-change time, looking one up on
 * the spot when nothing was prefetched — e.g. the item was marked listened
 * seconds after being added (before the background prefetch finished), or the
 * earlier prefetch failed. Bounded so the status update stays responsive: on
 * timeout the lookup keeps running in the background and its result is
 * stored for next time.
 */
export async function ensureSuggestionForItemNow(
  itemId: number,
  timeoutMs = 4_500,
): Promise<StoredSuggestion | null> {
  const prefetched = await findPendingSuggestionForItem(itemId);
  if (prefetched) return prefetched;

  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return null;

  const itemRow = await db
    .select({
      artistName: artists.name,
      year: musicItems.year,
      mbArtistId: musicItems.musicbrainzArtistId,
    })
    .from(musicItems)
    .innerJoin(artists, eq(musicItems.artistId, artists.id))
    .where(eq(musicItems.id, itemId))
    .get();
  if (!itemRow?.artistName) return null;

  console.info("[suggestions] no prefetched suggestion — looking up on demand", {
    itemId,
    artist: itemRow.artistName,
  });

  const lookup = fetchAndStoreSuggestion({
    id: itemId,
    artist_name: itemRow.artistName,
    year: itemRow.year,
    musicbrainz_artist_id: itemRow.mbArtistId,
  });
  const outcome = await Promise.race([lookup, sleep(timeoutMs).then(() => "timeout" as const)]);

  if (outcome === "timeout") {
    console.warn("[suggestions] on-demand lookup timed out; result will store in background", {
      itemId,
    });
    return null;
  }

  return findPendingSuggestionForItem(itemId);
}

/** MusicBrainz allows ~1 request/second; each artist lookup makes up to two. */
function sweepThrottleMs(): number {
  const fromEnv = Number(process.env.OTB_SUGGESTION_SWEEP_THROTTLE_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 2_500;
}

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
  const outcomes: Record<string, number> = {};
  for (const [key, candidate] of perArtist) {
    if (covered.has(key)) continue;
    const backoffUntil = emptyLookupBackoff.get(key);
    if (backoffUntil !== undefined && backoffUntil > now) continue;

    if (fetched > 0) await sleep(sweepThrottleMs());
    fetched += 1;

    const outcome = await fetchAndStoreSuggestion({
      id: candidate.itemId,
      artist_name: candidate.artistName,
      year: candidate.year,
      musicbrainz_artist_id: candidate.mbArtistId,
    });
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }

  if (fetched > 0) {
    console.log(`[suggestions] sweep looked up ${fetched} artist(s):`, outcomes);
  }
}

/** Test hook: forget empty-lookup backoff state. */
export function __clearSuggestionSweepBackoff(): void {
  emptyLookupBackoff.clear();
}

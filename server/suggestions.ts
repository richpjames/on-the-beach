import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems, artists, itemSuggestions } from "./db/schema";
import { fetchReleaseGroupIdForRelease, findSuggestedReleases } from "./musicbrainz";
import { getReleaseLengthPreference } from "./settings";
import { normalize } from "./utils";

// ---------------------------------------------------------------------------
// Suggestion prefetch
//
// Every artist with at least one 'to-listen' item should have up to
// SUGGESTION_TARGET pending suggestions (other releases by that artist, looked
// up on MusicBrainz) stored ahead of time, so that when an item is marked
// 'listened' the "you might also like" prompt has something to show
// instantly — and enough of it that the user gets a choice rather than a
// single take-it-or-leave-it release. The prefetch runs in three places:
//   1. Eagerly, fire-and-forget, when an item is created (music-item-creator)
//      — this covers the web add form and all ingest paths (share extension,
//      email, photo).
//   2. In bulk, via the hourly sweep started from hooks.server.ts, which
//      backfills artists whose items predate this feature and refills after
//      a suggestion is accepted or dismissed.
//   3. Indirectly, when a suggestion is accepted: the newly created item
//      re-enters path 1 and queues up the next release by that artist.
// ---------------------------------------------------------------------------

/**
 * How many pending suggestions an artist should have on file — and therefore
 * how many options the "you might also like" prompt offers. Artists with fewer
 * suggestible releases than this simply get what MusicBrainz has.
 */
export const SUGGESTION_TARGET = 3;

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
  musicbrainzReleaseGroupId: string | null;
  status: string;
  createdAt: Date;
}

/** All suggestion rows for an artist, matched on normalized name. */
async function suggestionsForArtist(artistName: string): Promise<StoredSuggestion[]> {
  const target = normalize(artistName);
  const rows = await db.select().from(itemSuggestions);
  return rows.filter((row) => normalize(row.artistName) === target);
}

/** The artist's pending suggestions, oldest first. */
export async function findPendingSuggestionsForArtist(
  artistName: string,
): Promise<StoredSuggestion[]> {
  const rows = await suggestionsForArtist(artistName);
  return rows.filter((row) => row.status === "pending").sort((a, b) => a.id - b.id);
}

/**
 * Resolve the pending suggestions to surface for an item, best first and at
 * most `limit` of them: those keyed to the item itself lead, and the artist's
 * other pending suggestions fill the remaining slots — items created before
 * the prefetch existed (or whose sibling triggered it) still get the
 * artist-level ones.
 */
export async function findPendingSuggestionsForItem(
  itemId: number,
  limit = SUGGESTION_TARGET,
): Promise<StoredSuggestion[]> {
  const own = await db
    .select()
    .from(itemSuggestions)
    .where(and(eq(itemSuggestions.sourceItemId, itemId), eq(itemSuggestions.status, "pending")))
    .orderBy(itemSuggestions.id);

  const itemRow = await db
    .select({ artistName: artists.name })
    .from(musicItems)
    .innerJoin(artists, eq(musicItems.artistId, artists.id))
    .where(eq(musicItems.id, itemId))
    .get();

  const forArtist = itemRow?.artistName
    ? await findPendingSuggestionsForArtist(itemRow.artistName)
    : [];

  const seen = new Set<number>();
  const combined: StoredSuggestion[] = [];
  for (const row of [...own, ...forArtist]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    combined.push(row);
  }
  return combined.slice(0, limit);
}

export type SuggestionFetchOutcome =
  // At least one new pending suggestion was stored.
  | "stored"
  // The artist already has a full set of pending suggestions — nothing to do.
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
 * Look up extra releases by the item's artist on MusicBrainz and store them as
 * pending suggestions, topping the artist up to SUGGESTION_TARGET. Skips
 * artists that already have a full set and never re-suggests a release that is
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
    const pendingCount = previousSuggestions.filter((row) => row.status === "pending").length;
    const wanted = SUGGESTION_TARGET - pendingCount;
    if (wanted <= 0) {
      return "already-pending";
    }

    // Exclude anything already in the library — every artist, every listen
    // status. Title-only matching across artists can rarely block a legit
    // suggestion (self-titled albums, "Greatest Hits"), but a duplicate
    // suggestion is worse than a missed one.
    const libraryRows = await db
      .select({ normalizedTitle: musicItems.normalizedTitle })
      .from(musicItems);

    const trackedTitles = new Set(libraryRows.map((r) => r.normalizedTitle));

    // …and releases the user already saw suggested (dismissed or accepted).
    for (const row of previousSuggestions) {
      trackedTitles.add(row.title.toLowerCase().trim());
      trackedTitles.add(normalize(row.title));
    }

    const suggestions = await findSuggestedReleases({
      mbArtistId: item.musicbrainz_artist_id,
      artistName: item.artist_name,
      trackedTitles,
      sourceYear: item.year,
      lengthPreference: await getReleaseLengthPreference(),
      limit: wanted,
    });

    if (suggestions.length === 0) {
      emptyLookupBackoff.set(backoffKey, Date.now() + EMPTY_LOOKUP_BACKOFF_MS);
      return "no-candidates";
    }

    await db.insert(itemSuggestions).values(
      suggestions.map((suggestion) => ({
        sourceItemId: item.id,
        title: suggestion.title,
        artistName: item.artist_name,
        itemType: suggestion.itemType,
        year: suggestion.year,
        musicbrainzReleaseId: suggestion.musicbrainzReleaseId,
        musicbrainzReleaseGroupId: suggestion.musicbrainzReleaseGroupId,
        status: "pending",
      })),
    );

    // An artist with fewer suggestible releases than we asked for would
    // otherwise be re-looked-up on every sweep for the one slot MusicBrainz
    // can never fill; the backoff makes that a daily retry instead.
    if (suggestions.length < wanted) {
      emptyLookupBackoff.set(backoffKey, Date.now() + EMPTY_LOOKUP_BACKOFF_MS);
    } else {
      emptyLookupBackoff.delete(backoffKey);
    }
    console.info("[suggestions] stored suggestions", {
      artist: item.artist_name,
      titles: suggestions.map((suggestion) => suggestion.title),
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
 * Resolve the suggestions for an item at state-change time, looking them up on
 * the spot when nothing was prefetched — e.g. the item was marked listened
 * seconds after being added (before the background prefetch finished), or the
 * earlier prefetch failed. Bounded so the status update stays responsive: on
 * timeout the lookup keeps running in the background and its result is
 * stored for next time.
 *
 * Whatever was prefetched is used as-is, even if it's a single suggestion:
 * making the user wait on a live MusicBrainz round trip to pad the prompt out
 * to three options is a worse trade than showing the one we have.
 */
export async function ensureSuggestionsForItemNow(
  itemId: number,
  timeoutMs = 4_500,
): Promise<StoredSuggestion[]> {
  const prefetched = await findPendingSuggestionsForItem(itemId);
  if (prefetched.length > 0) return prefetched;

  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return [];

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
  if (!itemRow?.artistName) return [];

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
    return [];
  }

  return findPendingSuggestionsForItem(itemId);
}

/** MusicBrainz allows ~1 request/second; each artist lookup makes up to two. */
function sweepThrottleMs(): number {
  const fromEnv = Number(process.env.OTB_SUGGESTION_SWEEP_THROTTLE_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 2_500;
}

/** How many release-group backfills one sweep will spend MB requests on. */
const BACKFILL_BATCH_SIZE = 25;

/**
 * Fill in `musicbrainzReleaseGroupId` for pending suggestions stored before it
 * was captured. Without it the prompt can only ask Cover Art Archive for the
 * exact pressing, which usually has no scan — and a pending suggestion sticks
 * around until it's accepted or dismissed, so these would otherwise stay
 * artwork-less indefinitely. Failures are left for the next sweep.
 */
export async function backfillSuggestionReleaseGroups(
  limit = BACKFILL_BATCH_SIZE,
): Promise<number> {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return 0;

  const rows = await db
    .select({ id: itemSuggestions.id, releaseId: itemSuggestions.musicbrainzReleaseId })
    .from(itemSuggestions)
    .where(
      and(
        eq(itemSuggestions.status, "pending"),
        isNotNull(itemSuggestions.musicbrainzReleaseId),
        isNull(itemSuggestions.musicbrainzReleaseGroupId),
      ),
    )
    .limit(limit);

  let filled = 0;
  for (const row of rows) {
    if (!row.releaseId) continue;
    try {
      const groupId = await fetchReleaseGroupIdForRelease(row.releaseId);
      if (!groupId) continue;
      await db
        .update(itemSuggestions)
        .set({ musicbrainzReleaseGroupId: groupId })
        .where(eq(itemSuggestions.id, row.id));
      filled += 1;
    } catch (err) {
      console.error("[suggestions] release-group backfill failed for suggestion", row.id, err);
    }
  }

  if (filled > 0) {
    console.log(`[suggestions] backfilled release-group id for ${filled} suggestion(s)`);
  }
  return filled;
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

  // Suggestions already on file come first: an artist with a pending
  // suggestion is skipped below, so this is the only thing that gets their
  // artwork working. The shared MB request gate paces these.
  await backfillSuggestionReleaseGroups();

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
  // Artists are only "covered" once they have a full set — one pending
  // suggestion on file is no longer enough now the prompt offers a choice.
  const pendingPerArtist = new Map<string, number>();
  for (const row of pendingRows) {
    const key = normalize(row.artistName);
    pendingPerArtist.set(key, (pendingPerArtist.get(key) ?? 0) + 1);
  }
  const covered = new Set(
    [...pendingPerArtist]
      .filter(([, count]) => count >= SUGGESTION_TARGET)
      .map(([artistKey]) => artistKey),
  );

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

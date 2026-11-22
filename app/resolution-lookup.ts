import { and, eq, isNull } from "drizzle-orm";
import { db } from "../adapters/db/index";
import { artists, musicItems } from "../adapters/db/schema";
import { normalize } from "../domain/text";
import {
  resolveRelease,
  type ResolutionOutcome,
  type ResolutionStatus,
  type ResolvedIds,
} from "./release-resolver";

// ---------------------------------------------------------------------------
// On-view release resolution
//
// Opening a release asks the catalogues what it is — the same resolution a
// scan runs on the way in and the backfill sweep runs in bulk, here triggered
// by the release page for rows that predate the resolver (or whose last
// attempt failed). The verdict is stamped on the row, so each release is
// asked about once: `absent` is terminal, `failed` stays retryable, and a row
// that already carries release ids from any path keeps its own provenance.
//
// Eligibility mirrors `findResolutionBackfillRows` (resolution-backfill.ts),
// and the guarded write below is shared with the sweep, so the two triggers
// can never disagree about what a resolution may overwrite.
//
// The page is an impatient trigger, so it gets two courtesies the paced sweep
// does not need: a failed attempt is left alone for a cooldown (back/forward,
// a refresh or a second tab must not each re-earn the same throttled answer),
// and concurrent opens of the same release share one in-flight ask.
// ---------------------------------------------------------------------------

export interface ItemForResolution {
  id: number;
  title: string;
  normalizedTitle: string;
  artistName: string | null;
  year: number | null;
  resolutionStatus: string | null;
  resolutionAttemptedAt: Date | null;
  /** Carried so the write never overwrites one that already exists. */
  musicbrainzArtistId: string | null;
  musicbrainzReleaseId: string | null;
  musicbrainzReleaseGroupId: string | null;
  discogsReleaseId: number | null;
  discogsMasterId: number | null;
}

export async function fetchItemForResolution(id: number): Promise<ItemForResolution | null> {
  const rows = await db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      normalizedTitle: musicItems.normalizedTitle,
      artistName: artists.name,
      year: musicItems.year,
      resolutionStatus: musicItems.resolutionStatus,
      resolutionAttemptedAt: musicItems.resolutionAttemptedAt,
      musicbrainzArtistId: musicItems.musicbrainzArtistId,
      musicbrainzReleaseId: musicItems.musicbrainzReleaseId,
      musicbrainzReleaseGroupId: musicItems.musicbrainzReleaseGroupId,
      discogsReleaseId: musicItems.discogsReleaseId,
      discogsMasterId: musicItems.discogsMasterId,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .where(eq(musicItems.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export type ResolutionSkipReason =
  | "lookups_disabled"
  | "already_resolved"
  | "recently_attempted"
  | "carries_ids"
  | "no_artist"
  | "untitled";

const UNTITLED = normalize("Untitled");

/**
 * How long a failed attempt is left alone before the page may ask again. The
 * resolver already backs off within one attempt, so a `failed` verdict means
 * the provider kept throttling or the transport stayed down — re-asking on
 * every view would only re-earn the same answer. The sweep stays the patient
 * retry path: paced, off-peak, and not subject to this cooldown.
 */
export const FAILED_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Why this row is not asked about, or null when it is. The sweep's finder
 * rules, one row at a time: never attempted (or last attempt failed and left
 * alone long enough), no release-level ids of any kind, a named artist and a
 * real title. `absent` is terminal — both catalogues were asked and neither
 * holds the record.
 */
export function resolutionSkipReason(item: ItemForResolution): ResolutionSkipReason | null {
  if (item.resolutionStatus && item.resolutionStatus !== "failed") return "already_resolved";
  if (
    item.resolutionStatus === "failed" &&
    item.resolutionAttemptedAt &&
    Date.now() - item.resolutionAttemptedAt.getTime() < FAILED_RETRY_COOLDOWN_MS
  ) {
    return "recently_attempted";
  }
  if (
    item.musicbrainzReleaseId ||
    item.musicbrainzReleaseGroupId ||
    item.discogsReleaseId ||
    item.discogsMasterId
  ) {
    return "carries_ids";
  }
  if (!item.artistName) return "no_artist";
  if (!item.normalizedTitle || item.normalizedTitle === UNTITLED) return "untitled";
  return null;
}

/**
 * Persist a resolution outcome: ids only when something verified, an artist
 * MBID only where none exists (one from another path — the artist-identity
 * backfill, a hand correction — outranks the resolver's), and the status
 * stamped on every verdict so the row stops (or, for `failed`, stays)
 * eligible. `updatedAt` is untouched — a metadata lookup is not an edit.
 *
 * The write re-asserts no-release-ids eligibility: a row that gained ids from
 * another path while the resolver was asking keeps them — this update simply
 * matches nothing. Shared by the on-view lookup and the backfill sweep.
 * Returns whether the write landed.
 */
export async function writeResolutionOutcome(
  row: { id: number; musicbrainzArtistId: string | null },
  outcome: ResolutionOutcome,
): Promise<boolean> {
  const ids = outcome.status === "matched" || outcome.status === "partial" ? outcome.ids : null;
  const artistIdWrite =
    ids?.musicbrainzArtistId && !row.musicbrainzArtistId
      ? { musicbrainzArtistId: ids.musicbrainzArtistId }
      : {};
  const written = await db
    .update(musicItems)
    .set({
      ...(ids?.musicbrainzReleaseId ? { musicbrainzReleaseId: ids.musicbrainzReleaseId } : {}),
      ...(ids?.musicbrainzReleaseGroupId
        ? { musicbrainzReleaseGroupId: ids.musicbrainzReleaseGroupId }
        : {}),
      ...artistIdWrite,
      ...(ids?.discogsReleaseId ? { discogsReleaseId: ids.discogsReleaseId } : {}),
      ...(ids?.discogsMasterId ? { discogsMasterId: ids.discogsMasterId } : {}),
      resolutionStatus: outcome.status,
      resolutionAttemptedAt: new Date(),
    })
    .where(
      and(
        eq(musicItems.id, row.id),
        isNull(musicItems.musicbrainzReleaseId),
        isNull(musicItems.musicbrainzReleaseGroupId),
        isNull(musicItems.discogsReleaseId),
        isNull(musicItems.discogsMasterId),
      ),
    )
    .returning({ id: musicItems.id });

  return written.length > 0;
}

export type ResolutionLookupOutcome =
  | { kind: "not_found" }
  | { kind: "skipped"; reason: ResolutionSkipReason }
  | { kind: "result"; status: ResolutionStatus; ids: ResolvedIds | null };

/**
 * Resolve one opened release and stamp the verdict. The resolver paces its
 * own provider requests; the page fires this without blocking the render, so
 * a slow catalogue answers into the provenance line when it lands.
 *
 * Concurrent opens of the same release — two tabs, a double-fired mount —
 * share the one in-flight ask instead of each starting their own. The guarded
 * write already keeps concurrent verdicts from fighting; this keeps them from
 * asking twice.
 */
export function lookupResolutionForItem(itemId: number): Promise<ResolutionLookupOutcome> {
  const existing = inFlight.get(itemId);
  if (existing) return existing;
  const pending = resolveItemForView(itemId).finally(() => {
    inFlight.delete(itemId);
  });
  inFlight.set(itemId, pending);
  return pending;
}

const inFlight = new Map<number, Promise<ResolutionLookupOutcome>>();

/**
 * A throw reads as a failed attempt — stamped, retryable after the cooldown —
 * exactly as the sweep treats it, so a throttled request is never recorded as
 * an absence.
 */
async function resolveItemForView(itemId: number): Promise<ResolutionLookupOutcome> {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) {
    return { kind: "skipped", reason: "lookups_disabled" };
  }

  const item = await fetchItemForResolution(itemId);
  if (!item) return { kind: "not_found" };

  const skip = resolutionSkipReason(item);
  if (skip) return { kind: "skipped", reason: skip };

  let outcome: ResolutionOutcome;
  try {
    outcome = await resolveRelease({
      artist: item.artistName!,
      title: item.title,
      year: item.year,
    });
  } catch (err) {
    console.error(`[resolution-lookup] item ${itemId} threw`, err);
    outcome = { status: "failed", ids: null, errors: [] };
  }

  const written = await writeResolutionOutcome(item, outcome);
  if (!written) return { kind: "skipped", reason: "carries_ids" };
  return { kind: "result", status: outcome.status, ids: outcome.ids };
}

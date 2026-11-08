import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../adapters/db/index";
import { artists, musicItems } from "../adapters/db/schema";
import { normalize } from "../domain/text";
import { resolveRelease, type ResolutionStatus } from "./release-resolver";

// ---------------------------------------------------------------------------
// Resolution backfill — rollout step 3 of the resolver integration
// (docs/plans/2026-08-16-release-resolver-integration.md).
//
// New scans resolve as they land; rows that predate the resolver carry no
// work-level ids and no status, so work-key duplicate matching, artist watch
// and artwork fall back to nothing for exactly the records that have been
// there longest. This sweep resolves them.
//
// Eligibility is deliberately narrow: rows with no status and no ids of any
// kind. A row that already carries an id from another path (an Apple Music
// backfill, a hand correction) keeps its own provenance — the sweep confirms
// nothing and contradicts nothing. `absent` is terminal, so re-running never
// re-asks about records neither database holds; `failed` is retryable.
//
// The resolver paces its own provider requests in-process; the sweep adds a
// delay between items. Run it off-peak: as a separate process it cannot share
// the in-process rate gates with live scans.
// ---------------------------------------------------------------------------

export interface ResolutionBackfillRow {
  id: number;
  title: string;
  artist: string;
  year: number | null;
}

const UNTITLED = normalize("Untitled");

/** Rows the sweep may resolve: never attempted (or last attempt failed), no ids, a named artist, a real title. */
export async function findResolutionBackfillRows(
  limit: number | null,
): Promise<ResolutionBackfillRow[]> {
  const query = db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      artist: artists.name,
      year: musicItems.year,
    })
    .from(musicItems)
    .innerJoin(artists, eq(musicItems.artistId, artists.id))
    .where(
      and(
        or(isNull(musicItems.resolutionStatus), eq(musicItems.resolutionStatus, "failed")),
        isNull(musicItems.musicbrainzReleaseId),
        isNull(musicItems.musicbrainzReleaseGroupId),
        isNull(musicItems.discogsReleaseId),
        isNull(musicItems.discogsMasterId),
        sql`${musicItems.normalizedTitle} != ''`,
        sql`${musicItems.normalizedTitle} != ${UNTITLED}`,
      ),
    )
    .orderBy(musicItems.id);

  const rows = limit !== null ? await query.limit(limit) : await query;
  return rows;
}

/**
 * Resolve one row and stamp the verdict. Ids are written only when something
 * verified; `absent` and `failed` stamp status alone so the row stops (or, for
 * `failed`, stays) eligible on the next run. `updatedAt` is untouched — a
 * metadata backfill is not an edit.
 *
 * Exposed for tests; the sweep calls it via `runResolutionBackfill`.
 */
export async function backfillResolutionForRow(
  row: ResolutionBackfillRow,
): Promise<ResolutionStatus> {
  const outcome = await resolveRelease({ artist: row.artist, title: row.title, year: row.year });

  const ids = outcome.status === "matched" || outcome.status === "partial" ? outcome.ids : null;
  await db
    .update(musicItems)
    .set({
      ...(ids?.musicbrainzReleaseId ? { musicbrainzReleaseId: ids.musicbrainzReleaseId } : {}),
      ...(ids?.musicbrainzReleaseGroupId
        ? { musicbrainzReleaseGroupId: ids.musicbrainzReleaseGroupId }
        : {}),
      ...(ids?.musicbrainzArtistId ? { musicbrainzArtistId: ids.musicbrainzArtistId } : {}),
      ...(ids?.discogsReleaseId ? { discogsReleaseId: ids.discogsReleaseId } : {}),
      ...(ids?.discogsMasterId ? { discogsMasterId: ids.discogsMasterId } : {}),
      resolutionStatus: outcome.status,
      resolutionAttemptedAt: new Date(),
    })
    .where(eq(musicItems.id, row.id));

  return outcome.status;
}

export interface ResolutionBackfillSummary {
  processed: number;
  matched: number;
  partial: number;
  absent: number;
  failed: number;
}

/** Run the sweep over every eligible row, paced, counting each verdict. */
export async function runResolutionBackfill(
  limit: number | null,
  delayMs: number,
  onProgress?: (row: ResolutionBackfillRow, status: ResolutionStatus) => void,
): Promise<ResolutionBackfillSummary> {
  const rows = await findResolutionBackfillRows(limit);
  const summary: ResolutionBackfillSummary = {
    processed: 0,
    matched: 0,
    partial: 0,
    absent: 0,
    failed: 0,
  };

  for (const row of rows) {
    let status: ResolutionStatus;
    try {
      status = await backfillResolutionForRow(row);
    } catch (err) {
      // A throw mid-row (transport, db) reads as a failed attempt: stamp it,
      // stay retryable, keep sweeping.
      console.error(`[resolution-backfill] item ${row.id} threw`, err);
      await db
        .update(musicItems)
        .set({ resolutionStatus: "failed", resolutionAttemptedAt: new Date() })
        .where(eq(musicItems.id, row.id));
      status = "failed";
    }
    summary.processed++;
    summary[status]++;
    onProgress?.(row, status);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return summary;
}

/** For --dry-run reporting: eligible rows by current status, on the finder's rules. */
export async function countEligibleByStatus(): Promise<{ neverAttempted: number; failed: number }> {
  const rows = await db
    .select({ status: musicItems.resolutionStatus, count: sql<number>`count(*)` })
    .from(musicItems)
    .where(
      and(
        or(isNull(musicItems.resolutionStatus), inArray(musicItems.resolutionStatus, ["failed"])),
        isNull(musicItems.musicbrainzReleaseId),
        isNull(musicItems.musicbrainzReleaseGroupId),
        isNull(musicItems.discogsReleaseId),
        isNull(musicItems.discogsMasterId),
        isNotNull(musicItems.artistId),
        sql`${musicItems.normalizedTitle} != ''`,
        sql`${musicItems.normalizedTitle} != ${UNTITLED}`,
      ),
    )
    .groupBy(musicItems.resolutionStatus);

  let neverAttempted = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.status === "failed") failed += Number(row.count);
    else neverAttempted += Number(row.count);
  }
  return { neverAttempted, failed };
}

import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../adapters/db/index";
import { artists, musicItems } from "../adapters/db/schema";
import { normalize } from "../domain/text";
import {
  carriesSeriesNumber,
  normalizeForMatch,
  resolveRelease,
  type ResolutionStatus,
} from "./release-resolver";
import { writeResolutionOutcome } from "./resolution-lookup";

// ---------------------------------------------------------------------------
// Resolution backfill — rollout step 3 of the resolver integration
// (docs/plans/2026-08-16-release-resolver-integration.md).
//
// New scans resolve as they land; rows that predate the resolver carry no
// work-level ids and no status, so work-key duplicate matching, artist watch
// and artwork fall back to nothing for exactly the records that have been
// there longest. This sweep resolves them in bulk; opening a release resolves
// it one at a time (resolution-lookup.ts), under the same rules and the same
// shared write.
//
// Eligibility is deliberately narrow: rows with no status and no release-
// level ids of any kind. A row that already carries a release id from another
// path (an Apple Music backfill, a hand correction) keeps its own provenance —
// the sweep confirms nothing and contradicts nothing. An artist MBID alone
// doesn't identify a release, so a row carrying only one (stamped by the
// artist-identity backfill, say) stays eligible for its release ids — but the
// sweep never overwrites an artist MBID that's already there. `absent` is
// terminal, so re-running never re-asks about records neither database holds;
// `failed` is retryable.
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
  /** Carried so the sweep never overwrites one that already exists. */
  musicbrainzArtistId: string | null;
}

const UNTITLED = normalize("Untitled");

/** Rows the sweep may resolve: never attempted (or last attempt failed), no release-level ids, a named artist, a real title. */
export async function findResolutionBackfillRows(
  limit: number | null,
): Promise<ResolutionBackfillRow[]> {
  const query = db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      artist: artists.name,
      year: musicItems.year,
      musicbrainzArtistId: musicItems.musicbrainzArtistId,
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
 * Resolve one row and stamp the verdict, under the shared write's guards
 * (resolution-lookup.ts): ids only when something verified, no release id
 * from another path ever overwritten. `absent` and `failed` stamp status
 * alone so the row stops (or, for `failed`, stays) eligible on the next run.
 *
 * Exposed for tests; the sweep calls it via `runResolutionBackfill`.
 */
export async function backfillResolutionForRow(
  row: ResolutionBackfillRow,
): Promise<ResolutionStatus | "skipped"> {
  const outcome = await resolveRelease({ artist: row.artist, title: row.title, year: row.year });
  const written = await writeResolutionOutcome(row, outcome);
  return written ? outcome.status : "skipped";
}

export interface ResolutionBackfillSummary {
  processed: number;
  matched: number;
  partial: number;
  absent: number;
  failed: number;
  /** Selected, but gained ids from another path before the write landed. */
  skipped: number;
}

/** Run the sweep over every eligible row, paced, counting each verdict. */
export async function runResolutionBackfill(
  limit: number | null,
  delayMs: number,
  onProgress?: (row: ResolutionBackfillRow, status: ResolutionStatus | "skipped") => void,
): Promise<ResolutionBackfillSummary> {
  const rows = await findResolutionBackfillRows(limit);
  const summary: ResolutionBackfillSummary = {
    processed: 0,
    matched: 0,
    partial: 0,
    absent: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of rows) {
    let status: ResolutionStatus | "skipped";
    try {
      status = await backfillResolutionForRow(row);
    } catch (err) {
      // A throw mid-row (transport, db) reads as a failed attempt: stamp it,
      // stay retryable, keep sweeping. The stamp itself is guarded — a throw
      // caused by the database would take this update with it, and one bad
      // row must not cost the whole sweep its summary.
      console.error(`[resolution-backfill] item ${row.id} threw`, err);
      try {
        await db
          .update(musicItems)
          .set({ resolutionStatus: "failed", resolutionAttemptedAt: new Date() })
          .where(eq(musicItems.id, row.id));
      } catch (stampErr) {
        console.error(`[resolution-backfill] could not stamp item ${row.id} as failed`, stampErr);
      }
      status = "failed";
    }
    summary.processed++;
    if (status === "skipped") summary.skipped++;
    else summary[status]++;
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

// ---------------------------------------------------------------------------
// Requeueing numbered absents — healing the Roman-numeral trap
//
// `absent` is terminal, so a row the resolver wrongly abstained on is never
// asked again. Before the digit rule read Roman numerals (release-resolver.ts),
// a sleeve numbered "Vol. 2" against a catalogue filing "Vol. II" hit the
// digit-mismatch ceiling and was stamped absent — a record both databases hold.
// This requeues the obvious victims: absent, id-less rows whose title carries a
// numbered series, in either notation. Clearing the status and the attempt
// timestamp puts them back on the sweep's and the on-view lookup's eligibility,
// so the next run asks again with the fixed rule. Idempotent: a requeued row
// that resolves leaves the absent set, and one that genuinely is absent is
// stamped absent again and drops out.
// ---------------------------------------------------------------------------

export interface NumberedAbsentRow {
  id: number;
  title: string;
  artist: string;
}

/** Absent, id-less rows whose title carries a numbered series — the trap's victims. */
export async function findNumberedAbsentRows(limit: number | null): Promise<NumberedAbsentRow[]> {
  const rows = await db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      artist: artists.name,
    })
    .from(musicItems)
    .innerJoin(artists, eq(musicItems.artistId, artists.id))
    .where(
      and(
        eq(musicItems.resolutionStatus, "absent"),
        isNull(musicItems.musicbrainzReleaseId),
        isNull(musicItems.musicbrainzReleaseGroupId),
        isNull(musicItems.discogsReleaseId),
        isNull(musicItems.discogsMasterId),
        sql`${musicItems.normalizedTitle} != ''`,
        sql`${musicItems.normalizedTitle} != ${UNTITLED}`,
      ),
    )
    .orderBy(musicItems.id);

  // The series test reads the matcher's own normalisation, not the stored
  // lowercase-only `normalized_title`, so punctuation and diacritics collapse
  // the same way the resolver sees them.
  const numbered = rows.filter((row) => carriesSeriesNumber(normalizeForMatch(row.title)));
  return limit !== null ? numbered.slice(0, limit) : numbered;
}

/**
 * Clear the terminal verdict on the numbered absent rows so they become
 * eligible again. The update re-asserts absent-and-id-less: a row that gained
 * an id or changed status since selection keeps its own provenance, the same
 * guard the shared resolution write applies. Returns only the rows whose
 * verdict was really reset — a guarded update that matched nothing is not a
 * requeue, and the caller's count must not overstate what was reopened.
 */
export async function requeueNumberedAbsents(limit: number | null): Promise<NumberedAbsentRow[]> {
  const rows = await findNumberedAbsentRows(limit);
  const requeued: NumberedAbsentRow[] = [];
  for (const row of rows) {
    const updated = await db
      .update(musicItems)
      .set({ resolutionStatus: null, resolutionAttemptedAt: null })
      .where(
        and(
          eq(musicItems.id, row.id),
          eq(musicItems.resolutionStatus, "absent"),
          isNull(musicItems.musicbrainzReleaseId),
          isNull(musicItems.musicbrainzReleaseGroupId),
          isNull(musicItems.discogsReleaseId),
          isNull(musicItems.discogsMasterId),
        ),
      )
      .returning({ id: musicItems.id });
    if (updated.length > 0) requeued.push(row);
  }
  return requeued;
}

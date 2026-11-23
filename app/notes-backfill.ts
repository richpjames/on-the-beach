import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "../adapters/db/index";
import { artists, musicItems } from "../adapters/db/schema";
import { isAtLeastASentence } from "../domain/link-sources";
import { enrichNotesForItem, type NotesEnrichmentOutcome } from "./notes-enrichment";

// ---------------------------------------------------------------------------
// Notes backfill — the bulk counterpart of the creation hook and the on-view
// lookup (notes-enrichment.ts), for items that predate notes enrichment.
//
// Eligibility: never attempted, carrying a MusicBrainz id the enrichment can
// ask about, and notes that are empty or less than a sentence. The sentence
// test is prose-shaped, not SQL-shaped, so the finder selects on the columns
// and the sweep applies it per row. Rows whose notes already read as prose
// are stamped by the core enrichment and drop out of the next run.
//
// MusicBrainz paces its own requests in-process; the sweep adds a delay
// between items. Run it off-peak: as a separate process it cannot share the
// in-process rate gates with live lookups.
// ---------------------------------------------------------------------------

export interface NotesBackfillRow {
  id: number;
  title: string;
  artist: string | null;
  notes: string | null;
}

/** Rows the sweep may enrich: never attempted, a MusicBrainz id present. */
export async function findNotesBackfillRows(limit: number | null): Promise<NotesBackfillRow[]> {
  const rows = await db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      artist: artists.name,
      notes: musicItems.notes,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .where(
      and(
        isNull(musicItems.notesEnrichmentAttemptedAt),
        or(
          isNotNull(musicItems.musicbrainzReleaseGroupId),
          isNotNull(musicItems.musicbrainzReleaseId),
        ),
      ),
    )
    .orderBy(musicItems.id);

  // Prose notes are left alone — the core enrichment would stamp and skip
  // them anyway, but filtering here keeps the sweep's counts honest. The
  // limit applies after the filter, so `--limit N` really processes N rows.
  const eligible = rows.filter((row) => !row.notes || !isAtLeastASentence(row.notes));
  return limit !== null ? eligible.slice(0, limit) : eligible;
}

export type NotesBackfillStatus = "written" | "no_paragraph" | "failed" | "skipped";

function statusForOutcome(outcome: NotesEnrichmentOutcome): NotesBackfillStatus {
  switch (outcome.kind) {
    case "result":
      return outcome.notes ? "written" : "no_paragraph";
    case "skipped":
      return outcome.reason === "lookup_failed" ? "failed" : "skipped";
    case "not_found":
      return "skipped";
  }
}

export interface NotesBackfillSummary {
  processed: number;
  /** A paragraph was ingested into the item's notes. */
  written: number;
  /** Asked, but no link supplied a usable paragraph (or none was attached). */
  noParagraph: number;
  /** MusicBrainz failed mid-row — left unstamped, retryable next run. */
  failed: number;
  /** Settled without a write: notes already prose, or claimed mid-sweep. */
  skipped: number;
}

/** Run the sweep over every eligible row, paced, counting each outcome. */
export async function runNotesBackfill(
  limit: number | null,
  delayMs: number,
  onProgress?: (row: NotesBackfillRow, status: NotesBackfillStatus) => void,
): Promise<NotesBackfillSummary> {
  const rows = await findNotesBackfillRows(limit);
  const summary: NotesBackfillSummary = {
    processed: 0,
    written: 0,
    noParagraph: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of rows) {
    let status: NotesBackfillStatus;
    try {
      status = statusForOutcome(await enrichNotesForItem(row.id));
    } catch (err) {
      // A throw mid-row reads as a failed attempt: left unstamped by the
      // core, retryable, and one bad row must not cost the whole sweep.
      console.error(`[notes-backfill] item ${row.id} threw`, err);
      status = "failed";
    }
    summary.processed++;
    if (status === "written") summary.written++;
    else if (status === "no_paragraph") summary.noParagraph++;
    else if (status === "failed") summary.failed++;
    else summary.skipped++;
    onProgress?.(row, status);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return summary;
}

/** For --dry-run reporting: how many rows the sweep would consider. */
export async function countNotesBackfillEligible(): Promise<number> {
  const rows = await findNotesBackfillRows(null);
  return rows.length;
}

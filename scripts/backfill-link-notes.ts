#!/usr/bin/env bun
/**
 * One-off backfill: enrich the notes of existing items that predate notes
 * enrichment.
 *
 * Selects items never attempted, carrying a MusicBrainz id, whose notes are
 * empty or less than a sentence; fetches the first paragraph of the release's
 * best-ranked external link and stores it with a provenance line. Idempotent:
 * the attempt marker takes a row out of eligibility on a hit and a miss alike,
 * so re-running only touches what remains (a MusicBrainz failure is left
 * unstamped and retryable).
 *
 * Usage:
 *   bun run scripts/backfill-link-notes.ts [--limit N] [--delay MS] [--dry-run]
 *
 *   --limit N    Process at most N items (default: all eligible).
 *   --delay MS   Delay between items in ms (default: 1000). MusicBrainz paces
 *                its own requests on top of this; the page fetches are not
 *                rate-gated, so keep the delay polite.
 *   --dry-run    Report the eligible rows without fetching or writing.
 *
 * Run off-peak: as its own process this cannot share the in-process rate gates
 * with live lookups, so its requests count against the providers' allowances
 * separately.
 */
import {
  runNotesBackfill,
  countNotesBackfillEligible,
  findNotesBackfillRows,
} from "../app/notes-backfill";

interface Args {
  limit: number | null;
  delayMs: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: null, delayMs: 1000, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      args.limit = Number(argv[++i]);
    } else if (arg === "--delay") {
      args.delayMs = Number(argv[++i]);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/backfill-link-notes.ts [--limit N] [--delay MS] [--dry-run]",
      );
      process.exit(0);
    } else {
      // A typo'd flag (--dryrun) must not fall through into a full mutating
      // run that was meant to be a report.
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) {
    throw new Error("--delay must be a non-negative number");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS && !args.dryRun) {
    console.error("OTB_DISABLE_EXTERNAL_LOOKUPS is set — enrichment would no-op. Aborting.");
    process.exit(1);
  }

  if (args.dryRun) {
    const count = await countNotesBackfillEligible();
    console.log(`Eligible: ${count} items with MusicBrainz ids and notes to fill.`);
    const rows = await findNotesBackfillRows(args.limit);
    for (const row of rows) {
      console.log(`  #${row.id}  ${row.artist ?? "(no artist)"} — ${row.title}`);
    }
    return;
  }

  console.log(`Enriching eligible items${args.limit !== null ? ` (limit ${args.limit})` : ""}…`);
  const summary = await runNotesBackfill(args.limit, args.delayMs, (row, status) => {
    console.log(`  #${row.id}  ${row.artist ?? "(no artist)"} — ${row.title}: ${status}`);
  });

  console.log(
    `\nDone. ${summary.processed} processed — ` +
      `${summary.written} written, ${summary.noParagraph} no paragraph, ` +
      `${summary.failed} failed (retryable), ${summary.skipped} skipped.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

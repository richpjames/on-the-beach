#!/usr/bin/env bun
/**
 * One-off heal: requeue releases the Roman-numeral trap wrongly stamped absent.
 *
 * Before the resolver's digit rule read Roman numerals, a sleeve numbered
 * "Vol. 2" against a catalogue filing "Vol. II" hit the digit-mismatch ceiling
 * and was abstained on — stamped `absent`, which is terminal, so the row was
 * never asked again even though both databases hold it (e.g. Sugar Minott's
 * "Dance Hall Showcase, Vol. 2", Discogs master 122464). This clears the verdict
 * on absent, id-less rows whose title carries a numbered series — a series
 * marker in any notation ("Vol. 2", "Vol. II", "Part One", "Parte Primera") or a
 * volume-range Roman numeral (i/v/x) anywhere in the title ("Dance Hall Showcase
 * II", "Dance Hall Showcase II (1979)") — putting them back on the backfill
 * sweep's and the on-view lookup's eligibility so the next run resolves them
 * with the fixed rule.
 *
 * A sleeve numbered with a bare Arabic digit and no marker ("Dance Hall
 * Showcase 2") is not selected: syntactically it is indistinguishable from a
 * number-named record like "Guaco 76", which is not a series victim. Correct
 * such a row by hand (paste its catalogue id into the edit form) rather than
 * re-asking every number-named row in the catalogue.
 *
 * It writes no ids and asks no provider — it only reopens the question. Run the
 * resolution backfill (scripts/backfill-resolution.ts) afterwards, or just open
 * the releases, to collect the new verdicts. Idempotent: a requeued row that
 * resolves leaves the absent set; one that genuinely is absent is stamped absent
 * again and drops out.
 *
 * Usage:
 *   bun run scripts/retry-absent-resolution.ts [--limit N] [--dry-run]
 *
 *   --limit N    Requeue at most N rows (default: all eligible).
 *   --dry-run    List the rows that would be requeued, without writing.
 */
import { findNumberedAbsentRows, requeueNumberedAbsents } from "../app/resolution-backfill";

interface Args {
  limit: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      args.limit = Number(argv[++i]);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run scripts/retry-absent-resolution.ts [--limit N] [--dry-run]");
      process.exit(0);
    } else {
      // A typo'd flag must not fall through into a mutating run meant as a report.
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    const rows = await findNumberedAbsentRows(args.limit);
    console.log(`${rows.length} absent row(s) carry a numbered series and would be requeued:`);
    for (const row of rows) {
      console.log(`  #${row.id}  ${row.artist} — ${row.title}`);
    }
    return;
  }

  const rows = await requeueNumberedAbsents(args.limit);
  console.log(`Requeued ${rows.length} absent row(s):`);
  for (const row of rows) {
    console.log(`  #${row.id}  ${row.artist} — ${row.title}`);
  }
  console.log("\nRun scripts/backfill-resolution.ts (or open the releases) to resolve them.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env bun
/**
 * One-off backfill: resolve existing items that predate the release resolver.
 *
 * Selects items with no catalogue ids and no resolution status (or a retryable
 * `failed` one), runs the verified resolver against each, and stamps the ids
 * and verdict. Idempotent: `absent` is terminal and ids, once written, take the
 * row out of eligibility, so re-running only touches what remains.
 *
 * Usage:
 *   bun run scripts/backfill-resolution.ts [--limit N] [--delay MS] [--dry-run]
 *
 *   --limit N    Process at most N items (default: all eligible).
 *   --delay MS   Delay between items in ms (default: 1000). The resolver paces
 *                its own provider requests on top of this.
 *   --dry-run    Report eligibility counts without resolving or writing.
 *
 * Run off-peak: as its own process this cannot share the in-process rate gates
 * with live scans, so its requests count against the providers' allowances
 * separately.
 */
import {
  runResolutionBackfill,
  countEligibleByStatus,
  findResolutionBackfillRows,
} from "../app/resolution-backfill";

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
        "Usage: bun run scripts/backfill-resolution.ts [--limit N] [--delay MS] [--dry-run]",
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
    console.error("OTB_DISABLE_EXTERNAL_LOOKUPS is set — the resolver would no-op. Aborting.");
    process.exit(1);
  }

  if (args.dryRun) {
    const counts = await countEligibleByStatus();
    console.log(
      `Eligible: ${counts.neverAttempted} never attempted, ${counts.failed} failed (retryable).`,
    );
    const rows = await findResolutionBackfillRows(args.limit);
    for (const row of rows) {
      console.log(`  #${row.id}  ${row.artist} — ${row.title}`);
    }
    return;
  }

  console.log(`Resolving eligible items${args.limit !== null ? ` (limit ${args.limit})` : ""}…`);
  const summary = await runResolutionBackfill(args.limit, args.delayMs, (row, status) => {
    console.log(`  #${row.id}  ${row.artist} — ${row.title}: ${status}`);
  });

  console.log(
    `\nDone. ${summary.processed} processed — ` +
      `${summary.matched} matched, ${summary.partial} partial, ` +
      `${summary.absent} absent (terminal), ${summary.failed} failed (retryable)` +
      (summary.skipped > 0 ? `, ${summary.skipped} skipped (gained ids mid-sweep).` : "."),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

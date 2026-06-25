#!/usr/bin/env bun
/**
 * One-off backfill: look up an Apple Music secondary link for existing items
 * that predate eager enrichment.
 *
 * Selects items that have never had a lookup attempted (apple_music_lookup_at IS
 * NULL) and aren't themselves Apple Music links, then runs the shared
 * `lookupAppleMusicForItem` against each. Idempotent: every attempt stamps the
 * `apple_music_lookup_at` marker, so re-running only touches items still missing
 * a marker. Rate-limited to stay polite to the iTunes Search API.
 *
 * Usage:
 *   bun run scripts/backfill-apple-music.ts [--limit N] [--delay MS] [--dry-run]
 *
 *   --limit N    Process at most N items (default: all eligible).
 *   --delay MS   Delay between lookups in ms (default: 1000).
 *   --dry-run    List eligible items without querying iTunes or writing.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../server/db/index";
import { musicItems, musicLinks, sources } from "../server/db/schema";
import { lookupAppleMusicForItem } from "../server/apple-music-enrichment";

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
        "Usage: bun run scripts/backfill-apple-music.ts [--limit N] [--delay MS] [--dry-run]",
      );
      process.exit(0);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Items never attempted that already have an Apple Music link wired up are skipped. */
async function findEligibleItemIds(limit: number | null): Promise<number[]> {
  const appleSourceId = db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.name, "apple_music"));

  const query = db
    .select({ id: musicItems.id })
    .from(musicItems)
    .where(
      and(
        isNull(musicItems.appleMusicLookupAt),
        // Exclude items that already have any Apple Music link (primary or not).
        sql`${musicItems.id} NOT IN (
          SELECT ${musicLinks.musicItemId} FROM ${musicLinks}
          WHERE ${musicLinks.sourceId} IN (${appleSourceId})
        )`,
      ),
    )
    .orderBy(musicItems.id);

  const rows = limit !== null ? await query.limit(limit) : await query;
  return rows.map((r) => r.id);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS && !args.dryRun) {
    console.error("OTB_DISABLE_EXTERNAL_LOOKUPS is set — iTunes lookups would no-op. Aborting.");
    process.exit(1);
  }

  const ids = await findEligibleItemIds(args.limit);
  console.log(`Found ${ids.length} eligible item(s).`);

  if (args.dryRun) {
    console.log(ids.join(", "));
    return;
  }

  let hits = 0;
  let misses = 0;
  let skipped = 0;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const outcome = await lookupAppleMusicForItem(id);
      if (outcome.kind === "result" && outcome.url) {
        hits++;
        console.log(`[${i + 1}/${ids.length}] item ${id} → ${outcome.url}`);
      } else if (outcome.kind === "result") {
        misses++;
        console.log(`[${i + 1}/${ids.length}] item ${id} → no match`);
      } else {
        skipped++;
        console.log(`[${i + 1}/${ids.length}] item ${id} → skipped (${outcome.kind})`);
      }
    } catch (err) {
      console.error(`[${i + 1}/${ids.length}] item ${id} → error:`, err);
    }

    if (i < ids.length - 1 && args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  console.log(`Done. ${hits} hit(s), ${misses} miss(es), ${skipped} skipped.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

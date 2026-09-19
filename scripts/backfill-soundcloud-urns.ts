#!/usr/bin/env bun
/**
 * One-off backfill: rescrape existing SoundCloud links for the resource urn
 * the embedded player needs, for links saved before the scrape stored one.
 *
 * A SoundCloud link only gets a player once its scrape has stored a
 * `soundcloud_urn` in `music_links.metadata` (see server/soundcloud.ts) — links
 * added before that are plain links out. This walks every SoundCloud link whose
 * metadata doesn't yet carry a urn and re-runs the added-link scrape against
 * it, merging the urn into whatever metadata the link already holds. Idempotent:
 * a stored urn takes the link out of the eligible set, so re-running only
 * retries links that came up empty (a deleted track, a scrape failure).
 *
 * Usage:
 *   bun run scripts/backfill-soundcloud-urns.ts [--limit N] [--delay MS] [--dry-run]
 *
 *   --limit N    Process at most N links (default: all eligible).
 *   --delay MS   Delay between scrapes in ms (default: 1000).
 *   --dry-run    List eligible links without scraping or writing.
 */
import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import { db } from "../server/db/index";
import { musicLinks, sources } from "../server/db/schema";
import { scrapeAddedLink } from "../server/added-link-scrape";

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
        "Usage: bun run scripts/backfill-soundcloud-urns.ts [--limit N] [--delay MS] [--dry-run]",
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

/** SoundCloud links whose metadata doesn't yet name a playable resource. */
async function findEligibleLinks(limit: number | null) {
  const query = db
    .select({
      id: musicLinks.id,
      url: musicLinks.url,
      metadata: musicLinks.metadata,
      item: musicLinks.musicItemId,
      source: sources.name,
    })
    .from(musicLinks)
    .leftJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(
      and(
        like(musicLinks.url, "%soundcloud.com/%"),
        or(isNull(musicLinks.metadata), sql`${musicLinks.metadata} NOT LIKE '%soundcloud_urn%'`),
      ),
    )
    .orderBy(musicLinks.id);

  return limit !== null ? query.limit(limit) : query;
}

/** The link's metadata object, or {} for missing/malformed JSON. */
function parseMetadata(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // keep whatever else the link holds, don't lose it to a rewrite
  }
  return raw ? { _original: raw } : {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS && !args.dryRun) {
    console.error("OTB_DISABLE_EXTERNAL_LOOKUPS is set — scrapes would no-op. Aborting.");
    process.exit(1);
  }

  const rows = await findEligibleLinks(args.limit);
  console.log(`Found ${rows.length} eligible SoundCloud link(s).`);

  if (args.dryRun) {
    for (const row of rows) {
      console.log(`link ${row.id} (item ${row.item}) → ${row.url}`);
    }
    return;
  }

  let hits = 0;
  let misses = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      // Artwork isn't the backfill's business — the release page fills gaps of
      // its own; here only the player id is wanted.
      const scraped = await scrapeAddedLink(row.url, false);
      const embed = scraped.metadata ? parseMetadata(scraped.metadata) : {};
      const urn = embed.soundcloud_urn;

      if (!urn) {
        misses++;
        console.log(`[${i + 1}/${rows.length}] link ${row.id} → no urn (${row.url})`);
      } else {
        // Merge, never overwrite: the link may already hold other embed ids.
        const merged = { ...parseMetadata(row.metadata), soundcloud_urn: urn };
        await db
          .update(musicLinks)
          .set({ metadata: JSON.stringify(merged) })
          .where(eq(musicLinks.id, row.id));
        hits++;
        console.log(`[${i + 1}/${rows.length}] link ${row.id} → ${urn}`);
      }
    } catch (err) {
      console.error(`[${i + 1}/${rows.length}] link ${row.id} → error:`, err);
    }

    if (i < rows.length - 1 && args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  console.log(`Done. ${hits} urn(s) stored, ${misses} without one.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

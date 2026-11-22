#!/usr/bin/env bun
/**
 * One-off repair: fix secondary Apple Music links that play one track instead
 * of the record, or point at the wrong record altogether.
 *
 * Two faults, both inherited from the old artist-only search pass (removed in
 * dbda747) and the catalogue's track deep-links:
 *   1. A link the old pass attached to the artist's *other* release, because
 *      the catalogue carries the artist but not the record under that name.
 *   2. A `?i=` track deep-link, which the player queues as a single song.
 *
 * MusicBrainz's editor-attached url relations are the ground truth: where they
 * name an Apple Music page for the release, that page replaces the stored
 * link. Otherwise a track deep-link is reduced to the album it points into.
 * Primary links are never touched — only the secondary ones lookups attached.
 * Backfilling cannot do this: it skips items that already have a link.
 *
 * Usage:
 *   bun run scripts/repair-apple-music-links.ts [--limit N] [--delay MS] [--dry-run]
 *
 *   --limit N    Process at most N links (default: all).
 *   --delay MS   Delay between items in ms (default: 1000).
 *   --dry-run    List planned repairs without writing.
 *
 * Refuses to run with OTB_DISABLE_EXTERNAL_LOOKUPS set: the MusicBrainz half
 * would be silently skipped and the summary would overstate what was done.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../adapters/db/index";
import { musicItems, musicLinks, sources } from "../adapters/db/schema";
import {
  appleMusicRepairTarget,
  findAppleMusicUrlViaMusicBrainz,
} from "../app/secondary-link-enrichment";

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
        "Usage: bun run scripts/repair-apple-music-links.ts [--limit N] [--delay MS] [--dry-run]",
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

/**
 * Every secondary Apple Music link, with its item's MusicBrainz ids. Primary
 * links are the user's own statement of where the release lives — a deep-link
 * there may be deliberate, so only secondary ones are repairable.
 */
async function findRepairableLinks(limit: number | null) {
  const query = db
    .select({
      linkId: musicLinks.id,
      itemId: musicItems.id,
      url: musicLinks.url,
      musicbrainzReleaseId: musicItems.musicbrainzReleaseId,
      musicbrainzReleaseGroupId: musicItems.musicbrainzReleaseGroupId,
    })
    .from(musicLinks)
    .innerJoin(musicItems, eq(musicLinks.musicItemId, musicItems.id))
    .innerJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(and(eq(sources.name, "apple_music"), eq(musicLinks.isPrimary, false)))
    .orderBy(musicLinks.id);

  const rows = limit !== null ? await query.limit(limit) : await query;
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // The MusicBrainz half of the repair no-ops under the test/dev kill switch.
  // Running with it set would report success while silently skipping every
  // wrong-record repair — refuse instead.
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) {
    console.error(
      "OTB_DISABLE_EXTERNAL_LOOKUPS is set: the MusicBrainz lookups this repair relies on would be silently skipped. Unset it and re-run.",
    );
    process.exit(1);
  }

  const rows = await findRepairableLinks(args.limit);
  console.log(`Found ${rows.length} secondary Apple Music link(s).`);

  let repaired = 0;
  let unchanged = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    try {
      const mbUrl = await findAppleMusicUrlViaMusicBrainz(row);
      const target = appleMusicRepairTarget(row.url, mbUrl);
      if (!target) {
        unchanged++;
        continue;
      }

      const via = target === mbUrl ? "musicbrainz" : "album-url";
      if (!args.dryRun) {
        await db.update(musicLinks).set({ url: target }).where(eq(musicLinks.id, row.linkId));
      }
      console.log(`[${i + 1}/${rows.length}] item ${row.itemId}: ${row.url} → ${target} (${via})`);
      repaired++;
    } catch (err) {
      errors++;
      console.error(`[${i + 1}/${rows.length}] item ${row.itemId} → error:`, err);
    }

    if (i < rows.length - 1 && args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  const verb = args.dryRun ? "Would repair" : "Repaired";
  console.log(`Done. ${verb} ${repaired}, ${unchanged} unchanged, ${errors} error(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

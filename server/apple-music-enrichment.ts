import { and, eq } from "drizzle-orm";
import { db } from "./db/index";
import { artists, musicItems, musicLinks, sources } from "./db/schema";
import { parseUrl } from "./utils";
import { searchAppleMusic } from "./scraper";

// Re-exported so the release route can source its injectable default from the
// same module as the rest of the lookup dependencies.
export { searchAppleMusic };

// ---------------------------------------------------------------------------
// Shared Apple Music secondary-link lookup
//
// A music item that isn't itself an Apple Music link can still be enriched with
// an Apple Music link looked up from the iTunes Search API. This logic runs in
// three places:
//   1. Eagerly, fire-and-forget, when an item is created (music-item-creator).
//   2. Lazily, on demand, when a release page is viewed (routes/release).
//   3. In bulk, via the one-off backfill script for pre-existing items.
//
// All three share the orchestration below so the skip rules and the
// `apple_music_lookup_at` marker stay consistent.
// ---------------------------------------------------------------------------

export interface ItemInfoForLookup {
  title: string;
  artistName: string | null;
  primarySource: string | null;
  primaryUrl: string | null;
  /** Set once a lookup has been attempted (hit or miss); used to avoid re-querying. */
  appleMusicLookupAt: Date | null;
}

export type FetchItemForLookupFn = (id: number) => Promise<ItemInfoForLookup | null>;
export type GetExistingAppleMusicLinkFn = (itemId: number) => Promise<string | null>;
export type SearchAppleMusicFn = (title: string, artist: string | null) => Promise<string | null>;
export type SaveAppleMusicLinkFn = (itemId: number, url: string) => Promise<void>;
export type StampAppleMusicLookupFn = (itemId: number) => Promise<void>;

export async function fetchItemForLookup(id: number): Promise<ItemInfoForLookup | null> {
  const rows = await db
    .select({
      title: musicItems.title,
      artistName: artists.name,
      primarySource: sources.name,
      primaryUrl: musicLinks.url,
      appleMusicLookupAt: musicItems.appleMusicLookupAt,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .leftJoin(
      musicLinks,
      and(eq(musicLinks.musicItemId, musicItems.id), eq(musicLinks.isPrimary, true)),
    )
    .leftJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(eq(musicItems.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    title: row.title,
    artistName: row.artistName ?? null,
    primarySource: row.primarySource ?? null,
    primaryUrl: row.primaryUrl ?? null,
    appleMusicLookupAt: row.appleMusicLookupAt ?? null,
  };
}

export async function getExistingAppleMusicLink(itemId: number): Promise<string | null> {
  const rows = await db
    .select({ url: musicLinks.url })
    .from(musicLinks)
    .innerJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(and(eq(musicLinks.musicItemId, itemId), eq(sources.name, "apple_music")))
    .limit(1);

  return rows[0]?.url ?? null;
}

export async function saveAppleMusicLink(itemId: number, url: string): Promise<void> {
  const sourceRows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.name, "apple_music"))
    .limit(1);

  const sourceId = sourceRows[0]?.id ?? null;

  try {
    await db.insert(musicLinks).values({
      musicItemId: itemId,
      sourceId,
      url,
      isPrimary: false,
      metadata: null,
    });
  } catch {
    // Likely a unique constraint violation — link already exists
  }
}

export async function stampAppleMusicLookup(itemId: number): Promise<void> {
  await db
    .update(musicItems)
    .set({ appleMusicLookupAt: new Date() })
    .where(eq(musicItems.id, itemId));
}

export interface AppleMusicLookupDeps {
  fetchItem: FetchItemForLookupFn;
  getExisting: GetExistingAppleMusicLinkFn;
  search: SearchAppleMusicFn;
  save: SaveAppleMusicLinkFn;
  stamp: StampAppleMusicLookupFn;
}

export const defaultAppleMusicLookupDeps: AppleMusicLookupDeps = {
  fetchItem: fetchItemForLookup,
  getExisting: getExistingAppleMusicLink,
  search: searchAppleMusic,
  save: saveAppleMusicLink,
  stamp: stampAppleMusicLookup,
};

export type AppleMusicLookupOutcome =
  | { kind: "not_found" }
  | { kind: "skipped"; reason: "apple_music_primary" | "already_attempted" }
  | { kind: "result"; url: string | null };

/** True when the item's primary link is itself an Apple Music URL. */
function hasApplePrimary(item: ItemInfoForLookup): boolean {
  if (!item.primaryUrl) return false;
  return (
    parseUrl(item.primaryUrl).source === "apple_music" ||
    item.primaryUrl.includes("music.apple.com")
  );
}

/**
 * Core lookup orchestration shared by the route, the eager creation hook, and
 * the backfill script. Resolves an Apple Music secondary link for an item that
 * isn't itself an Apple Music link, persisting a hit and stamping the
 * `apple_music_lookup_at` marker on both a hit and a miss.
 */
export async function lookupAppleMusicForItem(
  itemId: number,
  deps: AppleMusicLookupDeps = defaultAppleMusicLookupDeps,
): Promise<AppleMusicLookupOutcome> {
  const item = await deps.fetchItem(itemId);
  if (!item) return { kind: "not_found" };

  if (hasApplePrimary(item)) {
    return { kind: "skipped", reason: "apple_music_primary" };
  }

  const existing = await deps.getExisting(itemId);
  if (existing) return { kind: "result", url: existing };

  // A previous attempt already came up empty — don't hammer iTunes on every view.
  if (item.appleMusicLookupAt) {
    return { kind: "skipped", reason: "already_attempted" };
  }

  const url = await deps.search(item.title, item.artistName);
  await deps.stamp(itemId);

  if (!url) return { kind: "result", url: null };

  await deps.save(itemId, url);
  return { kind: "result", url };
}

/** Convenience wrapper returning just the resolved URL (or null). */
export async function enrichAppleMusicLink(
  itemId: number,
  deps?: AppleMusicLookupDeps,
): Promise<string | null> {
  const outcome = await lookupAppleMusicForItem(itemId, deps);
  return outcome.kind === "result" ? outcome.url : null;
}

/**
 * Fire-and-forget eager enrichment for a freshly created item. Never throws and
 * never blocks the caller — the iTunes call can take several seconds, so it must
 * not be awaited on the create/ingest request path. No-ops under
 * `OTB_DISABLE_EXTERNAL_LOOKUPS` (tests) and for items that are themselves
 * Apple Music links.
 */
export function enrichAppleMusicLinkInBackground(itemId: number, sourceName?: string | null): void {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return;
  if (sourceName === "apple_music") return;

  void enrichAppleMusicLink(itemId).catch((err) => {
    console.error("[apple-music] eager enrichment failed for item", itemId, err);
  });
}

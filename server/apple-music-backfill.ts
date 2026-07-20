import { eq, and, isNull } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems, musicLinks, sources, artists } from "./db/schema";
import { parseUrl } from "./utils";
import { searchAppleMusic, type ServiceSearchResult } from "./scraper";

export interface ItemInfoForLookup {
  title: string;
  artistName: string | null;
  primarySource: string | null;
  primaryUrl: string | null;
  /** The item's current cover art, if any — a lookup only fills a gap, never overwrites. */
  artworkUrl: string | null;
}

export type FetchItemForLookupFn = (id: number) => Promise<ItemInfoForLookup | null>;
export type GetExistingAppleMusicLinkFn = (itemId: number) => Promise<string | null>;
export type SaveAppleMusicLinkFn = (itemId: number, url: string) => Promise<void>;
export type SaveArtworkFn = (itemId: number, artworkUrl: string) => Promise<void>;
export type SearchAppleMusicFn = (
  title: string,
  artist: string | null,
) => Promise<ServiceSearchResult | null>;

export interface AppleMusicBackfillDeps {
  fetchItem: FetchItemForLookupFn;
  getExistingLink: GetExistingAppleMusicLinkFn;
  saveLink: SaveAppleMusicLinkFn;
  saveArtwork: SaveArtworkFn;
  search: SearchAppleMusicFn;
}

export type BackfillResult =
  // The item id did not resolve to a release.
  | { status: "item_missing" }
  // The primary link is already an Apple Music link — nothing to do.
  | { status: "skipped" }
  // An Apple Music secondary link already exists.
  | { status: "existing"; url: string }
  // A matching Apple Music link was found and saved.
  | { status: "added"; url: string }
  // No confident Apple Music match was found.
  | { status: "not_found" };

export const PLAYABLE_SOURCES = new Set([
  "bandcamp",
  "spotify",
  "soundcloud",
  "youtube",
  "apple_music",
  "tidal",
  "deezer",
  "mixcloud",
]);

async function defaultFetchItemForLookup(id: number): Promise<ItemInfoForLookup | null> {
  const rows = await db
    .select({
      title: musicItems.title,
      artistName: artists.name,
      primarySource: sources.name,
      primaryUrl: musicLinks.url,
      artworkUrl: musicItems.artworkUrl,
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
    artworkUrl: row.artworkUrl ?? null,
  };
}

async function defaultGetExistingAppleMusicLink(itemId: number): Promise<string | null> {
  const rows = await db
    .select({ url: musicLinks.url })
    .from(musicLinks)
    .innerJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(and(eq(musicLinks.musicItemId, itemId), eq(sources.name, "apple_music")))
    .limit(1);

  return rows[0]?.url ?? null;
}

async function defaultSaveAppleMusicLink(itemId: number, url: string): Promise<void> {
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

/**
 * Persist cover art discovered during a lookup, but only when the item still has
 * none — the `IS NULL` guard leaves any artwork the user set (or an earlier
 * lookup found) untouched.
 */
async function defaultSaveAppleMusicArtwork(itemId: number, artworkUrl: string): Promise<void> {
  await db
    .update(musicItems)
    .set({ artworkUrl })
    .where(and(eq(musicItems.id, itemId), isNull(musicItems.artworkUrl)));
}

export const defaultAppleMusicBackfillDeps: AppleMusicBackfillDeps = {
  fetchItem: defaultFetchItemForLookup,
  getExistingLink: defaultGetExistingAppleMusicLink,
  saveLink: defaultSaveAppleMusicLink,
  saveArtwork: defaultSaveAppleMusicArtwork,
  search: searchAppleMusic,
};

function isAppleMusicUrl(url: string | null): boolean {
  if (!url) return false;
  return parseUrl(url).source === "apple_music" || url.includes("music.apple.com");
}

/**
 * Find a good Apple Music match for a release and save it as a secondary link.
 *
 * Idempotent and safe to run in the background: it skips releases whose
 * primary link is already Apple Music, returns any pre-existing Apple Music
 * secondary link untouched, and only saves a link when the iTunes Search API
 * returns a confident title + artist match.
 */
export async function backfillAppleMusicLink(
  itemId: number,
  deps: AppleMusicBackfillDeps = defaultAppleMusicBackfillDeps,
): Promise<BackfillResult> {
  const item = await deps.fetchItem(itemId);
  if (!item) {
    return { status: "item_missing" };
  }

  if (isAppleMusicUrl(item.primaryUrl)) {
    return { status: "skipped" };
  }

  const existing = await deps.getExistingLink(itemId);
  if (existing) {
    return { status: "existing", url: existing };
  }

  const result = await deps.search(item.title, item.artistName);
  if (!result) {
    return { status: "not_found" };
  }

  await deps.saveLink(itemId, result.url);

  // Backfill cover art from the same lookup when the item has none of its own.
  if (result.artworkUrl && !item.artworkUrl) {
    await deps.saveArtwork(itemId, result.artworkUrl);
  }

  return { status: "added", url: result.url };
}

/**
 * Fire-and-forget wrapper around {@link backfillAppleMusicLink} for use right
 * after an item is created. Never throws — failures are logged and swallowed
 * so they can't disrupt the request that scheduled them.
 */
export function scheduleAppleMusicBackfill(
  itemId: number,
  deps: AppleMusicBackfillDeps = defaultAppleMusicBackfillDeps,
): void {
  void backfillAppleMusicLink(itemId, deps).catch((err) => {
    console.error("[apple-music] background backfill failed for item", itemId, err);
  });
}

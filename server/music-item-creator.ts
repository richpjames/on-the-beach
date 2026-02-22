import { eq, and } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems, artists, musicLinks, sources } from "./db/schema";
import { parseUrl, isValidUrl, normalize, capitalize } from "./utils";
import { scrapeUrl } from "./scraper";
import type { CreateMusicItemInput, MusicItemFull } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers (moved from routes/music-items.ts for shared use)
// ---------------------------------------------------------------------------

/**
 * Build the "full" music-item query that joins artists, primary music_link,
 * and sources to produce the MusicItemFull shape the frontend expects.
 */
export function fullItemSelect() {
  return db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      normalized_title: musicItems.normalizedTitle,
      item_type: musicItems.itemType,
      artist_id: musicItems.artistId,
      listen_status: musicItems.listenStatus,
      purchase_intent: musicItems.purchaseIntent,
      price_cents: musicItems.priceCents,
      currency: musicItems.currency,
      notes: musicItems.notes,
      rating: musicItems.rating,
      created_at: musicItems.createdAt,
      updated_at: musicItems.updatedAt,
      listened_at: musicItems.listenedAt,
      artwork_url: musicItems.artworkUrl,
      is_physical: musicItems.isPhysical,
      physical_format: musicItems.physicalFormat,
      artist_name: artists.name,
      primary_url: musicLinks.url,
      primary_source: sources.name,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .leftJoin(
      musicLinks,
      and(eq(musicLinks.musicItemId, musicItems.id), eq(musicLinks.isPrimary, true)),
    )
    .leftJoin(sources, eq(musicLinks.sourceId, sources.id));
}

/** Look up an existing artist by normalized name, or create a new one. */
export async function getOrCreateArtist(name: string): Promise<number> {
  const normalizedName = normalize(name);

  const existing = await db
    .select({ id: artists.id })
    .from(artists)
    .where(eq(artists.normalizedName, normalizedName))
    .limit(1);

  if (existing[0]) {
    return existing[0].id;
  }

  const [created] = await db
    .insert(artists)
    .values({ name: capitalize(name), normalizedName })
    .returning({ id: artists.id });

  return created.id;
}

/** Resolve the DB id for a source name (e.g. "bandcamp"). */
export async function getSourceId(sourceName: string): Promise<number | null> {
  const rows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.name, sourceName))
    .limit(1);

  return rows[0]?.id ?? null;
}

/** Fetch a single full item by its id. */
export async function fetchFullItem(id: number): Promise<MusicItemFull | null> {
  const rows = await fullItemSelect().where(eq(musicItems.id, id));
  if (!rows[0]) return null;
  return { ...(rows[0] as unknown as MusicItemFull), stacks: [] };
}

// ---------------------------------------------------------------------------
// Shared creation logic
// ---------------------------------------------------------------------------

export interface CreateResult {
  item: MusicItemFull;
  created: boolean;
}

/**
 * Create a music item from a URL. Handles URL parsing, OG scraping,
 * artist resolution, and duplicate detection.
 *
 * Returns `{ created: false }` if the URL already exists in music_links.
 */
export async function createMusicItemFromUrl(
  url: string,
  overrides?: Partial<CreateMusicItemInput>,
): Promise<CreateResult> {
  if (!isValidUrl(url)) {
    throw new Error("Invalid URL");
  }

  const parsed = parseUrl(url);

  // Check for duplicate URL
  const existing = await db
    .select({ musicItemId: musicLinks.musicItemId })
    .from(musicLinks)
    .where(eq(musicLinks.url, parsed.normalizedUrl))
    .limit(1);

  if (existing[0]) {
    const item = await fetchFullItem(existing[0].musicItemId);
    if (item) {
      return { item, created: false };
    }
  }

  // Scrape OG metadata
  const scraped = await scrapeUrl(parsed.normalizedUrl, parsed.source);

  // Merge: overrides > scraped > regex-extracted > defaults
  const title = overrides?.title || scraped?.potentialTitle || parsed.potentialTitle || "Untitled";
  const artistName = overrides?.artistName || scraped?.potentialArtist || parsed.potentialArtist;

  // Get or create artist
  let artistId: number | null = null;
  if (artistName) {
    artistId = await getOrCreateArtist(artistName);
  }

  // Resolve source
  const sourceId = await getSourceId(parsed.source);

  // Insert music item
  const [inserted] = await db
    .insert(musicItems)
    .values({
      title: capitalize(title),
      normalizedTitle: normalize(title),
      itemType: overrides?.itemType ?? "album",
      artistId,
      listenStatus: overrides?.listenStatus ?? "to-listen",
      purchaseIntent: overrides?.purchaseIntent ?? "no",
      notes: overrides?.notes ?? null,
      artworkUrl: scraped?.imageUrl ?? null,
    })
    .returning({ id: musicItems.id });

  // Insert primary link
  await db.insert(musicLinks).values({
    musicItemId: inserted.id,
    sourceId,
    url: parsed.normalizedUrl,
    isPrimary: true,
  });

  const item = await fetchFullItem(inserted.id);
  if (!item) {
    throw new Error("Failed to fetch created item");
  }

  return { item, created: true };
}

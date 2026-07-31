import { eq } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems, artists, musicLinks, sources, musicItemStacks, stacks } from "./db/schema";
import { normalize, capitalize } from "./utils";
import { enrichSecondaryLinkInBackground } from "./secondary-link-enrichment";
import { fetchSuggestionInBackground } from "./suggestions";
import { fullItemSelect } from "./queries/full-item-select";
import type { CreateMusicItemInput, MusicItemFull } from "../src/types";

// ---------------------------------------------------------------------------
// Item reads and URL-less writes.
//
// Split out of ./music-item-creator.ts for the same reason
// ./queries/full-item-select.ts was: `ingest.test.ts` calls
// `mock.module(".../music-item-creator")`, and bun's module mocks are
// process-wide, so anything importing the creator after that point gets stubs.
// Callers that need the real implementations — the release-alert accept path,
// for one — import them from here instead. The creator re-exports them so
// existing importers are unaffected.
// ---------------------------------------------------------------------------

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

/** Fetch a single full item by its id, including stacks and all links. */
export async function fetchFullItem(id: number): Promise<MusicItemFull | null> {
  const rows = await fullItemSelect().where(eq(musicItems.id, id));
  if (!rows[0]) return null;

  const [stackRows, linkRows] = await Promise.all([
    db
      .select({ musicItemId: musicItemStacks.musicItemId, id: stacks.id, name: stacks.name })
      .from(musicItemStacks)
      .innerJoin(stacks, eq(stacks.id, musicItemStacks.stackId))
      .where(eq(musicItemStacks.musicItemId, id)),
    db
      .select({
        id: musicLinks.id,
        url: musicLinks.url,
        source_name: sources.name,
        display_name: sources.displayName,
        is_primary: musicLinks.isPrimary,
      })
      .from(musicLinks)
      .leftJoin(sources, eq(musicLinks.sourceId, sources.id))
      .where(eq(musicLinks.musicItemId, id)),
  ]);

  const item = {
    ...(rows[0] as unknown as MusicItemFull),
    stacks: [] as Array<{ id: number; name: string }>,
    links: [] as Array<{
      id: number;
      url: string;
      source_name: string | null;
      display_name: string | null;
      is_primary: boolean;
    }>,
  };
  item.stacks = stackRows.map((r) => ({ id: r.id, name: r.name }));
  item.links = linkRows.map((r) => ({
    id: r.id,
    url: r.url,
    source_name: r.source_name,
    display_name: r.display_name,
    is_primary: r.is_primary,
  }));
  return item;
}

/**
 * Prefetch another release by the same artist so the "you might also like"
 * prompt has one ready when this item is later marked listened. Lives at this
 * level — not in the routes — so every creation path (web form, share
 * extension, email/photo ingest, accepted suggestions, accepted release
 * alerts) triggers it. Non-blocking.
 */
export function queueSuggestionPrefetch(item: MusicItemFull): void {
  if (item.listen_status !== "to-listen" || !item.artist_name) return;

  fetchSuggestionInBackground({
    id: item.id,
    artist_name: item.artist_name,
    year: item.year,
    musicbrainz_artist_id: item.musicbrainz_artist_id,
  });
}

export interface CreateResult {
  item: MusicItemFull;
  created: boolean;
}

/**
 * Create a music item without a URL — no scraping, no link inserted.
 * Used for physical records or items known only from memory.
 */
export async function createMusicItemDirect(
  overrides: Partial<CreateMusicItemInput>,
): Promise<CreateResult> {
  const title = overrides.title || "Untitled";
  const artistName = overrides.artistName;

  let artistId: number | null = null;
  if (artistName) {
    artistId = await getOrCreateArtist(artistName);
  }

  const [inserted] = await db
    .insert(musicItems)
    .values({
      title: capitalize(title),
      normalizedTitle: normalize(title),
      itemType: overrides.itemType ?? "album",
      artistId,
      listenStatus: overrides.listenStatus ?? "to-listen",
      purchaseIntent: overrides.purchaseIntent ?? "no",
      notes: overrides.notes ?? null,
      artworkUrl: overrides.artworkUrl ?? null,
      label: overrides.label ?? null,
      year: overrides.year ?? null,
      country: overrides.country ?? null,
      genre: overrides.genre ?? null,
      catalogueNumber: overrides.catalogueNumber ?? null,
      musicbrainzReleaseId: overrides.musicbrainzReleaseId ?? null,
      musicbrainzArtistId: overrides.musicbrainzArtistId ?? null,
    })
    .returning({ id: musicItems.id });

  const item = await fetchFullItem(inserted.id);
  if (!item) {
    throw new Error("Failed to fetch created item");
  }

  // Direct items (physical / from-memory) have no primary link, so they're
  // always eligible for a secondary-link lookup. Non-blocking.
  enrichSecondaryLinkInBackground(inserted.id);
  queueSuggestionPrefetch(item);

  return { item, created: true };
}

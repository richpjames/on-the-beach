import { and, eq, or } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems, artists, musicLinks, sources, musicItemStacks, stacks } from "./db/schema";
import { normalize, capitalize } from "./utils";
import { enrichSecondaryLinkInBackground } from "./secondary-link-enrichment";
import { fetchSuggestionInBackground } from "./suggestions";
import { fullItemSelect } from "./queries/full-item-select";
import {
  NO_SOURCE_CAPABILITIES,
  type CreateMusicItemInput,
  type DuplicateItemPayload,
  type MusicItemFull,
  type MusicItemLink,
} from "../domain/types";

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

/**
 * Thrown by a warn-mode create when the release matches something already in
 * the list. The route answers it with a `409 duplicate_item` payload so the
 * client can offer "add anyway" — see `DuplicateItemPayload`.
 */
export class DuplicateItemSelectionError extends Error {
  payload: DuplicateItemPayload;

  constructor(payload: DuplicateItemPayload) {
    super(payload.message);
    this.name = "DuplicateItemSelectionError";
    this.payload = payload;
  }
}

/** Enough matches to list in the dialog — beyond this it's noise, not choice. */
export const DUPLICATE_MATCH_LIMIT = 5;

function isBlankOrUntitled(title: string): boolean {
  const normalized = normalize(title);
  return normalized === "" || normalized === normalize("Untitled");
}

/**
 * Library-wide duplicate check — the one the URL-keyed checks can't do. An
 * item matches when it shares the MusicBrainz release id, or when both the
 * normalized title and the artist's normalized name agree. A title without an
 * artist matches nothing: "Greatest Hits" alone is not a duplicate of
 * anything. Returns at most `DUPLICATE_MATCH_LIMIT` full items.
 */
export async function findDuplicateItems(
  artistName: string | undefined,
  title: string,
  musicbrainzReleaseId?: string,
): Promise<MusicItemFull[]> {
  const titleUsable = !isBlankOrUntitled(title);
  if (!titleUsable && !musicbrainzReleaseId) return [];

  const conditions = [];
  if (musicbrainzReleaseId) {
    conditions.push(eq(musicItems.musicbrainzReleaseId, musicbrainzReleaseId));
  }
  if (titleUsable && artistName?.trim()) {
    const [artist] = await db
      .select({ id: artists.id })
      .from(artists)
      .where(eq(artists.normalizedName, normalize(artistName)))
      .limit(1);
    if (artist) {
      conditions.push(
        and(eq(musicItems.normalizedTitle, normalize(title)), eq(musicItems.artistId, artist.id)),
      );
    }
  }
  if (conditions.length === 0) return [];

  const rows = await db
    .select({ id: musicItems.id })
    .from(musicItems)
    .where(or(...conditions))
    .limit(DUPLICATE_MATCH_LIMIT);

  const items = await Promise.all(rows.map((row) => fetchFullItem(row.id)));
  return items.filter((item): item is MusicItemFull => item !== null);
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
        metadata: musicLinks.metadata,
        can_play: sources.canPlay,
        can_buy: sources.canBuy,
        is_editorial: sources.isEditorial,
      })
      .from(musicLinks)
      .leftJoin(sources, eq(musicLinks.sourceId, sources.id))
      .where(eq(musicLinks.musicItemId, id)),
  ]);

  const item = {
    ...(rows[0] as unknown as MusicItemFull),
    stacks: [] as Array<{ id: number; name: string }>,
    links: [] as MusicItemLink[],
  };
  item.stacks = stackRows.map((r) => ({ id: r.id, name: r.name }));
  // The source join is a LEFT one, so a link to somewhere we don't model has no
  // capabilities of its own — it promises nothing rather than defaulting to
  // playable.
  item.links = linkRows.map((r) => ({
    id: r.id,
    url: r.url,
    source_name: r.source_name,
    display_name: r.display_name,
    is_primary: r.is_primary,
    metadata: r.metadata,
    can_play: r.can_play ?? NO_SOURCE_CAPABILITIES.can_play,
    can_buy: r.can_buy ?? NO_SOURCE_CAPABILITIES.can_buy,
    is_editorial: r.is_editorial ?? NO_SOURCE_CAPABILITIES.is_editorial,
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
/** Duplicate-check behaviour shared by every creation path. */
export interface DuplicateCheckOptions {
  /**
   * Reject a would-be duplicate with `DuplicateItemSelectionError` instead of
   * inserting. The web add form sets this; ingest paths add silently.
   */
  warnOnDuplicate?: boolean;
  /** Confirmed "add anyway" — skip the duplicate check and insert. */
  forceDuplicate?: boolean;
}

export interface CreateMusicItemDirectOptions extends DuplicateCheckOptions {
  /**
   * Skip the secondary-link lookup. For a record that isn't released yet there
   * is nothing on the streaming services to find, and the lookup stamps
   * `apple_music_lookup_at` on a miss just as it does on a hit — so a single
   * futile attempt now would keep the item out of the backfill for good, and
   * it would never pick up a link once the record actually came out.
   */
  skipLinkEnrichment?: boolean;
}

export async function createMusicItemDirect(
  overrides: Partial<CreateMusicItemInput>,
  options: CreateMusicItemDirectOptions = {},
): Promise<CreateResult> {
  const title = overrides.title || "Untitled";
  const artistName = overrides.artistName;

  if (options.warnOnDuplicate && !options.forceDuplicate) {
    const duplicates = await findDuplicateItems(artistName, title, overrides.musicbrainzReleaseId);
    if (duplicates.length > 0) {
      throw new DuplicateItemSelectionError({
        kind: "duplicate_item",
        message: "This looks like something already in your list.",
        items: duplicates,
      });
    }
  }

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
  if (!options.skipLinkEnrichment) {
    enrichSecondaryLinkInBackground(inserted.id);
  }
  // The suggestion prefetch runs either way: it's keyed to the artist, not to
  // this release, so it's just as useful for a record that isn't out yet.
  queueSuggestionPrefetch(item);

  return { item, created: true };
}

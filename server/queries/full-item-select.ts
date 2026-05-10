import { eq, and } from "drizzle-orm";
import { db } from "../db/index";
import { musicItems, artists, musicLinks, sources } from "../db/schema";

/**
 * Build the "full" music-item query that joins artists, primary music_link,
 * and sources to produce the MusicItemFull shape the frontend expects.
 *
 * Lives in its own module (rather than `music-item-creator.ts`) so it can be
 * imported from server-side render paths without dragging in the broader
 * creator surface — this also lets unit tests mock the heavyweight creator
 * helpers without breaking SSR tests that need the real query builder.
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
      label: musicItems.label,
      year: musicItems.year,
      country: musicItems.country,
      genre: musicItems.genre,
      catalogue_number: musicItems.catalogueNumber,
      musicbrainz_release_id: musicItems.musicbrainzReleaseId,
      musicbrainz_artist_id: musicItems.musicbrainzArtistId,
      artist_name: artists.name,
      primary_url: musicLinks.url,
      primary_source: sources.name,
      primary_link_metadata: musicLinks.metadata,
      remind_at: musicItems.remindAt,
      reminder_pending: musicItems.reminderPending,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .leftJoin(
      musicLinks,
      and(eq(musicLinks.musicItemId, musicItems.id), eq(musicLinks.isPrimary, true)),
    )
    .leftJoin(sources, eq(musicLinks.sourceId, sources.id));
}

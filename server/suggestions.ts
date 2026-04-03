import { eq } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems, artists, itemSuggestions } from "./db/schema";
import { findSuggestedRelease } from "./musicbrainz";
import { normalize } from "./utils";

interface ItemSummary {
  id: number;
  artist_name: string | null;
  year: number | null;
  musicbrainz_artist_id: string | null;
}

export async function fetchAndStoreSuggestion(item: ItemSummary): Promise<void> {
  if (!item.artist_name) return;

  try {
    const artistRows = await db
      .select({ normalizedTitle: musicItems.normalizedTitle })
      .from(musicItems)
      .innerJoin(artists, eq(musicItems.artistId, artists.id))
      .where(eq(artists.normalizedName, normalize(item.artist_name)));

    const trackedTitles = new Set(artistRows.map((r) => r.normalizedTitle));

    const suggestion = await findSuggestedRelease({
      mbArtistId: item.musicbrainz_artist_id,
      artistName: item.artist_name,
      trackedTitles,
      sourceYear: item.year,
    });

    if (!suggestion) return;

    await db.insert(itemSuggestions).values({
      sourceItemId: item.id,
      title: suggestion.title,
      artistName: item.artist_name,
      itemType: suggestion.itemType,
      year: suggestion.year,
      musicbrainzReleaseId: suggestion.musicbrainzReleaseId,
      status: "pending",
    });
  } catch (err) {
    console.error("[suggestions] Failed to fetch/store suggestion for item", item.id, err);
  }
}

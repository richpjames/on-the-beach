import { parseDiscogsRef, parseMusicBrainzReleaseRef } from "../../../domain/catalogue-ref";
import type { MusicItemFull } from "../../../domain/types";

// ---------------------------------------------------------------------------
// The edit form's catalogue-match fields
//
// Paste a Discogs or MusicBrainz page URL (or just the number) to correct a
// wrong match; empty both to clear it. Only a real change is sent — re-saving
// the form with the same match leaves the stored ids and status untouched.
// ---------------------------------------------------------------------------

export type CatalogueMatchUpdates = Record<string, number | string | null>;

/** The update payload for the match fields, or the message to alert instead. */
export function catalogueMatchUpdates(
  discogsInput: string,
  mbInput: string,
  item: Pick<
    MusicItemFull,
    | "discogs_release_id"
    | "discogs_master_id"
    | "musicbrainz_release_id"
    | "musicbrainz_release_group_id"
  >,
): CatalogueMatchUpdates | { error: string } {
  const discogsRaw = discogsInput.trim();
  const discogs = discogsRaw ? parseDiscogsRef(discogsRaw) : null;
  if (discogsRaw && !discogs) {
    return {
      error:
        "Couldn't read that Discogs reference — paste the release page link or just its number.",
    };
  }

  const mbRaw = mbInput.trim();
  const mbRelease = mbRaw ? parseMusicBrainzReleaseRef(mbRaw) : null;
  if (mbRaw && !mbRelease) {
    return {
      error: "Couldn't read that MusicBrainz reference — paste the release page link or its id.",
    };
  }

  // Emptying both fields clears the whole match, not just the two ids the
  // form shows: a scan-resolved row also carries the Discogs master and the
  // MusicBrainz release-group, and leaving those behind would keep the row
  // "matched" with no visible ids to show for it.
  const clearing = !discogsRaw && !mbRaw;
  const hadMatch = Boolean(
    item.discogs_release_id ||
    item.discogs_master_id ||
    item.musicbrainz_release_id ||
    item.musicbrainz_release_group_id,
  );
  if (clearing && hadMatch) {
    return {
      discogsReleaseId: null,
      discogsMasterId: null,
      musicbrainzReleaseId: null,
      musicbrainzReleaseGroupId: null,
    };
  }

  const updates: CatalogueMatchUpdates = {};
  if (discogs?.releaseId != null && discogs.releaseId !== item.discogs_release_id) {
    updates.discogsReleaseId = discogs.releaseId;
  }
  if (discogs?.masterId != null && discogs.masterId !== item.discogs_master_id) {
    updates.discogsMasterId = discogs.masterId;
  }
  if (mbRelease && mbRelease !== item.musicbrainz_release_id) {
    updates.musicbrainzReleaseId = mbRelease;
  }
  return updates;
}

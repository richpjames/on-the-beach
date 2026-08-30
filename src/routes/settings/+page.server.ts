import type { PageServerLoad } from "./$types";
import {
  getLookupService,
  LOOKUP_SERVICES,
  getReleaseLengthPreference,
  RELEASE_LENGTH_PREFERENCES,
  getArtistWatchSettings,
} from "../../../server/settings";
import { listTrackedArtists } from "../../../server/artist-watch";
import { LOOKUP_SERVICE_CONFIG } from "../../../server/secondary-link-enrichment";
import { isAppleMusicConfigured, getStorefront } from "../../../server/apple-music";

export const load: PageServerLoad = async () => {
  return {
    activeService: await getLookupService(),
    services: LOOKUP_SERVICES.map((service) => ({
      value: service,
      displayName: LOOKUP_SERVICE_CONFIG[service].displayName,
    })),
    releaseLengthPreference: await getReleaseLengthPreference(),
    releaseLengthPreferences: RELEASE_LENGTH_PREFERENCES,
    appleMusicConfigured: isAppleMusicConfigured(),
    appleMusicStorefront: getStorefront(),
    artistWatch: await getArtistWatchSettings(),
    trackedArtists: (await listTrackedArtists()).map((artist) => ({
      id: artist.id,
      name: artist.name,
      musicbrainz_artist_id: artist.musicbrainzArtistId,
      mbid_confidence: artist.mbidConfidence ?? "unresolved",
      follow_state: artist.followState,
      last_polled_at: artist.lastPolledAt?.toISOString() ?? null,
      next_poll_at: artist.nextPollAt?.toISOString() ?? null,
      poll_failure_count: artist.pollFailureCount,
    })),
  };
};

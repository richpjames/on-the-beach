import type { PageServerLoad } from "./$types";
import {
  getLookupService,
  LOOKUP_SERVICES,
  getReleaseLengthPreference,
  RELEASE_LENGTH_PREFERENCES,
} from "../../../server/settings";
import { LOOKUP_SERVICE_CONFIG } from "../../../server/secondary-link-enrichment";
import { isAppleMusicConfigured, getStorefront } from "../../../server/apple-music-token";

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
  };
};

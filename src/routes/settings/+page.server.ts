import type { PageServerLoad } from "./$types";
import { getLookupService, LOOKUP_SERVICES } from "../../../server/settings";
import { LOOKUP_SERVICE_CONFIG } from "../../../server/secondary-link-enrichment";

export const load: PageServerLoad = async () => {
  return {
    activeService: await getLookupService(),
    services: LOOKUP_SERVICES.map((service) => ({
      value: service,
      displayName: LOOKUP_SERVICE_CONFIG[service].displayName,
    })),
  };
};

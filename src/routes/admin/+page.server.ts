import type { PageServerLoad } from "./$types";
import { listLinkSources } from "../../../app/notes-enrichment";

export const load: PageServerLoad = async () => {
  const sources = await listLinkSources();
  return {
    linkSources: sources.map((source) => ({
      host: source.host,
      displayName: source.displayName,
      rank: source.rank,
      firstSeenAt: source.firstSeenAt.toISOString(),
    })),
  };
};

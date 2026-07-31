import type { PageServerLoad } from "./$types";
import { listReleaseAlerts } from "../../../server/release-alerts";

export const load: PageServerLoad = async () => {
  // `seen` alerts stay on the page: marking the view as viewed clears the
  // badge, it doesn't clear the queue — the cards still want a decision.
  const alerts = await listReleaseAlerts(["pending", "seen"]);

  return {
    alerts,
    pendingCount: alerts.filter((alert) => alert.status === "pending").length,
  };
};

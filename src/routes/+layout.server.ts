import type { LayoutServerLoad } from "./$types";
import { getRatingSettings } from "../../app/settings";

/**
 * The star-rating scale is a setting every page that shows ratings needs —
 * the list, the release page, the settings page itself — so it rides the
 * root layout rather than being fetched per page.
 */
export const load: LayoutServerLoad = async () => {
  return {
    rating: await getRatingSettings(),
  };
};

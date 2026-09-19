import type { PageServerLoad } from "./$types";
import { fetchInitialItems, fetchInitialStacks } from "../../app/queries/main-page-data";

export const load: PageServerLoad = async () => {
  const [items, stacks] = await Promise.all([fetchInitialItems(null), fetchInitialStacks()]);

  return {
    items,
    stacks,
    stackId: null,
  };
};

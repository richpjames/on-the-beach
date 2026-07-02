import type { PageServerLoad } from "./$types";
import {
  fetchInitialItems,
  fetchInitialStacks,
} from "../../../../../server/queries/main-page-data";

export const load: PageServerLoad = async ({ params }) => {
  const stackId = Number(params.id);
  const validStackId = Number.isInteger(stackId) && stackId > 0 ? stackId : null;

  const [items, stacks] = await Promise.all([
    fetchInitialItems(validStackId),
    fetchInitialStacks(),
  ]);

  return {
    items,
    stacks,
    stackId: validStackId,
  };
};

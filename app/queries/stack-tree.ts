/**
 * The stack tree: a stack can contain child stacks, and a list filtered to a
 * stack means the whole subtree, not just the stack's own direct members.
 *
 * The parent/child links live in the `stack_parents` table; the whole (small)
 * table is read at once and walked in memory — releases belong to a handful of
 * stacks, and a recursive SQL walk costs more than it saves.
 */
import { db } from "../../adapters/db/index";
import { stackParents } from "../../adapters/db/schema";

/** A stack id and the ids of every stack nested under it, itself included. */
export async function collectDescendantStackIds(rootStackId: number): Promise<number[]> {
  const links = await db
    .select({
      parentStackId: stackParents.parentStackId,
      childStackId: stackParents.childStackId,
    })
    .from(stackParents);

  const childrenByParent = new Map<number, number[]>();
  for (const link of links) {
    const children = childrenByParent.get(link.parentStackId) ?? [];
    children.push(link.childStackId);
    childrenByParent.set(link.parentStackId, children);
  }

  const descendants = new Set<number>([rootStackId]);
  const queue = [rootStackId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }

    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      if (descendants.has(child)) {
        continue;
      }

      descendants.add(child);
      queue.push(child);
    }
  }

  return [...descendants];
}

export type ItemWithStacks<T> = T & { stacks: Array<{ id: number; name: string }> };

/**
 * Merge a flat list of stack-membership rows into an array of items,
 * adding a `stacks` field to each. Items with no memberships get `stacks: []`.
 */
export function hydrateItemStacks<T extends { id: number }>(
  items: T[],
  stackRows: Array<{ musicItemId: number; id: number; name: string }>,
): ItemWithStacks<T>[] {
  const byItem = new Map<number, Array<{ id: number; name: string }>>();
  for (const row of stackRows) {
    if (!byItem.has(row.musicItemId)) byItem.set(row.musicItemId, []);
    byItem.get(row.musicItemId)!.push({ id: row.id, name: row.name });
  }
  return items.map((item) => ({ ...item, stacks: byItem.get(item.id) ?? [] }));
}

export function buildContextKey(filter: string | undefined, stackId: number | null): string {
  const normalizedFilter = filter || "all";

  if (normalizedFilter === "all" && stackId === null) {
    return "all";
  }

  if (normalizedFilter === "all") {
    return `stack:${stackId}`;
  }

  if (stackId === null) {
    return `filter:${normalizedFilter}`;
  }

  return `filter:${normalizedFilter}:stack:${stackId}`;
}

export function applyOrder<T extends { id: number }>(items: T[], orderedIds: number[]): T[] {
  if (orderedIds.length === 0) {
    return items;
  }

  const uniqueOrderedIds = [...new Set(orderedIds)];
  const orderedSet = new Set(uniqueOrderedIds);
  const unordered = items.filter((item) => !orderedSet.has(item.id));
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const ordered = uniqueOrderedIds
    .map((id) => itemMap.get(id))
    .filter((item): item is T => item !== undefined);

  return [...unordered, ...ordered];
}

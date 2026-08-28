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

/** Entry in a mixed ordering list: "i:123" for items, "s:45" for stacks */
export type OrderEntry = string;

export function parseOrderEntry(entry: OrderEntry): { type: "item" | "stack"; id: number } | null {
  const match = entry.match(/^(i|s):(\d+)$/);
  if (!match) return null;
  return { type: match[1] === "i" ? "item" : "stack", id: Number(match[2]) };
}

export function itemOrderEntry(id: number): OrderEntry {
  return `i:${id}`;
}

export function stackOrderEntry(id: number): OrderEntry {
  return `s:${id}`;
}

export function applyMixedOrder<TItem extends { id: number }, TStack extends { id: number }>(
  items: TItem[],
  childStacks: TStack[],
  orderedEntries: OrderEntry[],
): Array<{ type: "item"; data: TItem } | { type: "stack"; data: TStack }> {
  if (orderedEntries.length === 0) {
    return [
      ...childStacks.map((s) => ({ type: "stack" as const, data: s })),
      ...items.map((i) => ({ type: "item" as const, data: i })),
    ];
  }

  const itemMap = new Map(items.map((i) => [i.id, i]));
  const stackMap = new Map(childStacks.map((s) => [s.id, s]));
  const placedItemIds = new Set<number>();
  const placedStackIds = new Set<number>();

  const ordered: Array<{ type: "item"; data: TItem } | { type: "stack"; data: TStack }> = [];

  for (const entry of orderedEntries) {
    const parsed = parseOrderEntry(entry);
    if (!parsed) continue;

    if (parsed.type === "item") {
      const item = itemMap.get(parsed.id);
      if (item && !placedItemIds.has(parsed.id)) {
        ordered.push({ type: "item", data: item });
        placedItemIds.add(parsed.id);
      }
    } else {
      const stack = stackMap.get(parsed.id);
      if (stack && !placedStackIds.has(parsed.id)) {
        ordered.push({ type: "stack", data: stack });
        placedStackIds.add(parsed.id);
      }
    }
  }

  for (const stack of childStacks) {
    if (!placedStackIds.has(stack.id)) {
      ordered.push({ type: "stack", data: stack });
    }
  }
  for (const item of items) {
    if (!placedItemIds.has(item.id)) {
      ordered.push({ type: "item", data: item });
    }
  }

  return ordered;
}

import type { ListenStatus, MusicItemFilters } from "../../types";
import { STATUS_LABELS } from "./status";

export type FilterSelection = ListenStatus | "all";

export function buildMusicItemFilters(
  currentFilter: FilterSelection,
  currentStack: number | null,
): MusicItemFilters | undefined {
  const filters: MusicItemFilters = {};

  if (currentFilter !== "all") {
    filters.listenStatus = currentFilter;
  }

  if (currentStack !== null) {
    filters.stackId = currentStack;
  }

  return Object.keys(filters).length > 0 ? filters : undefined;
}

export function buildContextKey(
  currentFilter: FilterSelection,
  currentStack: number | null,
): string {
  if (currentFilter === "all" && currentStack === null) return "all";
  if (currentFilter === "all") return `stack:${currentStack}`;
  if (currentStack === null) return `filter:${currentFilter}`;
  return `filter:${currentFilter}:stack:${currentStack}`;
}

export function applyOrder<T extends { id: number }>(items: T[], orderedIds: number[]): T[] {
  if (orderedIds.length === 0) return items;
  const indexMap = new Map(orderedIds.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ai = indexMap.get(a.id) ?? Infinity;
    const bi = indexMap.get(b.id) ?? Infinity;
    return ai - bi;
  });
}

export function getEmptyStateMessage(currentFilter: FilterSelection): string {
  if (currentFilter === "all") {
    return "No music tracked yet. Paste a link above to get started!";
  }

  const labels = STATUS_LABELS as Partial<Record<ListenStatus, string>>;
  const label = labels[currentFilter] ?? currentFilter;
  return `No items with status "${label}"`;
}

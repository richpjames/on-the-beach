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

export function getEmptyStateMessage(currentFilter: FilterSelection): string {
  if (currentFilter === "all") {
    return "No music tracked yet. Paste a link above to get started!";
  }

  const labels = STATUS_LABELS as Partial<Record<ListenStatus, string>>;
  const label = labels[currentFilter] ?? currentFilter;
  return `No items with status "${label}"`;
}

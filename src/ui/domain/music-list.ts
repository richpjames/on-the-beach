import type {
  ListenStatus,
  MusicItemFilters,
  MusicItemSort,
  MusicItemSortDirection,
} from "../../types";
import { applyOrder, buildContextKey } from "../../../shared/music-list-context";
import { STATUS_LABELS } from "./status";

export type FilterSelection = ListenStatus | "all" | "scheduled";

export function buildMusicItemFilters(
  currentFilter: FilterSelection,
  currentStack: number | null,
  searchQuery = "",
  currentSort: MusicItemSort = "default",
  currentSortDirection: MusicItemSortDirection = "desc",
): MusicItemFilters | undefined {
  const filters: MusicItemFilters = {};
  const trimmedSearch = searchQuery.trim();

  if (currentFilter === "scheduled") {
    filters.hasReminder = true;
  } else if (currentFilter !== "all") {
    filters.listenStatus = currentFilter;
  }

  if (currentStack !== null) {
    filters.stackId = currentStack;
  }

  if (trimmedSearch) {
    filters.search = trimmedSearch;
  }

  filters.sort = currentSort;
  filters.sortDirection = currentSortDirection;

  return Object.keys(filters).length > 0 ? filters : undefined;
}

export { applyOrder, buildContextKey };

export function getEmptyStateMessage(currentFilter: FilterSelection, searchQuery = ""): string {
  const trimmedSearch = searchQuery.trim();
  if (trimmedSearch) {
    return `No matches for "${trimmedSearch}"`;
  }

  if (currentFilter === "all") {
    return "No music tracked yet. Paste a link above to get started!";
  }

  if (currentFilter === "scheduled") {
    return "No scheduled items.";
  }

  const labels = STATUS_LABELS as Partial<Record<ListenStatus, string>>;
  const label = labels[currentFilter] ?? currentFilter;
  return `No items with status "${label}"`;
}

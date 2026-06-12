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
  currentSort: MusicItemSort = "date-added",
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
    return "No music tracked yet.";
  }

  if (currentFilter === "scheduled") {
    return "No reminders scheduled.";
  }

  if (currentFilter === "to-listen") {
    return "Nothing in the queue \u2014 all caught up.";
  }

  if (currentFilter === "listened") {
    return "Nothing logged as listened yet.";
  }

  const labels = STATUS_LABELS as Partial<Record<ListenStatus, string>>;
  const label = labels[currentFilter] ?? currentFilter;
  return `No items with status "${label}"`;
}

/** Actionable second line for the empty state; null when there's nothing useful to add. */
export function getEmptyStateHint(currentFilter: FilterSelection, searchQuery = ""): string | null {
  if (searchQuery.trim()) {
    return "Try fewer words, or switch filters.";
  }

  switch (currentFilter) {
    case "all":
      return "Paste a link above, or hit Start \u2192 Add a release.";
    case "to-listen":
      return "Paste a link above to queue something new.";
    case "listened":
      return "Mark releases listened from the status dropdown.";
    case "scheduled":
      return "Set a reminder from any release page.";
    default:
      return null;
  }
}

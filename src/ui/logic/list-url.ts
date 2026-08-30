import type { MusicItemSort, MusicItemSortDirection } from "../../../domain/types";
import type { FilterSelection } from "../../../domain/types";

/**
 * How a list page (`/` or `/s/:id/:name`) is being browsed.
 *
 * This lives in the query string rather than only in the app machine so that
 * leaving the list — most often to a release page — and coming back restores
 * the same view, and so a list URL can be reloaded or shared as-is.
 */
export interface ListViewState {
  filter: FilterSelection;
  search: string;
  sort: MusicItemSort;
  sortDirection: MusicItemSortDirection;
}

const FILTERS: readonly FilterSelection[] = ["all", "to-listen", "listened", "scheduled"];

const SORTS: readonly MusicItemSort[] = [
  "date-added",
  "date-listened",
  "artist-name",
  "release-name",
  "star-rating",
];

/** What a list page shows before the user touches any browse control. */
export function defaultListViewState(stackId: number | null): ListViewState {
  return {
    // Stack pages show everything in the stack; the home list is the queue.
    filter: stackId === null ? "to-listen" : "all",
    search: "",
    sort: "date-added",
    sortDirection: "desc",
  };
}

/** True when the state matches what the server renders without any query params. */
export function isDefaultListViewState(state: ListViewState, stackId: number | null): boolean {
  const defaults = defaultListViewState(stackId);
  return (
    state.filter === defaults.filter &&
    state.search.trim() === "" &&
    state.sort === defaults.sort &&
    state.sortDirection === defaults.sortDirection
  );
}

/** Read browsing state out of a list URL, falling back to defaults for junk. */
export function parseListViewState(params: URLSearchParams, stackId: number | null): ListViewState {
  const defaults = defaultListViewState(stackId);
  const filter = params.get("filter");
  const sort = params.get("sort");
  const direction = params.get("dir");

  return {
    filter: FILTERS.includes(filter as FilterSelection)
      ? (filter as FilterSelection)
      : defaults.filter,
    search: params.get("q") ?? "",
    sort: SORTS.includes(sort as MusicItemSort) ? (sort as MusicItemSort) : defaults.sort,
    sortDirection: direction === "asc" || direction === "desc" ? direction : defaults.sortDirection,
  };
}

/** Serialise browsing state, omitting anything still at its default. */
export function buildListSearch(state: ListViewState, stackId: number | null): string {
  const defaults = defaultListViewState(stackId);
  const params = new URLSearchParams();

  if (state.filter !== defaults.filter) params.set("filter", state.filter);
  const search = state.search.trim();
  if (search) params.set("q", search);
  if (state.sort !== defaults.sort) params.set("sort", state.sort);
  if (state.sortDirection !== defaults.sortDirection) params.set("dir", state.sortDirection);

  const query = params.toString();
  return query ? `?${query}` : "";
}

export function slugifyStackName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildStackPath(stackId: number, name: string): string {
  return `/s/${stackId}/${slugifyStackName(name)}`;
}

/** The stack a list pathname is scoped to, or null for the home list. */
export function stackIdFromListPath(pathname: string): number | null {
  const match = pathname.match(/^\/s\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

export function buildListHref(path: string, state: ListViewState, stackId: number | null): string {
  return `${path}${buildListSearch(state, stackId)}`;
}

/**
 * Validate a `?from=` value into a list href we're willing to link back to.
 *
 * Only same-origin list routes survive, and the query string is rebuilt from
 * the recognised params — so a hand-edited link can't turn the release page's
 * back button into an off-site redirect or smuggle unknown params along.
 */
export function sanitizeListHref(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Reject anything that isn't a plain absolute path — in particular the
  // protocol-relative forms (`//evil.test`, `/\evil.test`) browsers follow.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;

  let url: URL;
  try {
    url = new URL(raw, "http://list.invalid");
  } catch {
    return null;
  }

  const stackMatch = url.pathname.match(/^\/s\/(\d+)\/[a-z0-9-]*$/);
  if (url.pathname !== "/" && !stackMatch) return null;

  const stackId = stackMatch ? Number(stackMatch[1]) : null;
  return buildListHref(url.pathname, parseListViewState(url.searchParams, stackId), stackId);
}

/**
 * Link to a release, remembering the list it was opened from so the release
 * page's back button returns to that exact view.
 */
export function buildReleaseHref(itemId: number, backHref: string | null): string {
  const base = `/r/${itemId}`;
  const sanitized = sanitizeListHref(backHref);
  // "/" is the fallback the release page already uses — no need to spell it out.
  if (!sanitized || sanitized === "/") return base;
  return `${base}?from=${encodeURIComponent(sanitized)}`;
}

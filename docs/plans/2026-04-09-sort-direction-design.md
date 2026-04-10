# Sort Direction Design

**Date:** 2026-04-09

## Goal

Add explicit "Date added" and "Date listened" sort options with a reversible sort direction toggle. All existing sorts (artist name, release name, star rating) also become reversible.

## Decisions

- `"default"` sort is replaced by `"date-added"`, which is the default selection
- `"date-listened"` is only available when the Listened filter is active
- A single direction toggle applies to whichever sort is active
- Nulls always sort last regardless of direction

## Types (`src/types/index.ts`)

```ts
type MusicItemSort =
  | "date-added"
  | "date-listened"
  | "artist-name"
  | "release-name"
  | "star-rating";

type MusicItemSortDirection = "asc" | "desc";
```

`MusicItemFilters` gains `sortDirection?: MusicItemSortDirection`.

## State machine (`src/ui/state/app-machine.ts`)

- `currentSort: MusicItemSort` — default `"date-added"`
- `currentSortDirection: MusicItemSortDirection` — default `"desc"`
- New event `SORT_DIRECTION_UPDATED` increments `listVersion`
- `isBrowseOrderLocked()` check becomes `currentSort !== "date-added"`

## Server (`server/routes/music-items.ts`)

New `sortDirection` query param (`"asc" | "desc"`, default `"desc"`).

Each sort branch applies direction dynamically. Null-pushdown `CASE WHEN ... IS NULL` clauses always push nulls last regardless of direction.

```ts
// date-added
query = query.orderBy(
  direction === "asc" ? asc(musicItems.createdAt) : desc(musicItems.createdAt),
  direction === "asc" ? asc(musicItems.id) : desc(musicItems.id),
);

// date-listened
query = query.orderBy(
  direction === "asc" ? asc(musicItems.listenedAt) : desc(musicItems.listenedAt),
  direction === "asc" ? asc(musicItems.id) : desc(musicItems.id),
);

// artist-name
query = query.orderBy(
  sql`CASE WHEN ${artists.normalizedName} IS NULL OR ${artists.normalizedName} = '' THEN 1 ELSE 0 END`,
  direction === "asc" ? asc(artists.normalizedName) : desc(artists.normalizedName),
  direction === "asc" ? asc(musicItems.normalizedTitle) : desc(musicItems.normalizedTitle),
  desc(musicItems.id),
);
```

## API client (`src/services/api-client.ts`)

Sends `sortDirection` as a query param alongside `sort`.

## UI (`server/routes/main-page.ts`, `src/app.ts`)

- Sort `<select>`: remove `"default"`, add `"date-added"` as first/selected option
- Add `"date-listened"` option — hidden unless active filter is `"listened"`
- Direction toggle button alongside the select:
  - Date sorts: `↓ Newest first` / `↑ Oldest first`
  - Name/rating sorts: `↓ Z–A` / `↑ A–Z` and `↓ Lowest` / `↑ Highest`
- Button label updates when sort or direction changes

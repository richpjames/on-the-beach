# Data Schema

## Core tables

- `artists` stores canonical artist names plus a normalized name used for matching.
- `music_items` stores release-level metadata, listening state, rating, notes, artwork, and physical-media fields.
- `music_links` stores one or more source URLs per item and marks a primary link.
- `sources` stores known platforms such as Bandcamp, Spotify, Apple Music, and physical media.

## Organization tables

- `stacks` stores user-defined collections.
- `music_item_stacks` is the many-to-many join table between items and stacks.
- `stack_parents` creates a single-parent stack tree and is validated to avoid cycles.
- `music_item_order` stores per-context drag order as a JSON array of item IDs.

## Modeling notes

- Titles and artist names are normalized for searching and deduping.
- Link metadata is stored as JSON text when a source needs extra embed fields.
- Ordering is persisted by browse context, not globally, via keys from `shared/music-list-context.ts`.

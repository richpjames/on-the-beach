# Star Rating Feature Design

**Date:** 2026-02-25

## Summary

Allow users to rate a release from 1–5 stars (or leave it unrated). Rating is only shown and editable on cards with listen status `listened` or `to-revisit`.

## Data Layer

No changes needed. `rating INTEGER` already exists in `musicItems` schema. `rating: number | null` already present in `MusicItemFull` and `UpdateMusicItemInput`. The existing `PATCH /api/music-items/:id` endpoint already accepts and persists `rating`.

## UI — Card Template

In `renderMusicCard` (`src/app.ts`), conditionally render a `.star-rating` block when `item.listen_status` is `"listened"` or `"to-revisit"`.

```html
<fieldset class="star-rating" data-item-id="{id}">
  <legend class="visually-hidden">Rating</legend>
  <!-- inputs ordered 5→1 for CSS sibling trick -->
  <input type="radio" id="star-{id}-5" name="rating-{id}" value="5" {checked5}>
  <label for="star-{id}-5" title="5 stars">★</label>
  <input type="radio" id="star-{id}-4" name="rating-{id}" value="4" {checked4}>
  <label for="star-{id}-4" title="4 stars">★</label>
  ...
</fieldset>
```

Stars are ordered 5→1 in the DOM (right-to-left rendering trick) and displayed `flex-direction: row-reverse` so they appear left-to-right visually.

## CSS

- Stars rendered right-to-left in DOM, reversed visually via `flex-direction: row-reverse`
- `:checked ~ label` and `label:hover ~ label` drive fill state — no JS for hover
- Checked/hovered stars filled with a gold/yellow colour
- Radio inputs visually hidden; labels are the interactive target

## JS Event Handling

Two delegated listeners on the music list container:

1. **`change` on `.star-rating input[type="radio"]`** — reads item id from card's `data-item-id`, calls `api.updateMusicItem(id, { rating: Number(value) })`, re-renders the card.

2. **`mousedown` on `.star-rating input[type="radio"]`** — detects if the clicked radio is already checked (clear gesture). If so, marks a flag; on the subsequent `change` (or click), calls `api.updateMusicItem(id, { rating: null })` and re-renders.

## Status Change Interaction

When status changes away from `listened`/`to-revisit`, the rating widget disappears from the re-rendered card. The rating value is preserved in the DB — if status is switched back, the saved rating reappears.

## Accessibility

- `<fieldset>` + `<legend>` group for screen readers
- Each `<label>` has a `title` attribute describing the star value
- Visually-hidden legend via `.visually-hidden` utility class

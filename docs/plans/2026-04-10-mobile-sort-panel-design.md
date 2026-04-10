# Mobile Sort Panel Design

**Date:** 2026-04-10

## Problem

On mobile the sort panel opens as a floating overlay from the sort icon button. The direction button stacks awkwardly below the select with no styling. Separately, there is a visual gap below the filter buttons caused by the icon buttons being stacked vertically (~63px tall vs ~34px for the filter bar).

## Design

CSS-only fix. No HTML changes.

### Fix the gap

Change `.browse-tools__mobile-actions` from `flex-direction: column` to `flex-direction: row`. The two icon buttons (search, sort) sit side-by-side, matching the filter bar height. Gap disappears by default.

### Reposition the sort panel

Make `.browse-controls` the positioning context (`position: relative`). The sort panel uses `position: absolute; top: 100%; left: 0; right: 0` — anchored to the bottom of the browse-controls row, full width.

Change `.browse-tools__panel--sort.is-open` from `display: block` to `display: flex` so the select and direction button sit side-by-side on one line.

## Result

```
[FILTER: All | To Listen | Listened | Scheduled] [🔍][↕]   ← single tight row, no gap
[Sort ──────────────────────────── ↓ Newest first]          ← appears on tap, full width
```

The search panel is unchanged (narrower overlay from the right).

## CSS Changes (mobile breakpoint only)

```css
.browse-controls {
  position: relative;
}

.browse-tools__mobile-actions {
  flex-direction: row;       /* was column */
  align-items: center;       /* was stretch */
}

.browse-tools__panel--sort {
  top: 100%;                 /* anchor below browse-controls row */
  left: 0;
  right: 0;
  width: auto;
  min-width: 0;
}

.browse-tools__panel--sort.is-open {
  display: flex;             /* was block — allows select + button side-by-side */
  align-items: center;
  gap: 6px;
}
```

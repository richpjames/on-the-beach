# Release Permalink Design

**Date:** 2026-02-27
**Feature:** `/r/:id` — individual release detail pages

## Overview

Each music item gets a permanent URL at `/r/<id>` (e.g. `/r/42`). The page is server-rendered HTML by Hono, showing all known details about the release with actions to edit, delete, and update listen status.

## URL Pattern

```
/r/:id     e.g. /r/42
```

## Access

Private — same as the rest of the app (no separate auth layer added).

## Architecture

Server-side rendering via Hono. No client-side router.

```
Browser GET /r/42
  → Hono route /r/:id
  → fetchFullItem(42)  [reuses existing function from music-item-creator.ts]
  → render full HTML page with item data baked in
  → return 200 HTML

Actions (delete, edit, status) → inline JS → existing /api/music-items/:id endpoints
```

## Files Changed

### New
- `server/routes/release-page.ts` — Hono route handler + HTML template function

### Modified
- `server/index.ts`
  - Register `app.route("/r", releasePageRoutes)` before static-file middleware
  - In dev mode: add `/r/` prefix to the routing condition (currently only `/api/` and `/uploads/` go to Hono; Vite handles everything else)
- `src/ui/view/templates.ts` — add permalink icon/link to each music card pointing to `/r/:id`

## CSS Resolution

The production build outputs CSS with a content hash (e.g. `/assets/index-BGNEuTcA.css`). To link to it from a server-rendered page:

- **Dev:** link to `/src/styles/main.css` (Vite serves it)
- **Production:** read `dist/index.html` at startup, extract the `<link rel="stylesheet" href="...">` href, cache and reuse it

## Page Layout

### View Mode (default)

```
┌──────────────────────────────────┐
│  On The Beach   Music Tracking   │  ← same header shell
├──────────────────────────────────┤
│  ← back to list          [Edit]  │
│                                  │
│  [artwork image, large]          │
│                                  │
│  Title                           │
│  Artist                          │
│  Year · Label · Country · Genre  │
│  Catalogue #                     │
│  Notes                           │
│                                  │
│  Status: [select dropdown]       │  ← always interactive
│  Stacks: [chip1] [chip2]         │
│  Rating: ★★★☆☆                   │
│                                  │
│                        [Delete]  │
└──────────────────────────────────┘
```

### Edit Mode (after clicking Edit)

```
├──────────────────────────────────┤
│  ← back to list                  │
│                                  │
│  [artwork image]                 │
│                                  │
│  [Title input              ]     │
│  [Artist input             ]     │
│  [Year] · [Label] · [Country]    │
│  [Genre]                         │
│  [Catalogue #              ]     │
│  [Notes textarea           ]     │
│                                  │
│  Status: [select dropdown]       │
│                                  │
│       [Save changes]  [Cancel]   │
└──────────────────────────────────┘
```

## Actions

| Action | Trigger | Implementation |
|--------|---------|----------------|
| Back | `← back to list` link | `href="/"` |
| Edit | Edit button | JS toggles view ↔ edit mode (no reload) |
| Save | Save button in edit mode | `PATCH /api/music-items/:id` → reload page |
| Cancel | Cancel button in edit mode | JS toggles back to view mode |
| Status | Status `<select>` onChange | `PATCH /api/music-items/:id` (immediate, no reload) |
| Delete | Delete button | confirm dialog → `DELETE /api/music-items/:id` → redirect `/` |

## Card Link (List View)

Add a permalink icon button to each music card's action bar in the list view:

```html
<a href="/r/:id" class="btn btn--ghost" title="Open release page">
  <!-- link icon SVG -->
</a>
```

## Error States

- Item not found → 404 page with message and back link
- Invalid ID → 400 response

## Inline JS

The server-rendered page includes a `<script>` block at the bottom handling:
- Edit/Cancel toggle (show/hide view vs edit elements)
- Save: builds patch body from form fields, calls `PATCH`, reloads on success
- Delete: confirm dialog, calls `DELETE`, redirects on success
- Status select: calls `PATCH` on change

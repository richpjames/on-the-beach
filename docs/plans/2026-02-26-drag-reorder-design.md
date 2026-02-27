# Drag-to-Reorder Music List

## Goal

Users can drag music cards to reorder them. The order is saved per "list context" (filter + stack combination) and persists across sessions.

## Data Model

New table `music_item_order`:

```sql
CREATE TABLE music_item_order (
  context_key TEXT PRIMARY KEY,
  item_ids     TEXT NOT NULL     -- JSON array of item IDs in order
)
```

### Context Key

Derived from the current view state:

| Filter        | Stack  | Context key                       |
|---------------|--------|-----------------------------------|
| `all`         | none   | `"all"`                           |
| `to-listen`   | none   | `"filter:to-listen"`              |
| `all`         | ID 5   | `"stack:5"`                       |
| `to-listen`   | ID 5   | `"filter:to-listen:stack:5"`      |

The same derivation logic is used on both client and server.

## Backend Changes

### 1. Drizzle schema (`server/db/schema.ts`)

Add:

```ts
export const musicItemOrder = sqliteTable("music_item_order", {
  contextKey: text("context_key").primaryKey(),
  itemIds: text("item_ids").notNull(),  // JSON array
});
```

### 2. Migration

Generate via `bun run db:generate` and apply with `bun run db:migrate`.

### 3. Modified `GET /api/music-items`

After fetching items, derive the context key from the query params, load the saved order, and sort items by it. Items not in the saved order (e.g. newly added) fall to the end.

### 4. New `PUT /api/music-items/order`

```
PUT /api/music-items/order
Body: { contextKey: string, itemIds: number[] }
```

Upserts the order record. Returns 200 on success.

## Frontend Changes

### 1. Context key helper (`src/ui/domain/music-list.ts`)

Add `buildContextKey(filter, stackId)` mirroring the server derivation.

### 2. API client (`src/services/api-client.ts`)

Add `saveOrder(contextKey: string, itemIds: number[]): Promise<void>`.

### 3. Templates (`src/ui/view/templates.ts`)

- Add `draggable="true"` to each `<article class="music-card">`
- Add a drag handle icon (⠿) to `music-card__actions`

### 4. Drag-and-drop in `App` (`src/app.ts`)

Set up three event listeners on `#music-list` (event delegation):

- `dragstart` — record the dragged item's ID; add `is-dragging` class
- `dragover` — compute drop position from mouse Y; show visual indicator
- `drop` — reorder DOM nodes; call `api.saveOrder(contextKey, newOrderedIds)`
- `dragend` — clean up classes and indicator

### 5. CSS

```css
.music-card[draggable="true"] { cursor: grab; }
.music-card.is-dragging { opacity: 0.4; }
.music-card.drop-target-above { border-top: 2px solid var(--accent); }
.music-card.drop-target-below { border-bottom: 2px solid var(--accent); }
```

## Sequence

1. Add `musicItemOrder` to Drizzle schema
2. Generate and run migration
3. Add `buildContextKey` to `music-list.ts`
4. Add `PUT /api/music-items/order` route
5. Modify `GET /api/music-items` to apply saved order
6. Add `saveOrder` to `ApiClient`
7. Add `draggable` + handle to card template
8. Implement drag-and-drop in `App.setupEventDelegation`
9. Add CSS

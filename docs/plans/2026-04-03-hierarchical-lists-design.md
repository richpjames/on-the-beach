# Hierarchical Lists (DAG) Redesign

## Problem

The current "Parent list..." dropdown at the bottom of list views is a poor UX for managing list hierarchy. Lists need to support nesting to any depth (e.g. Cucharacha → Salsa → Latin), with multiple parents allowed, and child lists should appear inline within their parent list view.

## Data Model

### Remove unique constraint on `childStackId`

Drop the unique constraint on `childStackId` in the `stackParents` table. This allows a list to have multiple parents, turning the hierarchy from a tree into a DAG (directed acyclic graph). The composite primary key `(parentStackId, childStackId)` remains, preventing duplicate relationships.

### Update `Stack` type

Replace `parent_stack_id: number | null` with `parent_stack_ids: number[]` on `Stack` and `StackWithCount`. The `GET /api/stacks/` endpoint returns an array of parent IDs.

### Update cycle detection

`wouldCreateCycle()` in `server/routes/stacks.ts` currently walks a single-parent map. It needs to become a BFS/DFS that traverses all ancestor paths, since a stack can now have multiple parents. If any path from the proposed parent reaches the child, the relationship is rejected.

### Extend ordering format

The `music_item_order.itemIds` JSON array currently stores plain item IDs: `[1, 5, 3]`. Extend to typed entries: `["i:1", "s:5", "i:3", "s:12"]` where `i:` = music item and `s:` = stack (child list). Update `applyOrder()` in `shared/music-list-context.ts` to handle the mixed array.

## New API Endpoint

### `GET /api/stacks/:id/children`

Returns `Array<{ id: number, name: string, item_count: number }>` — the direct children of the given stack. Used to render folder rows in the list view.

## UI Changes

### Inline folder rows

When viewing a list, child lists appear as folder rows interspersed with music items, positioned wherever the user places them in the order. Each folder row shows:

- A folder icon or visual indicator
- The list name
- Direct item count, e.g. `Salsa (5 items)`
- Clicking navigates into that child list (dispatches `STACK_SELECTED`)

Only direct items of the current list are shown — no aggregation of descendant items.

### Breadcrumb navigation

A clickable breadcrumb trail at the top of the list view shows the navigation path, e.g. `Latin > Salsa > Cucharacha`. Each segment is clickable to navigate back up.

### "Add list" button

When viewing a list, an "Add list" button opens a picker showing all available lists, filtered to exclude:

- The current list
- Any list whose addition would create a cycle

Selecting a list adds it as a child. The new folder row is appended to the end of the ordering array and can be repositioned via drag and drop.

### Drag and drop (Phase 2)

In the stack management panel, drag one list onto another to nest it. Same cycle detection applies. This is a power-user shortcut — the "Add list" button is the MVP interaction.

### Removing a child list

A remove action on the folder row deletes the `stackParents` relationship. The child list itself is not deleted — it just becomes unparented from that specific list.

### Remove parent list dropdown

Delete the `#stack-parent-linker` UI entirely:

- `renderStackParentLinker()` and `setupStackParentLinker()` in `app.ts`
- The HTML select + button
- CSS for `.music-list__parent-linker`

The "nested" badge in the stack management panel stays, updated to reflect multiple parents.

## Implementation Order

1. DB migration: drop unique constraint on `childStackId`
2. Update types: `parent_stack_id` → `parent_stack_ids`
3. Update cycle detection: single-parent walk → multi-parent BFS
4. New endpoint: `GET /api/stacks/:id/children`
5. Extend ordering: typed entries format, update `applyOrder()`
6. New UI: folder row component, "Add list" button + picker, breadcrumb trail
7. Remove: parent list dropdown (render, setup, HTML, CSS)
8. Phase 2: drag-and-drop nesting in management panel

# Stacks Feature Design

## Summary

User-created stacks (e.g. "Salsa", "Rap", "Chill") for organizing music links. Stacks work like tags — a link can belong to multiple stacks. Each stack has its own view/tab.

## Data Model

Two new tables:

```sql
CREATE TABLE IF NOT EXISTS stacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS music_item_stacks (
    music_item_id INTEGER NOT NULL REFERENCES music_items(id) ON DELETE CASCADE,
    stack_id INTEGER NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (music_item_id, stack_id)
);
```

Many-to-many junction table. Cascade deletes in both directions. Existing `v_music_items_full` view unchanged — stack membership queried separately.

## Navigation

Stack tabs appear as a new row above the existing status filter bar.

```
All  |  Salsa  |  Rap  |  Chill  |  [gear]
all  |  to-listen  |  listened  |  to-revisit
```

- "All" is always first and cannot be removed (shows everything, current default behavior)
- Status filters work within a selected stack (e.g. "Salsa -> to-listen")
- Gear button opens stack management panel
- Active tab gets accent blue fill

## Card Interaction

Each music card gets a "+ Stack" button in the actions area. Clicking it opens a dropdown:

- Checkboxes for each existing stack (checked = item is in that stack)
- Toggling a checkbox immediately writes to the database
- Text input at the bottom for inline creation of a new stack
- Dropdown closes on outside click

## Add Form

Stack assignment added inside the existing "More options" `<details>` section:

- Tag-style multi-select with removable chips
- "+ add" button opens same dropdown as the card
- Optional — if no stacks selected, item just exists in "All"
- No friction added to the quick "paste URL and Add" flow

## Stack Management

Gear button expands an inline panel below the stack tabs:

- Lists all stacks with item counts
- Rename: inline text input with confirm
- Delete: confirmation dialog, explains links are untagged not deleted
- Create: text input + button at the bottom

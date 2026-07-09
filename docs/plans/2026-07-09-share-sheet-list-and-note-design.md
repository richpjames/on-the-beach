# Share sheet: add a list + optional note

## Problem

The iOS Share Extension (`native/ShareExtension/ShareViewController.swift`) posts a
shared link straight to `POST /api/ingest/link` with only `{ url }`. There's no UI,
so you can't file the link into a list or attach a note at share time. We want to
choose a list (existing or new) and add an optional note before the item is created.

"Lists" in the UI are **stacks** in the code (`stacks` table, `musicItemStacks`
join). Stack names are `UNIQUE`.

## Approach

### Extension UI

Replace the custom spinner `UIViewController` with **`SLComposeServiceViewController`**
(Apple's standard share-compose sheet):

- The built-in text view is the **note** (optional, empty by default).
- A **`SLComposeSheetConfigurationItem`** row shows "List — None ▸". Tapping it pushes
  a `UITableViewController` listing existing lists (fetched from the server) plus a
  "New list…" row that prompts for a name. The chosen name shows back on the row.
- Cancel/Post buttons, the shared-URL preview, and keyboard handling come for free.
- Post with "None" behaves exactly like today.

The picker reads lists using the **bearer ingest key** the extension already holds
(session auth isn't available in an extension), via the new endpoint below.

### Server (`server/routes/ingest.ts`)

Both changes sit under the existing bearer auth.

1. **`GET /api/ingest/stacks`** — returns `[{ id, name }]` sorted by name, for the
   picker. Reads the `stacks` table only; no session/CSRF. Exists because the
   extension can't use the session-authed `GET /api/stacks`.

2. **Extend `POST /api/ingest/link`** with two optional fields alongside `url`:
   - `notes` (string) → passed through as a `CreateMusicItemInput` override (same as
     the email/photo ingest paths).
   - `listName` (string) → **resolve-or-create by name** (names are `UNIQUE`), then
     attach the created item via a `musicItemStacks` insert (`onConflictDoNothing`).

   Passing a *name* (not an id) collapses "pick existing" and "create new" into one
   path. List assignment stays in the route layer as a post-creation join insert —
   the `createMusicItemsFromUrl` pipeline is untouched.

   The response gains a `list: { id, name } | null` field so the extension can
   confirm "Added to Jazz finds."

## Edge decisions

- **Duplicate link** (`created: false`): still **attach to the list** (idempotent;
  re-sharing to file something is a real use), but **do not apply the note** (avoid
  clobbering an existing note).
- **List provided but item creation fails**: the list attach only runs after a
  successful insert, so no orphan handling is needed.

## Out of scope (YAGNI)

- Multiple lists per share (UI picks one; the app supports adding more later).
- Nested/parent list selection in the picker.
- Editing an existing item's note from the share sheet.

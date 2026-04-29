# UI Behaviour Reference

A flat catalogue of every interactive surface in the app, written for designers. No ordering implies importance — areas are grouped by where they appear on screen.

## Visual idiom

The whole product is themed as a retro desktop. Surfaces use Windows 95/98 chrome — title bars, bevelled borders, square corners, pixel-sharp edges, Winamp-style playlist blacks and electric blues, and mono display fonts for ratings, counters, and utility text. Dialogs render as draggable windows with stub `_ □ ✕` window-control buttons. Decorative window controls are non-interactive but visible.

## Routes and navigation

- `/` — main browsing view.
- `/s/:id/:name` — same view as `/` but with a stack pre-selected. The slug is generated from the stack name; the id is authoritative.
- `/r/:id` — release detail page (server-rendered, with backdrop artwork).
- Internal links are intercepted: clicking `/r/:id` swaps the main view out for the release view without a page reload, preserving any audio currently playing. Clicking the back arrow on a release page returns to the main view in the same way. Browser back/forward (popstate) works for both.
- Modifier-clicks (cmd/ctrl/shift/alt) and `target` links bypass the SPA router.
- A persistent `<audio>/<iframe>` player is mounted at the body level so playback survives navigations.
- An RSS `<link rel="alternate">` is injected per stack so feed readers can subscribe.

## Header

- App title "On The Beach" with subtitle "Music Tracking".
- Three decorative window-control buttons (`_`, `□`, `✕`) on the right. They are not focusable and have no behaviour.

## Add area

A horizontal form bar sits below the header. Its primary row contains:

- **URL / search field** — accepts a pasted link or free text. Placeholder: "search or paste a link".
- **Photo button** — opens the OS file picker (camera roll on mobile). Selecting an image triggers a cover scan.
- **Listen button** — captures up to 15 seconds of microphone audio for song recognition. Click again while recording to stop early. Disabled while a submit is in flight. While recording, the button shows a live countdown ("15s", "14s", …) and gains an `is-recording` state; while recognising, it gains `is-recognizing`.
- **Add button** — submits the form. Becomes "Adding..." and disables while in flight.

Submitting with no URL but a value in artist/title creates a manual entry. Submitting with empty URL **and** empty artist/title reveals the secondary fields and stays open.

The secondary row (hidden by default, revealed after the user submits with no link or after a scan completes) contains:

- Artist, Release (title), and a release-type select (`Release / EP / Single / Track / Mix`).
- A collapsible "Add more details" `<details>` block containing: Label, Year (1900–2099), Country, Genre, Artwork URL, Catalogue number, Notes (textarea).
- A stack picker that shows currently selected stacks as chips with a `×` remove button, plus a "+ Stack" button that opens a dropdown of existing stacks (with an inline "New stack..." input that creates and selects on Enter).

### Cover scan flow

After a Photo file is selected, the loading overlay appears with status "Scanning cover…". On success, the secondary fields open and Artist / Release / Artwork URL are populated; the "Add more details" details block expands automatically when the scan returned values. The user reviews and presses Add. On failure, an alert explains the error and the user can edit manually.

### Recognise flow

Pressing Listen requests microphone access. If denied, an alert appears. While recording, the countdown ticks down. After capture, status changes to "Identifying song…". A successful match auto-submits with status "to-listen", an album reference in Notes if the album differed from the track, and (when MusicBrainz can match) artwork. A miss surfaces "Song not recognised. Try again in a quieter environment."

### Ambiguous link picker

When a pasted link could resolve to several releases the server responds with candidates. A modal opens listing each candidate as a button with title, artist, item type badge, optional "primary" badge, and an evidence line. Behaviour:

- Each candidate toggles selection on click.
- "Select all" selects every candidate.
- "Add selected" creates one item per selected candidate (multi-select supported); disabled until at least one is picked.
- "Enter manually" pre-fills the secondary fields from the first selected candidate and focuses the Artist input.
- "Cancel", clicking the backdrop, or pressing Escape dismisses the modal.

### Add loading overlay

While submitting, scanning, or recognising, a centred dialog overlays the page with a Win9x title bar, an indeterminate progress bar, the current status line ("Adding to collection…", "Scanning cover…", "Identifying song…") and a "Please wait..." substatus. The overlay is non-dismissable; the disabled "Cancel" button is decorative.

## Stack bar

Below the add area is a horizontal bar of "stack" tabs (a stack = a named list/collection):

- The first tab is **All**, which clears the current stack filter.
- One tab per stack, each labelled with the stack name.
- Clicking a stack updates the URL to `/s/:id/:name` and filters the music list to that stack.
- Selecting any stack also resets the status filter to "All" (so the user sees the entire stack contents).
- A **gear** button opens the stack management panel.
- A **trash** button appears only when a stack is selected; clicking it confirms ("Delete \"X\"? Links won't be deleted, just untagged.") and deletes the stack from the server. Items remain.
- Below the bar (mobile only, viewport ≤ 520px) sits a custom horizontal scrollbar with `◀ ▶` buttons, a draggable thumb, and click-to-page on the track. The buttons auto-repeat while held.

If a search query is active, the stack bar collapses to only stacks whose name matches (plus the currently selected one).

### Stack manage panel

Toggled by the gear button. Inside:

- A list of every stack with its item count. Stacks that are nested under another stack get a small "nested" chip.
- Each row has a **rename** button (replaces the row with an inline input + Save) and a **delete** button (same confirmation as the trash icon).
- A "New stack name…" input plus a Create button at the bottom.
- The list filters by the global search query while the panel is open.

## Filter bar

Four tabs, mutually exclusive:

- **All** — all items.
- **To Listen** — items with status `to-listen` (default selection on load).
- **Listened** — items with status `listened`.
- **Scheduled** — items with a future reminder date set.

## Browse tools

To the right of the filter bar:

- A **search toggle** icon button. On larger viewports the search input is always visible; on small viewports the input lives in a panel that opens on toggle. Auto-focuses the input when opened.
- A **sort toggle** icon button that opens a sort panel.
- The **search input** (placeholder "Search releases or lists…") filters the music list and the stack bar live as the user types. A small `✕` clear button appears when the field has content.
- The **sort** select offers: Date added, Date listened (only available while the Listened filter is active; if selected and the filter changes away, it falls back to Date added), Artist A–Z, Release A–Z, Star rating.
- A **sort-direction** button toggles ascending/descending. Its label rewrites itself to suit the active sort: "↓ Newest first / ↑ Oldest first" for date sorts, "↓ Highest first / ↑ Lowest first" for ratings, "↑ A–Z / ↓ Z–A" for name sorts.
- Clicking outside the open panel, or pressing Escape, closes both panels.

## Music list

The list is a column of items. Three kinds of rows can appear interleaved:

- **Breadcrumbs** — when a stack is selected and forms a chain of nested parents, breadcrumb chips render at the top with `>` separators. Each ancestor is a button that jumps to that ancestor; the current crumb is non-interactive.
- **+ Add list** button — appears only when a stack is selected. Toggles a small picker of stacks not already nested under the current one. Clicking a candidate nests it; the picker closes on Escape or outside click. Adding a list that would create a cycle is rejected with an alert.
- **Folder rows** — child stacks of the current stack. Each folder row shows a folder icon, name, item count, a reorder grip, and a `×` remove-from-this-list button. Clicking the body of the folder row navigates into that stack.
- **Music cards** — see below.

The empty state shows context-aware copy: "No matches for "…"" when a search is active, "No music tracked yet. Paste a link above to get started!" for All when empty, "No scheduled items.", or `No items with status "X"` for status filters.

A custom vertical scrollbar sits along the right side of the list (mirroring the stack bar's horizontal one): `▲ ▼` repeat-scroll buttons, a draggable thumb, and click-to-page on the track. It hides itself when no overflow exists.

## Music card

Each card has three regions: artwork, content, actions.

- **Artwork** — square thumbnail. If the item has artwork it links to the release page and shows the image; otherwise a small placeholder favicon stands in.
- **Content** — title, artist (if known), and a row of stack chips for any stacks the item belongs to. Title and artist link to the release page.
- **Meta row** — a status select (`To Listen / Listened`), an interactive star rating, and a source badge ("Bandcamp", "Spotify", "YouTube", "SoundCloud", "Apple Music", "Mixcloud", "Discogs", "Tidal", "Deezer", "Physical"…) that links out to the source if a URL is known.
- **Actions row** —
  - A drag-grip (only used as the reorder handle on small viewports; the whole card is draggable on desktop).
  - An "open external link" icon (only when a primary URL exists).
  - A "manage stacks" icon, which opens an inline dropdown of all stacks with checkboxes and a "New stack…" input (Enter creates and assigns).
  - A "view release page" icon.
  - A "delete" icon (red ghost button) that confirms then removes.
  - A "more actions" `⋮` button that opens a small menu mirroring the icon row (Open link, Manage stacks, View release page, Delete). The menu closes on Escape or outside click. Only one menu may be open at a time.

### Status changes

Changing the status select on a card persists immediately. Switching from any status to "Listened" triggers a server lookup for "you may also like" using Cover Art Archive — if a suggestion is returned, the suggestion picker modal appears (centred, retro window) showing the suggested title, artist, optional artwork and year, with **Dismiss** and **Add to list** actions.

### Star rating

Five stars, supporting half-star resolution. Hovering shows a live preview based on which half of a star the pointer is over. Clicking commits the value (left half = .5, right half = whole). Clicking the same value again clears the rating (sets it to none). Keyboard-triggered clicks select the whole-star value. While saving, the control gains an `is-pending` state and disables. On error the previous value is restored and an alert shown.

### Reordering

- Cards and folder rows are draggable via `sortablejs` with a 160ms animation.
- On desktop the whole row is draggable; on small viewports (≤ 520px) reorder is restricted to the drag-grip handle so other controls stay tappable.
- Reorder is disabled when the list is locked: any active search query, or any sort other than "Date added descending". (Persisted order is per-context — the combination of filter + selected stack.)
- Drop applies a new order to the server. On failure the list re-renders from the server and an alert appears.

## Per-card stack dropdown

Opening "Manage stacks" inline above the actions row shows a checklist of every stack with the item's current memberships pre-checked. Toggling adds/removes membership immediately. Typing in the bottom "New stack…" field and pressing Enter creates a stack and assigns it. Closes on Escape or outside click; outside-click ignores the trigger button.

## Now-playing player

A floating Winamp/Win9x-style window that hosts an embedded player iframe (Bandcamp, Apple Music, YouTube). Behaviour:

- **Title bar** — shows artist — title (or just title if no artist). Drag the title bar to reposition; clicking the buttons doesn't start a drag.
- **`_` minimise** — hides the window; a taskbar entry stays available.
- **`✕` close** — stops playback and removes the iframe.
- **Body** — auto-shaped for the embed: video (YouTube) gets fullscreen permission and a wider layout; Apple Music gets its own variant.
- The window is hidden by default and only appears once "Listen"/"Watch" is pressed on a release page.

## Taskbar

Pinned to the bottom of release pages and the main view (where the player exists):

- A **🪟 Start** button (decorative).
- A **now-playing** task button — hidden until the player loads. Clicking it toggles the player window between visible and minimised. Shows the current track label.
- A **clock** showing local hours:minutes, refreshing every 10 seconds.

## Release page

Reached at `/r/:id`. Has two view modes (mutually exclusive) plus persistent assistance areas.

- **Backdrop** — when the release has artwork, a fixed full-bleed background renders behind the page.
- **Back arrow** (`◄`) returns to the main view.
- **Artwork** — large square art. If the source is YouTube, clicking the artwork opens the player.

### View mode

- Title, Artist, meta line (`Year · Label · Country · Genre`), Catalogue number, free-text Notes.
- Large star rating (half-star, hover preview, click-to-clear, same as the list).
- A **▶ Listen** / **▶ Watch** button — present when the primary source can embed (Bandcamp album, Apple Music, YouTube). Mixcloud renders a 60px iframe in place. On coarse-pointer devices (touch) the button opens the source URL in a new tab instead of loading the embed (some embeds do not work on mobile).
- A textual source link to the primary URL (when not Bandcamp).
- Secondary source links (extra URLs attached to the release) listed below.
- For releases whose primary source is not a known playable, the page does an Apple Music lookup and appends an "Apple Music" link if one is found.

### Edit mode

- Toggled by the **Edit** button. Hides view mode, hides the Edit/Delete buttons.
- Editable fields: Title, Artist, Year, Label, Country, Genre, Catalogue number, Notes, Artwork URL.
- A "Replace image" file picker uploads a new artwork; while uploading the button reads "Uploading…" and disables. On failure the previous URL is restored and an alert appears.
- A **Links** subsection lists every attached link (source name, URL, remove `×`). Adding a link uses a Source combobox (filters as the user types, suggestions from `/api/release/sources`) plus URL input plus Add. Failed adds surface the server error in an alert.
- **Save changes** persists and reloads. **Cancel** returns to view mode without reloading.

### Stacks (always visible)

- Chips of currently assigned stacks; each chip's `×` removes the assignment.
- A live-filtering checklist of every stack to add/remove memberships.
- A "New stack…" input. Pressing Enter creates a stack and immediately assigns it.

### Status (always visible)

- A `Status` select offering "To Listen" / "Listened". Persists on change.

### Reminder (always visible)

- A date input pre-filled with the saved reminder, or with `${item.year}-01-01` when no reminder is set, or empty.
- **Set reminder** persists; the button briefly reads "Saved!" with a `btn--saved` state, then reverts after 2 seconds.
- **Clear** removes the reminder (only present when one is currently set).

### Footer

- **Edit** / **Delete** buttons. Delete confirms ("Delete this release?") then returns to `/`.

## Modals and overlays — common rules

- Modals use a centred dialog inside a backdrop. Backdrop click, the explicit Cancel/Dismiss buttons, and Escape all dismiss them.
- Only one menu/dropdown is open at a time on the main view (opening another closes the previous; reordering closes any open menu/dropdown).
- The custom scrollbars (link picker list, music list, stack bar) all share the same idiom: ▲/▼ or ◀/▶ buttons that auto-repeat while held, click-to-page on the track, draggable thumb that ratios against the underlying scroll position. They self-hide when the underlying area has no overflow.

## Reminders integration

On startup the app polls for any items the cron has flipped back to "to-listen" because their reminder fired. Those items emit a `REMINDERS_READY` event but no UI is shown for them today — they simply re-appear in the To Listen filter.

## Mobile-specific behaviour

- Search and sort live behind icon-only toggle buttons that open compact panels.
- The stack bar shows its custom horizontal scrollbar to make overflowing tabs reachable on touch.
- Music-list reorder requires the drag-grip handle (whole-card drags would steal scroll).
- Listen/Watch buttons fall back to opening the source URL in a new tab on coarse-pointer devices instead of loading the embed.

## Asset / scrape integrations visible to the user

- Pasting a link can populate Artist, Title, Artwork via OG/JSON-LD/oEmbed scraping.
- Cover scan returns Artist, Title, Year, Label, Country, Catalogue number from a photo (Mistral OCR/vision).
- Microphone capture sends a 15-second clip for song recognition; a successful match auto-creates a "track"-typed item.
- MusicBrainz enrichment fills any blank metadata and attaches MusicBrainz ids; failures are silent.
- Cover Art Archive provides "you might also like" suggestions when an item flips to Listened.

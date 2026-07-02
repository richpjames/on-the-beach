# Frontend App Shell

## Boot flow

- The app is a SvelteKit application (Svelte 5, runes). `src/routes/+layout.svelte` renders the persistent chrome: header, footer, taskbar, and the now-playing player window.
- `src/routes/+page.svelte` and `src/routes/s/[id]/[name]/+page.svelte` render `$lib/components/MainPage.svelte`, seeded from their `+page.server.ts` load.
- `src/routes/r/[id]/+page.svelte` renders `$lib/components/ReleasePage.svelte`, keyed by item id so navigation between releases fully re-initialises the page state.
- `src/services/api-client.ts` remains the typed boundary to `/api/*` (shared via `$lib/api.ts`).

## Rendering model

- Pages are server-rendered by SvelteKit load functions and hydrate into interactive components.
- The persistent player lives in the root layout, so audio keeps playing across client-side navigation — no custom router or show/hide tricks are needed (`src/lib/player.svelte.ts` holds the playback state).
- Stack navigation on the main page uses SvelteKit shallow routing (`pushState`) so switching stacks updates the URL without a reload, exactly like the previous shell; back/forward is synced back into the app machine from `page.url`.

## Core components (`src/lib/components/`)

- `MainPage.svelte` — page coordinator: owns the app/add-form machines and list state.
- `AddForm.svelte` — add form, cover scan, and song recognition flows (driven by `add-form-machine`).
- `MusicList.svelte` / `MusicCard.svelte` / `FolderRow.svelte` — the playlist, drag reordering (sortablejs), folder rows, and breadcrumbs.
- `StackBar.svelte` / `StackManagePanel.svelte` / `StackDropdown.svelte` — stack tabs, management, and pickers.
- `BrowseControls.svelte` — filter bar, search, and sort panels.
- `LinkPickerModal.svelte` / `SuggestionPickerModal.svelte` / `AddLoadingOverlay.svelte` — modal surfaces.
- `PlayerWindow.svelte` / `Taskbar.svelte` — persistent chrome rendered by the layout.
- `VerticalScrollbar.svelte` / `HorizontalScrollbar.svelte` — the retro custom scrollbars.

The markup and class names intentionally match the previous string-template renderer so the retro stylesheet and visual-regression baselines carry over unchanged.

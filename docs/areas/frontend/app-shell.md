# Frontend App Shell

## Boot flow

- `src/main.ts` loads the frontend bundle.
- `src/app.ts` creates module-level actors, wires DOM events, and drives all interactive behavior.
- `src/services/api-client.ts` is the typed boundary to `/api/*`.

## Rendering model

- The app starts from server-rendered HTML provided by `server/routes/main-page.ts`.
- `src/app.ts` reads `#__initial_state__` for stack data when present.
- UI updates are done with targeted DOM rendering helpers instead of a component framework.

## Core responsibilities in `src/app.ts`

- add-form setup and scan handling
- filter, search, sort, and stack bar interactions
- drag reordering through `sortablejs`
- item menus, stack dropdowns, and custom scrollbars
- syncing visible UI with XState context versions

This keeps the app lightweight, but `src/app.ts` is the main coordination file and the first place to inspect when UI behaviors intersect.
